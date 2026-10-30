import { productAnalyticsHeaders, productAnalyticsMetadata, trackProduct, type AnalyticsFields } from '../lib/productAnalytics'
import { apiURL } from '../lib/apiBase'
import { observeSharePCMBytes } from '@simultrans/core/liveShareAudio'
import { sessionEndsAt } from '@simultrans/core/sessionLimits'
import { useEffect, useRef, useState } from 'react'
import { defaultAudioInputKey, getDefaultAudioInput } from '../defaultAudioInput'
import {
  createPCMStreamPlayer,
  createRecorder,
  pcmChunksToWav,
  pcm16HasSignal,
  type AudioProcessingDiagnostics,
  type BrowserAudioProcessingOptions,
  type PCMStreamPlayer,
  type PCMOutputChannel,
  type RecorderFactory,
  type RecorderHandle,
} from '../audio'
import { queueHistoryPCMChunk, type HistoryAudioArchive } from '../historyAudio'
import { createApiTraceContext, traceparentFor } from '../lib/apiFetch'
import type { VADLoudnessMode, VADLoudnessThresholdDbfs } from '../lib/audioProcessing'
import { consumerFetch, createConsumerSessionInvalidator } from '../lib/consumerSession'
import { decodeBase64, waitForOpen } from '../lib/realtimeSocket'
import type { ShowcaseSettledPlaybackStatus } from '../lib/showcaseRows'
import { finishPlaybackChunk, finishPlaybackInput, queuePlaybackChunk, type StreamedPlaybackSegments } from '../lib/streamedPlayback'
import { createVolcRTCMultilingualRuntime } from '../lib/volcRTCTransport'
import type { RealtimeService } from '../lib/config'
import {
  emptyVadTranscriptPairState,
  reduceVadTranscriptPairEvent,
  type VadTranscriptPair,
  type VadTranscriptPairState,
} from '../lib/vadTranscriptPairs'
import {
  applyOutputAudioStarts,
  nextTranslationSnapshot,
  reconcileStreamingTranslationSegments,
  upsertTimedSegment,
} from '../lib/transcript'
import type { HistoryEntry, ServerEvent, TimedTranscriptSegment } from '../types/history'
import { CONNECTION_TIMEOUT_MS, PROCESSING_TIMEOUT_MS, appendPCMArchiveChunk, type Status } from './useSessionRuntime'
import { createMultilingualMonitor } from './multilingualMonitor'

// ---------------------------------------------------------------------------
// Consumer 认证通道（竖屏 showcase 生产链路）。
// eval 模式保持原样（/admin 工作台等评测调用方裸连 /ws/translate）；
// consumer 模式先 POST /api/consumer/ws/session 预检拿 {sessionId, ticket}，
// start 帧带 ticket + eventSchemaVersion，与 iOS mobile/src/session/
// realtimeTransport.ts 的握手完全一致，录音期间按分钟计量额度。
// ---------------------------------------------------------------------------

/** A turn may only advance after its queued audio has drained. Always close
 * every old player, including one whose browser context could not resume. */
export async function releaseMultilingualPlayers(players: ReadonlyArray<Pick<PCMStreamPlayer, 'drain' | 'close'>>, drain: boolean): Promise<boolean> {
  const completed = await Promise.all(players.map(async player => {
    let ok = true
    if (drain) {
      try { await player.drain() } catch { ok = false }
    }
    try { await player.close() } catch { ok = false }
    return ok
  }))
  return completed.every(Boolean)
}

/** Stop the physical track before recorder shutdown can await browser work. */
export function releaseMultilingualRecorder(recorder: RecorderHandle | null | undefined): Promise<void> {
  try { recorder?.inputTrack?.stop() } catch { /* Still release the recorder graph. */ }
  try { return recorder?.stop().catch(() => undefined) ?? Promise.resolve() } catch { return Promise.resolve() }
}

export type MultilingualSessionMode = 'consumer' | 'eval' | 'guest'

/** Optional consumer privacy boundary. A lease must never revive after invalidation. */
export type MultilingualPrivacyGate = {
  ensureAuthorized: () => Promise<boolean>
  captureAuthorization: () => () => boolean
  subscribeInvalidated: (listener: () => void) => () => void
}

export const MULTILINGUAL_PRIVACY_STOPPED_MESSAGE = 'AI 数据授权已变化，已停止收音；已有内容已保留。'
export const MULTILINGUAL_PAGE_EXIT_MESSAGE = '已离开同传页面，本场会话已结束。请返回首页重新开始。'

/** One start attempt owns one lease, including all of its asynchronous device work. */
export function createMultilingualPrivacyFence(gate: MultilingualPrivacyGate | undefined, onInvalidated: () => void) {
  let live = true
  let lease: (() => boolean) | null = gate ? null : () => true
  const invalidate = () => {
    if (!live) return
    live = false
    onInvalidated()
  }
  const unsubscribe = gate?.subscribeInvalidated(invalidate)
  const allowed = () => {
    if (!live || !lease) return false
    try { if (lease()) return true } catch { /* Fail closed. */ }
    invalidate()
    return false
  }
  return {
    gate,
    allowed,
    invalidate,
    async authorize() {
      if (!live) return false
      if (gate) {
        let accepted = false
        let requestedLease: (() => boolean) | null = null
        // Bind the identity before awaiting a prompt. Even an already accepted
        // account's Promise(true) must not authorize a replacement login.
        try { requestedLease = gate.captureAuthorization(); accepted = await gate.ensureAuthorized() } catch { /* Fail closed. */ }
        if (!live || !accepted) return false
        lease = requestedLease
      }
      return allowed()
    },
    dispose() { live = false; unsubscribe?.() },
  }
}

export const CONSUMER_SESSION_EXPIRED_MESSAGE = '登录已过期，请重新登录'
export const CONSUMER_PREFLIGHT_FAILED_MESSAGE = '无法创建同传会话，请稍后重试。'
export const QUOTA_EXHAUSTED_MESSAGE = '今日免费额度已用完，将于明日 00:00（北京时间）自动恢复。'
/** 同账号已有补译在跑（后端 409 backfill_busy）：结束页以 toast 提示，不排队。 */
export const BACKFILL_BUSY_MESSAGE = '有任务正在翻译，请稍后再试'
const PAUSE_VAD_DRAIN_MS = 2_100
const PAUSE_VAD_CHUNK_MS = 100

export type ConsumerFetcher = (path: string, init?: RequestInit) => Promise<Response>

export type ConsumerWsPreflight = {
  sessionId: string
  provider: string
  ticket: string
  eventSchemaVersion: number
}

export type ConsumerPreflightResult =
  | { ok: true; session: ConsumerWsPreflight }
  | { ok: false; error: string; expired: boolean }

export function dispatchConsumerSessionExpired() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event('consumer:session-expired'))
  }
}

/**
 * 预检：向 /api/consumer/ws/session 换取受计量的 cs-* 会话与一次性握手票据。
 * consumerFetch 自带 Bearer + refresh 重试；这里仍收到 401 说明登录态确已
 * 失效——给出可显示错误并广播 'consumer:session-expired' 让门控弹回登录页。
 */
export type ConsumerSessionPurpose = { purpose: 'backfill'; replayOf: string }

export async function preflightConsumerWsSession(
  provider = '',
  fetcher: ConsumerFetcher = consumerFetch,
  purpose?: ConsumerSessionPurpose,
  analyticsFields?: AnalyticsFields,
  signal?: AbortSignal,
): Promise<ConsumerPreflightResult> {
  let response: Response
  try {
    response = await fetcher('/api/consumer/ws/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...productAnalyticsHeaders(analyticsFields) },
      body: JSON.stringify({ provider, ...(purpose ? { purpose: purpose.purpose, replayOf: purpose.replayOf } : {}) }),
      ...(signal ? { signal } : {}),
    })
  } catch {
    return { ok: false, expired: false, error: CONSUMER_PREFLIGHT_FAILED_MESSAGE }
  }
  if (signal?.aborted) return { ok: false, expired: false, error: CONSUMER_PREFLIGHT_FAILED_MESSAGE }
  if (response.status === 401) {
    dispatchConsumerSessionExpired()
    return { ok: false, expired: true, error: CONSUMER_SESSION_EXPIRED_MESSAGE }
  }
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { code?: unknown } | null
    if (response.status === 429 && error?.code === 'quota_exhausted') {
      return { ok: false, expired: false, error: QUOTA_EXHAUSTED_MESSAGE }
    }
    if (response.status === 409 && error?.code === 'backfill_busy') {
      return { ok: false, expired: false, error: BACKFILL_BUSY_MESSAGE }
    }
    return { ok: false, expired: false, error: CONSUMER_PREFLIGHT_FAILED_MESSAGE }
  }
  const json = await response.json().catch(() => null) as Partial<ConsumerWsPreflight> | null
  if (!json || typeof json.sessionId !== 'string' || !json.sessionId.trim()
    || typeof json.ticket !== 'string' || !json.ticket.trim()) {
    return { ok: false, expired: false, error: CONSUMER_PREFLIGHT_FAILED_MESSAGE }
  }
  const admittedProvider = typeof json.provider === 'string' ? json.provider.trim() : ''
  if (provider && admittedProvider !== provider) {
    return { ok: false, expired: false, error: CONSUMER_PREFLIGHT_FAILED_MESSAGE }
  }
  return {
    ok: true,
    session: {
      sessionId: json.sessionId,
      provider: admittedProvider,
      ticket: json.ticket,
      eventSchemaVersion: typeof json.eventSchemaVersion === 'number' ? json.eventSchemaVersion : 1,
    },
  }
}

export type MultilingualStartFrameOptions = {
  sessionLayout?: 'solo' | 'duo'
  sessionId: string
  provider: string
  sourceLanguage: string
  targetLanguages: string[]
  priorityLanguage?: string
  voiceClone: boolean
  voice: string
  deepFilterNet: boolean
  qwen3ModelIntervalMs: number
  qwen3SimulSystemPrompt?: string
  asrContext?: string
  asrContextOverride?: boolean
  vadLoudnessMode: VADLoudnessMode
  vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs
  requestId?: string
  traceparent?: string
  /** consumer 模式必带：服务端原子校验并消费，未带/失效即拒绝连接。 */
  ticket?: string
  eventSchemaVersion?: number
  transport?: 'websocket' | 'webrtc'
}

// TODO(protocol-03/n2)：本函数已下沉到 `@simultrans/core/startFrame`（移动端
// 够不着 ui-shared，两端各抄一份正是 start 帧漂移的根因，App 曾一次性缺
// qwen3ModelIntervalMs / asrContext / asrContextOverride / qwen3SimulSystemPrompt
// 四个字段）。这里暂未改成 re-export：`VADLoudnessMode` 等类型还在 ui-shared，
// 一起搬会牵动 Web 的多处调用点。搬迁时请连同下面的类型一并删除。
export function buildMultilingualStartFrame(options: MultilingualStartFrameOptions): Record<string, unknown> {
  return {
    type: 'start',
    mode: options.sessionLayout ?? 'solo',
    sessionId: options.sessionId,
    transport: options.transport || 'websocket',
    ...(options.ticket ? { ticket: options.ticket } : {}),
    requestId: options.requestId,
    traceparent: options.traceparent,
    eventSchemaVersion: options.eventSchemaVersion ?? 1,
    provider: options.provider,
    sourceLanguage: options.sourceLanguage,
    targetLanguages: options.targetLanguages,
    priorityLanguage: options.targetLanguages.includes(options.priorityLanguage || '') ? options.priorityLanguage : options.targetLanguages[0],
    voiceClone: options.voiceClone,
    voiceCloneFrequency: 'once',
    voice: options.voice,
    deepFilterNet: options.deepFilterNet,
    qwen3ModelIntervalMs: options.qwen3ModelIntervalMs,
    vadLoudnessThresholdDbfs: options.vadLoudnessThresholdDbfs,
    vadLoudnessMode: options.vadLoudnessMode,
    qwen3SimulSystemPrompt: options.qwen3SimulSystemPrompt,
    asrContext: options.asrContext,
    asrContextOverride: options.asrContextOverride,
    asrUseFilteredAudio: true,
  }
}

export type ConsumerQuota = {
  dailyMinutes: number
  remainingMinutes: number
  resetAt: string
  unlimited?: boolean
}

export async function fetchConsumerQuota(
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<ConsumerQuota | null> {
  try {
    const response = await fetcher('/api/consumer/quota')
    if (!response.ok) return null
    const json = await response.json().catch(() => null) as ConsumerQuota | null
    if (!json || typeof json.remainingMinutes !== 'number') return null
    return json
  } catch {
    return null
  }
}

export function consumerQuotaLabel(quota: ConsumerQuota | null): string {
  if (!quota) return ''
  return quota.unlimited ? '本地测试环境不限额度' : `今日剩余 ${Math.max(0, Math.floor(quota.remainingMinutes))} 分钟`
}

export type ConsumeQuotaMinuteResult = ConsumerQuota | 'quota_exhausted' | null

/**
 * 计量一分钟直播时长（与 iOS LiveScreen 相同节奏：录音期间每 60s 一次）。
 * 服务端按 (sessionId, minuteIndex) 幂等，可安全重试；429/quota_exhausted
 * 独立返回——调用方必须停止会话，不能像普通失败那样静默继续。
 */
export async function consumeConsumerQuotaMinute(
  sessionId: string,
  minuteIndex: number,
  fetcher: ConsumerFetcher = consumerFetch,
): Promise<ConsumeQuotaMinuteResult> {
  try {
    const response = await fetcher('/api/consumer/quota/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, minuteIndex }),
    })
    const json = await response.json().catch(() => null) as (ConsumerQuota & { code?: string }) | null
    if (!response.ok) {
      return response.status === 429 || json?.code === 'quota_exhausted' ? 'quota_exhausted' : null
    }
    return json
  } catch {
    return null
  }
}

export type MultilingualOutput = {
  /** Actual concatenated PCM bounds, keyed by TTS id (not UI sentence id). */
  audioRanges?: Record<string, { startMs: number; endMs: number }>
  targetLanguage: string
  translation: string
  modelOutputTranslation: string
  segments: TimedTranscriptSegment[]
  vadTranscriptPairs: VadTranscriptPair[]
  status: Status
  error: string
  ttsWarning: string
  audioBytes: number
  firstTextLatency: number | null
  firstStableTextLatency: number | null
  firstAudioByteLatency: number | null
  firstAudioPlaybackLatency: number | null
  engineModelFeedToFirstOutputMs: number | null
  engineModelFeedToStableTextMs: number | null
  engineModelFeedToTTSReadyMs: number | null
  recordingToModelSubmitMs: number | null
  ttsReadyToFirstPlaybackMs: number | null
  playingTranslationSegmentId: string | null
  /**
   * 已经念完（played）或被暂停丢弃、不会再念（skipped）的 TTS 段落。
   * 文字已到但不在这里、也不是 playingTranslationSegmentId 的段落即「未读」。
   */
  settledTranslationSegments: Record<string, ShowcaseSettledPlaybackStatus>
}

export type MultilingualRealtimeOptions = {
  /**
   * 'consumer'：生产竖屏体验——start 前经 /api/consumer/ws/session 预检并按分钟
   * 计量额度；'eval'（默认）：评测工作台裸通道，行为与历史版本完全一致。
   */
  mode?: MultilingualSessionMode
  /** Product Web pages own their foreground session; omitted by other hosts. */
  endOnPageExit?: boolean
  /** Explicit fetcher for isolated, metered guest credentials. */
  guestFetcher?: ConsumerFetcher
  sessionLayout?: 'solo' | 'duo'
  /** consumer 模式下每次额度扣减成功后的最新余量（用于「今日剩余 X 分钟」）。 */
  onQuota?: (quota: ConsumerQuota) => void
  /**
   * 结束页补译：用已保存的录音重跑同传补一种语言（docs/post-session-language-backfill-plan.md）。
   * 预检带 purpose/replayOf（不计费、不建独立记录、音频归档到原记录），本地不按分钟扣额度，
   * 也不把回放的 PCM 再记一遍进历史音频日志。音频由 recorderFactory（PCM 回放）提供。
   */
  backfill?: ConsumerSessionPurpose
  provider: string
  baseProviderId?: string
  transport?: 'websocket' | 'webrtc'
  service?: RealtimeService
  model: string
  sourceLanguage: string
  targetLanguages: string[]
  priorityLanguage?: string
  effectiveVoiceClone: boolean
  selectedVoice: string
  deepFilterNet: boolean
  qwen3ModelIntervalMs: 1000 | 2000
  qwen3SimulSystemPrompt?: string
  asrContext?: string
  asrContextOverride?: boolean
  vadLoudnessMode: VADLoudnessMode
  vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs
  ready: boolean
  notReadyReason: string
  inputDeviceId: string
  /** 采集链路：'system' = 手机通话模式（浏览器/系统 AEC·NS·AGC），默认 'raw'。 */
  inputProcessing?: 'raw' | 'system'
  recorderFactory?: RecorderFactory
  webRTCEchoCancellation?: boolean
  browserAudioProcessing?: BrowserAudioProcessingOptions
  outputDeviceId: string
  outputChannel?: PCMOutputChannel
  /** Optional explicit local headphone output, separate from the shared/main output. */
  monitorOutputDeviceId?: string | null
  monitorVolume?: number
  /** Local translated playback gain; callers that omit it retain full volume. */
  playbackVolume?: number
  mutedLanguages: Set<string>
  refreshAudioDevices: () => void
  onSessionRecorded: (entry: HistoryEntry, audio: HistoryAudioArchive) => void
  /** Omitted for existing Prod/eval callers. */
  privacyGate?: MultilingualPrivacyGate
}

export function allTargetTranslationsComplete(
  targetLanguages: readonly string[],
  completedLanguages: ReadonlySet<string>,
  outputs: Readonly<Record<string, { error: string } | undefined>>,
) {
  return targetLanguages.every((language) => (
    completedLanguages.has(language) || Boolean(outputs[language]?.error)
  ))
}

const emptyOutput = (targetLanguage: string): MultilingualOutput => ({
  targetLanguage,
  translation: '',
  modelOutputTranslation: '',
  segments: [],
  vadTranscriptPairs: [],
  status: 'idle',
  error: '',
  ttsWarning: '',
  audioBytes: 0,
  firstTextLatency: null,
  firstStableTextLatency: null,
  firstAudioByteLatency: null,
  firstAudioPlaybackLatency: null,
  engineModelFeedToFirstOutputMs: null,
  engineModelFeedToStableTextMs: null,
  engineModelFeedToTTSReadyMs: null,
  recordingToModelSubmitMs: null,
  ttsReadyToFirstPlaybackMs: null,
  playingTranslationSegmentId: null,
  settledTranslationSegments: {},
})

export function applyMultilingualMetrics(
  output: MultilingualOutput,
  event: ServerEvent,
  recordingStartedUnixMs: number,
) {
  const setMetric = (key: 'engineModelFeedToFirstOutputMs' | 'engineModelFeedToStableTextMs' | 'engineModelFeedToTTSReadyMs', value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) output[key] = value
  }
  setMetric('engineModelFeedToFirstOutputMs', event.engineModelFeedToFirstOutputMs)
  setMetric('engineModelFeedToStableTextMs', event.engineModelFeedToStableTextMs)
  setMetric('engineModelFeedToTTSReadyMs', event.engineModelFeedToTTSReadyMs)
  if (typeof event.engineFirstModelSubmitUnixUs === 'number' && recordingStartedUnixMs > 0) {
    const value = event.engineFirstModelSubmitUnixUs / 1000 - recordingStartedUnixMs
    if (Number.isFinite(value) && value >= 0) output.recordingToModelSubmitMs = value
  }
  if (typeof event.ttsError === 'string' && event.ttsError.trim()) output.ttsWarning = event.ttsError.trim()
}

export function multilingualSessionHasContent(
  sourceText: string,
  sourceSegments: TimedTranscriptSegment[],
  outputs: Record<string, MultilingualOutput>,
) {
  if (sourceText.trim() || sourceSegments.some((segment) => segment.text.trim())) return true
  return Object.values(outputs).some((output) => (
    output.translation.trim()
    || output.modelOutputTranslation.trim()
    || output.segments.some((segment) => segment.text.trim())
    || output.vadTranscriptPairs.some((pair) => pair.source.trim() || pair.translation.trim())
  ))
}

/**
 * 只有「用户没要求停止、且译文还没全部到齐」时，服务端关闭连接才算提前关闭。
 * 所有目标语言都已收到 translation_complete 后再关闭，只是收尾，不弹「提前关闭」。
 */
export function shouldReportMultilingualSocketClose(status: Status, stopRequested: boolean, allTranslationsComplete = false) {
  if (stopRequested || allTranslationsComplete) return false
  return status === 'connecting' || status === 'recording' || status === 'processing'
}

export function useMultilingualRealtimeSession(options: MultilingualRealtimeOptions) {
  const {
    provider, model, sourceLanguage, targetLanguages, effectiveVoiceClone, selectedVoice,
    deepFilterNet, qwen3ModelIntervalMs, vadLoudnessMode, vadLoudnessThresholdDbfs, ready, notReadyReason, inputDeviceId, recorderFactory,
    outputDeviceId, outputChannel = 'both', mutedLanguages, refreshAudioDevices, onSessionRecorded, onQuota, backfill, inputProcessing = 'raw',
    webRTCEchoCancellation = true,
    browserAudioProcessing,
    monitorOutputDeviceId = null,
    monitorVolume = 1,
    playbackVolume = 1,
  } = options
  const mode: MultilingualSessionMode = options.mode || 'eval'
  const endOnPageExit = options.endOnPageExit === true
  const service = options.service || (options.transport === 'webrtc' ? 'volc-rtc' : 'websocket')
  const transport = service === 'websocket' ? 'websocket' : 'webrtc'
  const backendProvider = options.baseProviderId?.trim() || provider
  const targetsKey = targetLanguages.join(',')
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [completionReason, setCompletionReason] = useState('')
  const completionReasonRef = useRef('')
  const [sourceText, setSourceText] = useState('')
  const [sourceSegments, setSourceSegments] = useState<TimedTranscriptSegment[]>([])
  const [outputs, setOutputs] = useState<Record<string, MultilingualOutput>>(() => Object.fromEntries(targetLanguages.map((language) => [language, emptyOutput(language)])))
  const [audioProcessingDiagnostics, setAudioProcessingDiagnostics] = useState<AudioProcessingDiagnostics | null>(null)
  const [paused, setPaused] = useState(false)
  const [voiceMode, setVoiceMode] = useState('')
  // 本场会话的预期结束时刻（Unix ms）：优先用服务端 session_started 帧下发的
  // 时限，收不到帧（老后端）时用 SESSION_TIME_LIMIT_MS + 本地开始时间兜底。
  // 页面据此在最后 10 秒提醒用户，见 @simultrans/core/sessionLimits。
  const [sessionEndsAtMs, setSessionEndsAtMs] = useState<number | null>(null)
  const sessionEndsAtMsRef = useRef<number | null>(null)
  const applySessionLimit = (startedAtMs: number, timeLimitMs?: number) => {
    const endsAt = sessionEndsAt({ startedAtMs, timeLimitMs })
    sessionEndsAtMsRef.current = endsAt
    setSessionEndsAtMs(endsAt)
  }
  const [inputDeviceSwitching, setInputDeviceSwitching] = useState(false)
  const [inputDeviceUnavailable, setInputDeviceUnavailable] = useState(false)
  const [inputTrack, setInputTrack] = useState<MediaStreamTrack | null>(null)
  const [outputDeviceSwitching, setOutputDeviceSwitching] = useState(false)
  const [monitorError, setMonitorError] = useState('')
  const [monitorDeviceSwitching, setMonitorDeviceSwitching] = useState(false)

  const statusRef = useRef<Status>('idle')
  const privacyGateRef = useRef(options.privacyGate)
  privacyGateRef.current = options.privacyGate
  const privacyRuntimeRef = useRef<{ fence: ReturnType<typeof createMultilingualPrivacyFence>; initialized: boolean } | null>(null)
  const privacyShutdownRef = useRef<() => void>(() => undefined)
  const privacyAllowed = () => {
    const attempt = privacyRuntimeRef.current
    if (!attempt) return true
    if (attempt.fence.gate !== privacyGateRef.current) attempt.fence.invalidate()
    return attempt.fence.allowed()
  }
  const socketRef = useRef<WebSocket | null>(null)
  const priorityLanguage = targetLanguages.includes(options.priorityLanguage || '') ? options.priorityLanguage! : targetLanguages[0] || ''
  const priorityLanguageRef = useRef(priorityLanguage)
  priorityLanguageRef.current = priorityLanguage
  useEffect(() => {
    const socket = socketRef.current
    // The start frame uses the latest ref even when selection changes during setup.
    if (privacyAllowed() && socket?.readyState === WebSocket.OPEN && (status === 'recording' || status === 'processing')) {
      socket.send(JSON.stringify({ type: 'set_priority_language', priorityLanguage }))
    }
  }, [priorityLanguage, status])
  const recorderRef = useRef<RecorderHandle | null>(null)
  const activeRecorderFactoryRef = useRef<((onPCM: (pcm: ArrayBuffer) => void, inputDeviceId?: string) => Promise<RecorderHandle>) | null>(null)
  const playersRef = useRef(new Map<string, PCMStreamPlayer>())
  const drainingPlayersRef = useRef(new Set<PCMStreamPlayer>())
  const sourceTextRef = useRef('')
  const sourceSegmentsRef = useRef<TimedTranscriptSegment[]>([])
  const sourceVadStartsRef = useRef(new Map<string, number>())
  const outputVadStatesRef = useRef(new Map<string, VadTranscriptPairState>())
  const outputsRef = useRef<Record<string, MultilingualOutput>>({})
  const outputChunksRef = useRef(new Map<string, Uint8Array[]>())
  const outputBytesRef = useRef(new Map<string, number>())
  const outputSampleRatesRef = useRef(new Map<string, number>())
  const outputAudioStartBySegmentRef = useRef(new Map<string, Map<string, number>>())
  const outputAudioEndBySegmentRef = useRef(new Map<string, Map<string, number>>())
  const playbackSegmentsRef = useRef(new Map<string, StreamedPlaybackSegments>())
  const playbackTokenRef = useRef(0)
  const activePlaybackRef = useRef(new Map<string, { token: number; segmentId: string | null }>())
  const inputChunksRef = useRef<Uint8Array[]>([])
  const inputBytesRef = useRef(0)
  const startedAtRef = useRef(0)
  const recordingStartedUnixMsRef = useRef(0)
  const engineFirstTTSReadyUnixMsRef = useRef(new Map<string, number>())
  const parentSessionIDRef = useRef('')
  const traceRef = useRef(createApiTraceContext())
  const finishingRef = useRef(false)
  const drainingTurnRef = useRef(false)
  const finishWaitersRef = useRef(new Set<(completed: boolean) => void>())
  const pausedRef = useRef(false)
  const playbackSuppressedRef = useRef(false)
  const completionTimerRef = useRef<number | null>(null)
  const translationCompleteRef = useRef(new Set<string>())
  const sessionGenerationRef = useRef(0)
  const startAbortRef = useRef<AbortController | null>(null)
  const captureAbortRef = useRef<AbortController | null>(null)
  const stopRequestedRef = useRef(false)
  const mutedLanguagesRef = useRef(mutedLanguages)
  const playbackVolumeRef = useRef(playbackVolume)
  playbackVolumeRef.current = playbackVolume
  const onSessionRecordedRef = useRef(onSessionRecorded)
  const onQuotaRef = useRef(onQuota)
  const quotaMinuteIndexRef = useRef(0)
  const recorderGenerationRef = useRef(0)
  const consumePCMRef = useRef<(pcm: ArrayBuffer) => void>(() => undefined)
  const inputDeviceSwitchingRef = useRef(false)
  const outputDeviceSwitchingRef = useRef(false)
  const analyticsScopeRef = useRef<AnalyticsFields>({})
  const analyticsEvent = (name: 'session_error' | 'session_paused' | 'session_resumed', fields: AnalyticsFields = {}) => {
    const scope = analyticsScopeRef.current
    if (mode !== 'consumer' || backfill || !scope.attemptId) return
    trackProduct(name, { ...scope, sessionId: parentSessionIDRef.current, traceId: traceRef.current.traceId, ...fields }, name === 'session_error' ? `${scope.attemptId}:${name}:${fields.reason || 'unknown'}` : undefined)
  }
  const mountedRef = useRef(true)
  // Returning to the foreground allows a new explicit start, never a previous
  // asynchronous start continuation that belongs to an older page generation.
  const pageExitedRef = useRef(false)
  const pageGenerationRef = useRef(0)
  const capturePageLease = () => {
    const generation = pageGenerationRef.current
    return () => mountedRef.current && generation === pageGenerationRef.current && !pageExitedRef.current
      && (!endOnPageExit || typeof document === 'undefined' || document.visibilityState !== 'hidden')
  }
  const monitorRef = useRef<ReturnType<typeof createMultilingualMonitor> | null>(null)
  if (!monitorRef.current) {
    monitorRef.current = createMultilingualMonitor(({ error: nextError, switching }) => {
      if (!mountedRef.current) return
      setMonitorError(nextError)
      setMonitorDeviceSwitching(switching)
    }, monitorOutputDeviceId, monitorVolume, service === 'websocket')
  }
  const monitor = monitorRef.current

  mutedLanguagesRef.current = mutedLanguages
  onSessionRecordedRef.current = onSessionRecorded
  onQuotaRef.current = onQuota

  const publishOutputs = () => setOutputs({ ...outputsRef.current })
  const setRuntimeStatus = (next: Status) => {
    statusRef.current = next
    setStatus(next)
  }
  const setPausedState = (next: boolean) => {
    pausedRef.current = next
    setPaused(next)
  }
  // 先到先得：暂停时标成 skipped 的段落，之后即使补播完也保持灰色。
  const settleTranslationSegment = (
    targetLanguage: string,
    segmentId: string,
    status: ShowcaseSettledPlaybackStatus,
  ) => {
    const output = outputsRef.current[targetLanguage]
    if (!output || output.settledTranslationSegments[segmentId]) return false
    output.settledTranslationSegments = { ...output.settledTranslationSegments, [segmentId]: status }
    return true
  }
  // 暂停会丢掉所有排队中和正在念的音频，这些段落不会再被念到。
  const skipQueuedPlayback = () => {
    let changed = false
    for (const [targetLanguage, segments] of playbackSegmentsRef.current) {
      for (const segmentId of segments.keys()) {
        if (settleTranslationSegment(targetLanguage, segmentId, 'skipped')) changed = true
      }
    }
    for (const [targetLanguage, active] of activePlaybackRef.current) {
      if (active.segmentId && settleTranslationSegment(targetLanguage, active.segmentId, 'skipped')) changed = true
    }
    if (changed) publishOutputs()
  }
  const clearPlaybackHighlights = () => {
    playbackSegmentsRef.current.clear()
    activePlaybackRef.current.clear()
    let changed = false
    for (const output of Object.values(outputsRef.current)) {
      if (!output.playingTranslationSegmentId) continue
      output.playingTranslationSegmentId = null
      changed = true
    }
    if (changed) publishOutputs()
  }
  const isCurrentSession = (generation: number, socket?: WebSocket | null) => (
    mountedRef.current
    && sessionGenerationRef.current === generation
    && (!socket || socketRef.current === socket)
  )

  useEffect(() => {
    for (const [language, player] of playersRef.current) {
      player.setMuted(playbackSuppressedRef.current || mutedLanguages.has(language))
    }
  }, [mutedLanguages])

  useEffect(() => {
    for (const player of [...playersRef.current.values(), ...drainingPlayersRef.current]) player.setVolume?.(playbackVolume)
  }, [playbackVolume])

  useEffect(() => {
    monitor.setSupported(service === 'websocket')
  }, [monitor, service])

  useEffect(() => {
    void monitor.configure(monitorOutputDeviceId)
  }, [monitor, monitorOutputDeviceId])

  useEffect(() => {
    monitor.setVolume(monitorVolume)
  }, [monitor, monitorVolume])

  useEffect(() => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'finished' && statusRef.current !== 'error') return
    const next = Object.fromEntries(targetLanguages.map((language) => [language, outputsRef.current[language] ?? emptyOutput(language)]))
    outputsRef.current = next
    setOutputs({ ...next })
  }, [targetsKey])

  useEffect(() => {
    mountedRef.current = true
    const release = () => {
      // Fence PCM, late device promises and socket callbacks before touching
      // resources. Browser pagehide/lock handlers cannot wait for async cleanup.
      sessionGenerationRef.current += 1
      recorderGenerationRef.current += 1
      inputDeviceSwitchingRef.current = false
      outputDeviceSwitchingRef.current = false
      consumePCMRef.current = () => undefined
      stopRequestedRef.current = true
      playbackSuppressedRef.current = true
      drainingTurnRef.current = false
      privacyRuntimeRef.current?.fence.dispose()
      finishWaitersRef.current.forEach(resolve => resolve(false))
      finishWaitersRef.current.clear()
      monitor.setPlayers([])
      startAbortRef.current?.abort()
      startAbortRef.current = null
      captureAbortRef.current?.abort()
      captureAbortRef.current = null
      if (completionTimerRef.current !== null) {
        window.clearTimeout(completionTimerRef.current)
        completionTimerRef.current = null
      }
      const recorder = recorderRef.current
      recorderRef.current = null
      // Recorder.stop may first await a worklet acknowledgement. End the real
      // MediaStreamTrack synchronously, before that promise can freeze.
      void releaseMultilingualRecorder(recorder)
      activeRecorderFactoryRef.current = null
      const socket = socketRef.current
      socketRef.current = null
      try { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' })) } catch { /* Closing still terminates this owner. */ }
      try { socket?.close() } catch { /* Browser is already tearing down. */ }
      const players = new Set([...playersRef.current.values(), ...drainingPlayersRef.current])
      playersRef.current.clear()
      drainingPlayersRef.current.clear()
      for (const player of players) {
        try { player.setMuted(true) } catch { /* Still close the audio context. */ }
        try { void player.close().catch(() => undefined) } catch { /* One broken output cannot retain the others. */ }
      }
      playbackSegmentsRef.current.clear()
      activePlaybackRef.current.clear()
    }
    const exit = () => {
      if (pageExitedRef.current) return
      pageExitedRef.current = true
      pageGenerationRef.current += 1
      const active = statusRef.current === 'connecting' || statusRef.current === 'recording' || statusRef.current === 'processing'
      release()
      setInputTrack(null)
      setPausedState(false)
      setInputDeviceSwitching(false)
      setOutputDeviceSwitching(false)
      if (active) {
        setError(MULTILINGUAL_PAGE_EXIT_MESSAGE)
        setRuntimeStatus('error')
      }
    }
    const visible = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') pageExitedRef.current = false
    }
    const visibility = () => { if (document.visibilityState === 'hidden') exit(); else visible() }
    if (endOnPageExit) {
      window.addEventListener('pagehide', exit)
      window.addEventListener('pageshow', visible)
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility)
    }
    return () => {
      window.removeEventListener('pagehide', exit)
      window.removeEventListener('pageshow', visible)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility)
      mountedRef.current = false
      pageGenerationRef.current += 1
      release()
    }
  }, [endOnPageExit])

  const reset = () => {
    setError('')
    setCompletionReason('')
    completionReasonRef.current = ''
    setVoiceMode('')
    sourceTextRef.current = ''
    sourceSegmentsRef.current = []
    sourceVadStartsRef.current = new Map()
    outputVadStatesRef.current = new Map(targetLanguages.map((language) => [language, emptyVadTranscriptPairState()]))
    setSourceText('')
    setSourceSegments([])
    outputsRef.current = Object.fromEntries(targetLanguages.map((language) => [language, { ...emptyOutput(language), status: 'connecting' }]))
    setOutputs({ ...outputsRef.current })
    outputChunksRef.current = new Map(targetLanguages.map((language) => [language, []]))
    outputBytesRef.current = new Map(targetLanguages.map((language) => [language, 0]))
    outputSampleRatesRef.current = new Map(targetLanguages.map((language) => [language, 24000]))
    outputAudioStartBySegmentRef.current = new Map(targetLanguages.map((language) => [language, new Map()]))
    outputAudioEndBySegmentRef.current = new Map(targetLanguages.map((language) => [language, new Map()]))
    playbackSegmentsRef.current = new Map(targetLanguages.map((language) => [language, new Map()]))
    playbackTokenRef.current = 0
    activePlaybackRef.current.clear()
    inputChunksRef.current = []
    inputBytesRef.current = 0
    startedAtRef.current = 0
    recordingStartedUnixMsRef.current = 0
    sessionEndsAtMsRef.current = null
    setSessionEndsAtMs(null)
    engineFirstTTSReadyUnixMsRef.current = new Map()
    finishingRef.current = false
    drainingTurnRef.current = false
    stopRequestedRef.current = false
    translationCompleteRef.current.clear()
    playbackSuppressedRef.current = false
    setPausedState(false)
    for (const player of drainingPlayersRef.current) void player.close().catch(() => undefined)
    drainingPlayersRef.current.clear()
  }

  const closePlayers = async (drain = true, players = [...playersRef.current.values()]) => {
    for (const [language, player] of playersRef.current) {
      if (players.includes(player)) playersRef.current.delete(language)
    }
    // Keep the optional branch attached only if a caller explicitly requests
    // queue draining. Session completion uses immediate release below.
    if (!drain) monitor.setPlayers([...playersRef.current.values()])
    players.forEach((player) => drainingPlayersRef.current.add(player))
    try {
      return await releaseMultilingualPlayers(players, drain)
    } finally {
      players.forEach((player) => drainingPlayersRef.current.delete(player))
      monitor.setPlayers([...playersRef.current.values()])
    }
  }

  const closePlayersAfterNextPaint = () => {
    const generation = sessionGenerationRef.current
    const players = [...playersRef.current.values()]
    for (const player of players) player.setMuted(true)
    monitor.setPlayers([])
    const close = () => { if (isCurrentSession(generation)) void closePlayers(false, players) }
    if (typeof window.requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      window.requestAnimationFrame(() => window.setTimeout(close, 0))
      return
    }
    window.setTimeout(close, 0)
  }

  const createRuntime = async (runtimeInputDeviceId: string, runtimeOutputDeviceId: string, captureAuthorized = privacyRuntimeRef.current?.fence.allowed, signal = captureAbortRef.current?.signal) => {
    if (service === 'volc-rtc') {
      if (outputChannel !== 'both') throw new Error('左右声道输出暂仅支持 WebSocket 服务线路。')
      return createVolcRTCMultilingualRuntime({
        provider,
        targetLanguages,
        inputDeviceId: runtimeInputDeviceId,
        outputDeviceId: runtimeOutputDeviceId,
        echoCancellation: webRTCEchoCancellation,
        browserAudioProcessing,
        // Retain this attempt's lease, never a getter for a later start's lease.
        isCaptureAuthorized: captureAuthorized,
      })
    }
    if (service !== 'websocket') throw new Error('多语同传当前仅支持 WebSocket 或火山 WebRTC。')
    const playerSetups = await Promise.allSettled(targetLanguages.map(async (targetLanguage) => [
      targetLanguage,
      await createPCMStreamPlayer(runtimeOutputDeviceId, outputChannel),
    ] as const))
    const failedSetup = playerSetups.find((result) => result.status === 'rejected')
    if (failedSetup?.status === 'rejected') {
      await Promise.all(playerSetups.flatMap((result) => (
        result.status === 'fulfilled' ? [result.value[1].close().catch(() => undefined)] : []
      )))
      throw failedSetup.reason
    }
    const players = new Map(playerSetups.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    }))
    return {
      players,
      createRecorder: (onPCM: (pcm: ArrayBuffer) => void, nextInputDeviceId = runtimeInputDeviceId) => (
        recorderFactory ? recorderFactory(onPCM) : createRecorder(onPCM, nextInputDeviceId, { processing: inputProcessing, browserAudioProcessing, signal })
      ),
    }
  }

  const recordHistory = () => {
    if (!parentSessionIDRef.current) return
    const createdAt = new Date().toISOString()
    const durationMs = startedAtRef.current > 0 ? Math.max(0, performance.now() - startedAtRef.current) : null
    const input = inputChunksRef.current.length > 0 ? pcmChunksToWav(inputChunksRef.current, 16000) : undefined
    const archivedOutputs: Record<string, Blob> = {}
    const multilingualOutputs = targetLanguages.map((targetLanguage) => {
      const output = outputsRef.current[targetLanguage]
      const chunks = outputChunksRef.current.get(targetLanguage) || []
      const outputAudio = chunks.length > 0
        ? pcmChunksToWav(chunks, outputSampleRatesRef.current.get(targetLanguage) || 24000)
        : undefined
      if (outputAudio) archivedOutputs[targetLanguage] = outputAudio
      return {
        targetLanguage,
        translationText: output?.translation || output?.modelOutputTranslation || '',
        translationSegments: [...(output?.segments || [])],
        firstTextLatency: output?.firstTextLatency ?? null,
        browserCaptureToFirstStableSentenceMs: output?.firstStableTextLatency ?? null,
        firstAudioByteLatency: output?.firstAudioByteLatency ?? null,
        firstAudioPlaybackLatency: output?.firstAudioPlaybackLatency ?? null,
        engineModelFeedToFirstOutputMs: output?.engineModelFeedToFirstOutputMs ?? null,
        engineModelFeedToStableTextMs: output?.engineModelFeedToStableTextMs ?? null,
        engineModelFeedToTTSReadyMs: output?.engineModelFeedToTTSReadyMs ?? null,
        recordingToModelSubmitMs: output?.recordingToModelSubmitMs ?? null,
        ttsReadyToFirstPlaybackMs: output?.ttsReadyToFirstPlaybackMs ?? null,
        outputAudioAvailable: Boolean(outputAudio),
        ttsError: output?.ttsWarning || undefined,
        outcome: output?.error || output?.ttsWarning ? 'error' as const : 'completed' as const,
        errorCategory: output?.error ? 'service_error' : output?.ttsWarning ? 'tts_error' : undefined,
        errorReason: output?.error || output?.ttsWarning || undefined,
      }
    })
    const failedOutput = multilingualOutputs.find((output) => output.outcome === 'error')
    const entry: HistoryEntry = {
      schemaVersion: 4,
      recordType: 'realtime',
      sessionMode: 'multilingual',
      multilingualSessionId: parentSessionIDRef.current,
      multilingualTargetLanguages: [...targetLanguages],
      multilingualOutputs,
      id: parentSessionIDRef.current,
      createdAt,
      provider,
      transport,
      model,
      sourceLanguage,
      targetLanguage: targetLanguages[0] || '',
      sourceText: sourceTextRef.current,
      translationText: '',
      sourceSegments: [...sourceSegmentsRef.current],
      translationSegments: [],
      observability: { ...traceRef.current, sessionId: parentSessionIDRef.current },
      inputAudioAvailable: Boolean(input),
      outputAudioAvailable: false,
      firstTextLatency: null,
      firstAudioByteLatency: null,
      firstAudioPlaybackLatency: null,
      outcome: failedOutput ? 'error' : 'completed',
      errorCategory: failedOutput?.errorCategory,
      errorReason: failedOutput?.errorReason,
      disconnectCount: 0,
      reconnectAttempts: 0,
      maxOutputGapMs: null,
      noOutputTimeouts: 0,
      sessionDurationMs: durationMs,
      trace: {},
    }
    onSessionRecordedRef.current(entry, { input, outputs: archivedOutputs })
  }

  const finish = async ({ serverFinalizationContinues = false } = {}) => {
    if (finishingRef.current) return
    const generation = sessionGenerationRef.current
    finishingRef.current = true
    privacyRuntimeRef.current?.fence.dispose()
    if (completionTimerRef.current !== null) {
      window.clearTimeout(completionTimerRef.current)
      completionTimerRef.current = null
    }
    const recorder = recorderRef.current
    recorderRef.current = null
    setInputTrack(null)
    recorderGenerationRef.current += 1
    consumePCMRef.current = () => undefined
    const socket = socketRef.current
    socketRef.current = null
    socket?.close()
    // `state: finished` is ordered after the final audio event, so every PCM
    // chunk needed by history is already archived here. Stop any remaining
    // audible tail immediately; history playback uses the independent archive.
    const drainingTurn = drainingTurnRef.current
    const releasePlayers = closePlayers(drainingTurn)
    const playbackDrained = drainingTurn ? await releasePlayers : true
    await recorder?.stop().catch(() => undefined)
    // A replaced login can unmount this hook while native capture is stopping.
    // Its continuation must not read, close or publish a newer session's refs.
    if (!isCurrentSession(generation)) return
    setPausedState(false)
    playbackSegmentsRef.current.clear()
    activePlaybackRef.current.clear()
    const hasContent = multilingualSessionHasContent(
      sourceTextRef.current,
      sourceSegmentsRef.current,
      outputsRef.current,
    )
    for (const output of Object.values(outputsRef.current)) {
      output.playingTranslationSegmentId = null
      output.status = output.error ? 'error' : 'finished'
      const hasText = Boolean((output.translation || output.modelOutputTranslation).trim())
      if (!serverFinalizationContinues && hasText && output.audioBytes === 0 && !output.ttsWarning) {
        output.ttsWarning = '本语言已生成译文，但没有收到 TTS 音频。请改用多语并发支持的预设音色模型后重试。'
      }
    }
    publishOutputs()
    // Consumer completion must retain its ended view and captured audio even
    // when ASR produced no text. Audio availability is decided from the WAV,
    // never inferred from recognition success. Keep the eval reset unchanged.
    const retainConsumerCompletion = mode === 'consumer' && parentSessionIDRef.current
      && (stopRequestedRef.current || startedAtRef.current > 0)
    if (!retainConsumerCompletion && !hasContent && !Object.values(outputsRef.current).some((output) => output.error)) {
      parentSessionIDRef.current = ''
      sourceTextRef.current = ''
      sourceSegmentsRef.current = []
      setSourceText('')
      setSourceSegments([])
      outputsRef.current = Object.fromEntries(targetLanguages.map((language) => [language, emptyOutput(language)]))
      setOutputs({ ...outputsRef.current })
      setAudioProcessingDiagnostics(null)
      setRuntimeStatus('idle')
      finishWaitersRef.current.forEach(resolve => resolve(true))
      finishWaitersRef.current.clear()
      return
    }
    recordHistory()
    if (!playbackDrained) setError('上一轮译音未能完整播放，已有字幕和音频已保留；请检查播放设备后重试。')
    setRuntimeStatus(!playbackDrained || Object.values(outputsRef.current).some((output) => output.error) ? 'error' : 'finished')
    finishWaitersRef.current.forEach(resolve => resolve(playbackDrained && !Object.values(outputsRef.current).some(output => output.error)))
    finishWaitersRef.current.clear()
  }

  const armCompletionTimer = () => {
    if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current)
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = null
      for (const output of Object.values(outputsRef.current)) {
        if (output.status === 'processing') {
          output.status = 'error'
          output.error = `模型连续 ${PROCESSING_TIMEOUT_MS / 1000} 秒没有新的收尾结果，已结束等待。`
        }
      }
      publishOutputs()
      void finish()
    }, PROCESSING_TIMEOUT_MS)
  }

  const handleEvent = (event: ServerEvent) => {
    // 会话时限：服务端在任何业务事件之前下发一次，页面据此做最后 10 秒提醒。
    if (event.type === 'session_started') {
      applySessionLimit(
        typeof event.startedAtMs === 'number' && event.startedAtMs > 0 ? event.startedAtMs : Date.now(),
        event.timeLimitMs,
      )
      return
    }
    if (event.type === 'session_ending' && event.reason === 'session_time_limit') {
      completionReasonRef.current = event.reason
      setCompletionReason(event.reason)
      void stop()
      return
    }
    if (statusRef.current === 'processing') armCompletionTimer()
    const targetLanguage = event.targetLanguage || targetLanguages[0]
    const output = outputsRef.current[targetLanguage]
    if (!output) return
    const currentVadState = outputVadStatesRef.current.get(targetLanguage) || emptyVadTranscriptPairState()
    const nextVadState = reduceVadTranscriptPairEvent(currentVadState, event)
    if (nextVadState !== currentVadState) {
      outputVadStatesRef.current.set(targetLanguage, nextVadState)
      output.vadTranscriptPairs = nextVadState.pairs
      publishOutputs()
    }
    const receivedAtMs = startedAtRef.current > 0 ? Math.max(0, performance.now() - startedAtRef.current) : undefined
    const sourceKey = event.utteranceId?.trim()
      || (typeof event.speechEpoch === 'number' && event.speechEpoch > 0 ? `vad-${event.speechEpoch}` : '')
    if (
      sourceKey
      && typeof event.startMs === 'number'
      && Number.isFinite(event.startMs)
      && event.startMs >= 0
      && ((event.type === 'source_vad_state' && event.state === 'speech_start') || event.type === 'source_vad_segment')
    ) {
      sourceVadStartsRef.current.set(sourceKey, Math.min(sourceVadStartsRef.current.get(sourceKey) ?? event.startMs, event.startMs))
    }
    const metricLanguages = event.type === 'session_metrics' && !event.targetLanguage
      ? targetLanguages
      : [targetLanguage]
    for (const language of metricLanguages) {
      const metricOutput = outputsRef.current[language]
      if (!metricOutput) continue
      applyMultilingualMetrics(metricOutput, event, recordingStartedUnixMsRef.current)
      if (typeof event.engineFirstTTSReadyUnixUs === 'number' && Number.isFinite(event.engineFirstTTSReadyUnixUs)) {
        engineFirstTTSReadyUnixMsRef.current.set(language, event.engineFirstTTSReadyUnixUs / 1000)
      }
    }
    if (targetLanguage === targetLanguages[0] && (event.type === 'source_delta' || event.type === 'source_update' || event.type === 'source_done') && event.text) {
      sourceTextRef.current = event.type === 'source_delta' ? sourceTextRef.current + event.text : event.text
      const nextSegments = upsertTimedSegment(
        sourceSegmentsRef.current,
        event,
        receivedAtMs,
        provider,
        sourceKey ? sourceVadStartsRef.current.get(sourceKey) : undefined,
      )
      sourceSegmentsRef.current = nextSegments
      setSourceText(sourceTextRef.current)
      setSourceSegments([...nextSegments])
    }
    if (event.type === 'model_output' && event.text) {
      if (output.firstTextLatency === null && receivedAtMs !== undefined) output.firstTextLatency = receivedAtMs
      output.modelOutputTranslation = event.text
      if (event.modelOutputAuthoritative) {
        output.translation = event.text
        output.segments = applyOutputAudioStarts(reconcileStreamingTranslationSegments(
          output.segments, event.text, receivedAtMs,
          `${parentSessionIDRef.current}:${targetLanguage}:translation`,
        ), outputAudioStartBySegmentRef.current.get(targetLanguage) || new Map(), outputAudioEndBySegmentRef.current.get(targetLanguage) || new Map())
      }
      publishOutputs()
    }
    if ((event.type === 'translation_delta' || event.type === 'translation_update' || event.type === 'translation_done') && event.text) {
      if (output.firstTextLatency === null && receivedAtMs !== undefined) output.firstTextLatency = receivedAtMs
      if (event.type === 'translation_done' && output.firstStableTextLatency === null && receivedAtMs !== undefined) {
        output.firstStableTextLatency = receivedAtMs
      }
      output.translation = nextTranslationSnapshot(output.translation, event, true)
      output.segments = applyOutputAudioStarts(reconcileStreamingTranslationSegments(
        output.segments,
        output.translation,
        receivedAtMs,
        `${parentSessionIDRef.current}:${targetLanguage}:translation`,
        event.segmentId,
        event.segmentText,
        event.startMs,
        event.endMs,
      ), outputAudioStartBySegmentRef.current.get(targetLanguage) || new Map(), outputAudioEndBySegmentRef.current.get(targetLanguage) || new Map())
      publishOutputs()
    }
    if (event.type === 'audio_config' && event.sampleRate) {
      outputSampleRatesRef.current.set(targetLanguage, event.sampleRate)
    }
    if (event.type === 'audio' && event.audio) {
      const audioReceivedAt = performance.now()
      const chunk = decodeBase64(event.audio)
      const chunkHasSignal = pcm16HasSignal(chunk)
      const sampleRate = outputSampleRatesRef.current.get(targetLanguage) || 24000
      if (mode === 'consumer') observeSharePCMBytes(parentSessionIDRef.current, `output-${targetLanguage}`, chunk, sampleRate)
      const segmentId = event.segmentId?.trim()
      if (segmentId) {
        const starts = outputAudioStartBySegmentRef.current.get(targetLanguage) || new Map<string, number>()
        if (!starts.has(segmentId)) starts.set(segmentId, (outputBytesRef.current.get(targetLanguage) || 0) / 2 / sampleRate * 1000)
        outputAudioStartBySegmentRef.current.set(targetLanguage, starts)
        const ends = outputAudioEndBySegmentRef.current.get(targetLanguage) || new Map<string, number>()
        ends.set(segmentId, ((outputBytesRef.current.get(targetLanguage) || 0) + chunk.byteLength) / 2 / sampleRate * 1000)
        outputAudioEndBySegmentRef.current.set(targetLanguage, ends)
        output.audioRanges = { ...output.audioRanges, [segmentId]: { startMs: starts.get(segmentId)!, endMs: ends.get(segmentId)! } }
        output.segments = applyOutputAudioStarts(output.segments, starts, ends)
      }
      const chunks = outputChunksRef.current.get(targetLanguage)
      const archived = appendPCMArchiveChunk(
        chunks || [],
        outputBytesRef.current.get(targetLanguage) || 0,
        chunk,
      )
      outputBytesRef.current.set(targetLanguage, archived.receivedBytes)
      output.audioBytes = archived.receivedBytes
      if (mode === 'consumer' && !archived.truncated) {
        queueHistoryPCMChunk(parentSessionIDRef.current, `output-${targetLanguage}`, chunk, sampleRate)
      }
      if (output.firstAudioByteLatency === null && startedAtRef.current > 0) {
        output.firstAudioByteLatency = Math.max(0, audioReceivedAt - startedAtRef.current)
      }
      const player = playbackSuppressedRef.current ? undefined : playersRef.current.get(targetLanguage)
      const playbackGeneration = sessionGenerationRef.current
      const playbackToken = ++playbackTokenRef.current
      const playbackSegments = playbackSegmentsRef.current.get(targetLanguage) || new Map()
      playbackSegmentsRef.current.set(targetLanguage, playbackSegments)
      if (segmentId && player && chunkHasSignal) queuePlaybackChunk(playbackSegments, segmentId)
      // 暂停期间（或没有播放器时）到达的音频直接丢弃，这段译文不会再被念。
      if (segmentId && !player) settleTranslationSegment(targetLanguage, segmentId, 'skipped')
      player?.push(chunk, sampleRate, {
        onStart: (playbackStartedAt) => {
          if (!isCurrentSession(playbackGeneration)) return
          if (!chunkHasSignal) return
          activePlaybackRef.current.set(targetLanguage, { token: playbackToken, segmentId: segmentId || null })
          const currentOutput = outputsRef.current[targetLanguage]
          if (currentOutput && currentOutput.playingTranslationSegmentId !== (segmentId || null)) {
            currentOutput.playingTranslationSegmentId = segmentId || null
            publishOutputs()
          }
          if (output.firstAudioPlaybackLatency !== null || startedAtRef.current <= 0) return
          output.firstAudioPlaybackLatency = Math.max(0, playbackStartedAt - startedAtRef.current)
          const engineReadyUnixMs = engineFirstTTSReadyUnixMsRef.current.get(targetLanguage)
          if (engineReadyUnixMs !== undefined) {
            const playbackUnixMs = Date.now() + playbackStartedAt - performance.now()
            const value = playbackUnixMs - engineReadyUnixMs
            if (Number.isFinite(value) && value >= 0) output.ttsReadyToFirstPlaybackMs = value
          }
          publishOutputs()
        },
        onEnded: () => {
          if (!isCurrentSession(playbackGeneration) || !chunkHasSignal) return
          const segmentFinished = segmentId
            ? finishPlaybackChunk(playbackSegments, segmentId)
            : false
          const activePlayback = activePlaybackRef.current.get(targetLanguage)
          const currentOutput = outputsRef.current[targetLanguage]
          if (segmentFinished && segmentId && settleTranslationSegment(targetLanguage, segmentId, 'played')) {
            publishOutputs()
          }
          if (segmentFinished && activePlayback?.segmentId === segmentId) {
            activePlaybackRef.current.delete(targetLanguage)
            if (currentOutput?.playingTranslationSegmentId === segmentId) {
              currentOutput.playingTranslationSegmentId = null
              publishOutputs()
            }
          }
          if (activePlaybackRef.current.get(targetLanguage)?.token !== playbackToken) return
          if (segmentId && !segmentFinished) {
            const segment = playbackSegments.get(segmentId)
            if (segment && (!segment.inputDone || segment.pendingChunks > 0)) return
          }
          activePlaybackRef.current.delete(targetLanguage)
          if (currentOutput?.playingTranslationSegmentId) {
            currentOutput.playingTranslationSegmentId = null
            publishOutputs()
          }
        },
      })
      publishOutputs()
    }
    if (event.type === 'audio_done') {
      const segmentId = event.segmentId?.trim()
      if (segmentId) {
        const playbackSegments = playbackSegmentsRef.current.get(targetLanguage) || new Map()
        playbackSegmentsRef.current.set(targetLanguage, playbackSegments)
        if (finishPlaybackInput(playbackSegments, segmentId)) {
          // 输入结束且没有排队音频：要么已念完，要么整段静音，都视为已读。
          if (settleTranslationSegment(targetLanguage, segmentId, 'played')) publishOutputs()
          const activePlayback = activePlaybackRef.current.get(targetLanguage)
          const currentOutput = outputsRef.current[targetLanguage]
          if (activePlayback?.segmentId === segmentId) {
            activePlaybackRef.current.delete(targetLanguage)
            if (currentOutput?.playingTranslationSegmentId === segmentId) {
              currentOutput.playingTranslationSegmentId = null
              publishOutputs()
            }
          }
        }
      }
    }
    if (event.type === 'translation_complete') {
      translationCompleteRef.current.add(targetLanguage)
      if (
        stopRequestedRef.current && !drainingTurnRef.current && completionReasonRef.current !== 'session_time_limit'
        && allTargetTranslationsComplete(targetLanguages, translationCompleteRef.current, outputsRef.current)
      ) {
        void finish({ serverFinalizationContinues: true })
      }
    }
    if (event.type === 'error') {
      analyticsEvent('session_error', { reason: 'provider_failed' })
      setError(event.error || '模型服务返回错误。')
      const affectedLanguages = !event.targetLanguage && targetLanguages.length > 1
        ? targetLanguages
        : [targetLanguage]
      for (const language of affectedLanguages) {
        const affectedOutput = outputsRef.current[language]
        if (!affectedOutput) continue
        affectedOutput.error = event.error || '模型服务返回错误。'
        affectedOutput.status = 'error'
      }
      publishOutputs()
      if (
        stopRequestedRef.current && !drainingTurnRef.current && completionReasonRef.current !== 'session_time_limit'
        && translationCompleteRef.current.size > 0
        && allTargetTranslationsComplete(targetLanguages, translationCompleteRef.current, outputsRef.current)
      ) {
        void finish({ serverFinalizationContinues: true })
      } else if (targetLanguages.every((language) => ['finished', 'error'].includes(outputsRef.current[language]?.status))) {
        void finish()
      }
    }
    // 服务端 ready 帧带回实际协商到的音色模式（clone/default）——首个非空值
    // 即本次会话的音色模式，随历史记录的 settings 一起上报。
    if (event.type === 'state' && event.state === 'ready' && event.voiceMode?.trim()) {
      const negotiated = event.voiceMode.trim()
      setVoiceMode((current) => current || negotiated)
    }
    if (event.type === 'state' && event.state === 'finished') {
      output.status = output.error ? 'error' : 'finished'
      publishOutputs()
      if (targetLanguages.every((language) => ['finished', 'error'].includes(outputsRef.current[language]?.status))) {
        void finish()
      }
    }
  }

  const start = async (analyticsFields: AnalyticsFields = {}, pageLease?: () => boolean) => {
    if (!mountedRef.current || pageExitedRef.current || (pageLease && !pageLease()) || (endOnPageExit && typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
    analyticsScopeRef.current = analyticsFields
    if (!ready) {
      analyticsEvent('session_error', { reason: 'provider_not_ready' })
      setError(notReadyReason)
      setRuntimeStatus('error')
      return
    }
    if (targetLanguages.length === 0 || statusRef.current === 'connecting' || statusRef.current === 'recording' || statusRef.current === 'processing') return
    const generation = sessionGenerationRef.current + 1
    const invalidateLogin = mode === 'consumer' ? createConsumerSessionInvalidator() : null
    sessionGenerationRef.current = generation
    startAbortRef.current?.abort()
    captureAbortRef.current?.abort()
    const startController = new AbortController()
    startAbortRef.current = startController
    captureAbortRef.current = startController
    const clearStartController = () => {
      if (startAbortRef.current === startController) startAbortRef.current = null
    }
    // consumer 模式：先经认证通道预检，拿受计量的 cs-* 会话 + 一次性握手票据。
    // 预检失败不进入 reset()，保留上一段转写，只给出可显示错误。
    setRuntimeStatus('connecting')
    privacyRuntimeRef.current?.fence.dispose()
    const privacyAttempt = {
      fence: createMultilingualPrivacyFence(options.privacyGate, () => {
        if (privacyRuntimeRef.current === privacyAttempt) privacyShutdownRef.current()
      }),
      initialized: false,
    }
    privacyRuntimeRef.current = privacyAttempt
    if (!await privacyAttempt.fence.authorize() || !isCurrentSession(generation) || (statusRef.current as Status) !== 'connecting') {
      privacyAttempt.fence.dispose()
      if (isCurrentSession(generation) && (statusRef.current as Status) === 'connecting') setRuntimeStatus('idle')
      clearStartController()
      return
    }
    let socket: WebSocket
    let socketOpen: Promise<void>
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(mode === 'consumer' || mode === 'guest' ? `${protocol}//${window.location.host}/ws/translate` : apiURL(`${protocol}//${window.location.host}/ws/translate`))
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket
      socketOpen = waitForOpen(socket, CONNECTION_TIMEOUT_MS, startController.signal)
      void socketOpen.catch(() => undefined)
    } catch (caught) {
      analyticsEvent('session_error', { reason: 'connection_failed' })
      setError(caught instanceof Error ? caught.message : '无法连接翻译服务。')
      setRuntimeStatus('error')
      clearStartController()
      return
    }
    let consumerSession: ConsumerWsPreflight | null = null
    if (mode === 'consumer' || mode === 'guest') {
      if (mode === 'guest' && !options.guestFetcher) {
        socket.close()
        setError('游客凭证不可用')
        setRuntimeStatus('error')
        clearStartController()
        return
      }
      const preflight = await preflightConsumerWsSession(backendProvider, mode === 'guest' ? options.guestFetcher : undefined, backfill, analyticsScopeRef.current, startController.signal)
      // 组件可能在等待预检时被卸载/收尾（cleanup 不会改 statusRef，但 finish 会）。
      if ((statusRef.current as Status) !== 'connecting' || !isCurrentSession(generation) || !privacyAttempt.fence.allowed()) {
        socket.close()
        clearStartController()
        return
      }
      if (!preflight.ok) {
        socket.close()
        analyticsEvent('session_error', { reason: preflight.error === QUOTA_EXHAUSTED_MESSAGE ? 'quota_exhausted' : 'session_issue_failed' })
        setError(preflight.error)
        setRuntimeStatus('error')
        clearStartController()
        return
      }
      consumerSession = preflight.session
    }
    reset()
    privacyAttempt.initialized = true
    const parentSessionID = consumerSession?.sessionId || (typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    parentSessionIDRef.current = parentSessionID
    traceRef.current = createApiTraceContext()
    let recorder: RecorderHandle | null = null
    let recorderSetup: Promise<RecorderHandle> | null = null
    let readyPlayers: Array<readonly [string, PCMStreamPlayer]> = []
    try {
      const pendingPCM: ArrayBuffer[] = []
      let audioReady = false
      const consumePCM = (pcm: ArrayBuffer) => {
        if (!privacyAttempt.fence.allowed()) { pendingPCM.length = 0; return }
        if (statusRef.current !== 'connecting' && statusRef.current !== 'recording') return
        if (startedAtRef.current <= 0) {
          const chunkDurationMs = pcm.byteLength / 2 / 16000 * 1000
          startedAtRef.current = performance.now() - chunkDurationMs
          recordingStartedUnixMsRef.current = Date.now() - chunkDurationMs
          // 老后端不发 session_started：用本地开始时间 + 默认时限兜底。
          if (sessionEndsAtMsRef.current === null) applySessionLimit(recordingStartedUnixMsRef.current)
        }
        const pcmCopy = pcm.slice(0)
        const chunk = new Uint8Array(pcmCopy)
        const archived = appendPCMArchiveChunk(
          inputChunksRef.current,
          inputBytesRef.current,
          chunk,
        )
        inputBytesRef.current = archived.receivedBytes
        if (mode === 'consumer' && !archived.truncated && !backfill) {
          queueHistoryPCMChunk(parentSessionIDRef.current, 'input', chunk, 16000)
        }
        if (audioReady && socket?.readyState === WebSocket.OPEN) socket.send(pcmCopy)
        else pendingPCM.push(pcmCopy)
      }
      consumePCMRef.current = consumePCM
      const recorderGeneration = recorderGenerationRef.current + 1
      recorderGenerationRef.current = recorderGeneration
      const consumeRecorderPCM = (pcm: ArrayBuffer) => {
        if (recorderGenerationRef.current === recorderGeneration) consumePCMRef.current(pcm)
      }
      const parallelRecorderSetup = service === 'websocket'
        ? (recorderFactory ? recorderFactory(consumeRecorderPCM) : createRecorder(consumeRecorderPCM, inputDeviceId, { processing: inputProcessing, browserAudioProcessing, signal: startController.signal })).then(created => {
          if (!isCurrentSession(generation) || !privacyAttempt.fence.allowed()) void releaseMultilingualRecorder(created)
          return created
        })
        : null
      recorderSetup = parallelRecorderSetup
      void parallelRecorderSetup?.catch(() => undefined)
      const runtime = await createRuntime(inputDeviceId, outputDeviceId)
      readyPlayers = [...runtime.players.entries()]
      if (!isCurrentSession(generation, socket) || !privacyAttempt.fence.allowed()) {
        socket.close()
        // A permission prompt may resolve after revocation/unmount. Release its
        // eventual microphone as well as the already prepared playback handles.
        void parallelRecorderSetup?.then(releaseMultilingualRecorder).catch(() => undefined)
        await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
        return
      }
      activeRecorderFactoryRef.current = runtime.createRecorder
      readyPlayers.forEach(([targetLanguage, player]) => {
        player.setVolume?.(playbackVolumeRef.current)
        player.setMuted(mutedLanguagesRef.current.has(targetLanguage))
      })
      const preparedRecorder = parallelRecorderSetup ? await parallelRecorderSetup : null
      recorderSetup = (preparedRecorder
        ? Promise.resolve(preparedRecorder)
        : runtime.createRecorder(consumeRecorderPCM, inputDeviceId)).then((created) => {
        recorder = created
        if (!isCurrentSession(generation) || !privacyAttempt.fence.allowed()) void releaseMultilingualRecorder(created)
        return created
      })
      const [, readyRecorder] = await Promise.all([
        socketOpen,
        recorderSetup,
      ])
      if (!isCurrentSession(generation, socket) || (statusRef.current as Status) !== 'connecting' || !privacyAttempt.fence.allowed()) {
        await releaseMultilingualRecorder(readyRecorder)
        socket.close()
        await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
        return
      }
      readyPlayers.forEach(([targetLanguage, player]) => {
        // Permission/socket setup can outlast a slider or mute change. These
        // players were not in playersRef when the preference effect ran.
        player.setVolume?.(playbackVolumeRef.current)
        player.setMuted(mutedLanguagesRef.current.has(targetLanguage))
        playersRef.current.set(targetLanguage, player)
      })
      monitor.setPlayers([...playersRef.current.values()])
      socket.onmessage = (message) => {
        if (!isCurrentSession(generation, socket)) return
        try {
          const event = JSON.parse(message.data) as ServerEvent
          if (event.type === 'error' && event.code === 'session_replaced' && invalidateLogin) {
            setError('账号已在另一台设备登录，请重新登录')
            void finish()
            invalidateLogin()
            return
          }
          handleEvent(event)
        } catch { /* Ignore malformed provider frames. */ }
      }
      socket.onerror = () => {
        if (!isCurrentSession(generation, socket) || finishingRef.current || (stopRequestedRef.current && completionReasonRef.current !== 'session_time_limit')) return
        analyticsEvent('session_error', { reason: 'connection_interrupted' })
        const message = '多语翻译连接中断，请检查网络和服务状态。'
        setError(message)
        for (const output of Object.values(outputsRef.current)) {
          if (output.status === 'finished' || output.status === 'error') continue
          output.status = 'error'
          output.error = message
        }
        publishOutputs()
        void finish()
      }
      socket.onclose = (event) => {
        if (!isCurrentSession(generation, socket)) return
        if (event.reason === 'session_replaced' && invalidateLogin) {
          setError('账号已在另一台设备登录，请重新登录')
          void finish()
          invalidateLogin()
          return
        }
        if (finishingRef.current || statusRef.current === 'finished') return
        if (stopRequestedRef.current && statusRef.current === 'processing' && (completionReasonRef.current !== 'session_time_limit' || event.code === 1000)) {
          void finish()
          return
        }
        const translationsComplete = allTargetTranslationsComplete(targetLanguages, translationCompleteRef.current, outputsRef.current)
        if (!shouldReportMultilingualSocketClose(statusRef.current, stopRequestedRef.current && completionReasonRef.current !== 'session_time_limit', translationsComplete)) {
          // 译文已全部到齐或用户已要求停止：静默收尾，不提示。
          if (translationsComplete) void finish()
          return
        }
        analyticsEvent('session_error', { reason: 'connection_closed' })
        const message = '多语翻译连接已提前关闭。'
        setError(message)
        for (const output of Object.values(outputsRef.current)) {
          if (output.status === 'finished' || output.status === 'error') continue
          output.status = 'error'
          output.error = message
        }
        publishOutputs()
        void finish()
      }
      if (!privacyAttempt.fence.allowed()) throw new Error(MULTILINGUAL_PRIVACY_STOPPED_MESSAGE)
      socket.send(JSON.stringify({ ...buildMultilingualStartFrame({
        sessionId: parentSessionID,
        sessionLayout: options.sessionLayout,
        provider: backendProvider,
        sourceLanguage,
        targetLanguages,
        priorityLanguage: priorityLanguageRef.current,
        voiceClone: effectiveVoiceClone,
        voice: effectiveVoiceClone ? '' : selectedVoice,
        deepFilterNet,
        qwen3ModelIntervalMs,
        qwen3SimulSystemPrompt: options.qwen3SimulSystemPrompt,
        asrContext: options.asrContext,
        asrContextOverride: options.asrContextOverride,
        vadLoudnessMode,
        vadLoudnessThresholdDbfs,
        requestId: traceRef.current.requestId,
        traceparent: traceparentFor(traceRef.current),
        ticket: consumerSession?.ticket,
        eventSchemaVersion: consumerSession?.eventSchemaVersion ?? 1,
        transport,
      }), analytics: productAnalyticsMetadata(analyticsScopeRef.current) }))
      audioReady = true
      for (const chunk of pendingPCM) {
        if (!privacyAttempt.fence.allowed()) break
        if (socket?.readyState === WebSocket.OPEN) socket.send(chunk)
      }
      pendingPCM.length = 0
      if (!privacyAttempt.fence.allowed() || !isCurrentSession(generation, socket) || (statusRef.current as Status) !== 'connecting') {
        await releaseMultilingualRecorder(readyRecorder)
        socket.close()
        await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
        return
      }
      recorderRef.current = readyRecorder
      setInputTrack(readyRecorder.inputTrack ?? null)
      setAudioProcessingDiagnostics(readyRecorder.diagnostics)
      refreshAudioDevices()
      for (const output of Object.values(outputsRef.current)) output.status = 'recording'
      publishOutputs()
      setRuntimeStatus('recording')
      return parentSessionID
    } catch (caught) {
      if (isCurrentSession(generation, socket)) {
        recorderGenerationRef.current += 1
        consumePCMRef.current = () => undefined
        activeRecorderFactoryRef.current = null
      }
      const readyRecorder = recorder || (recorderSetup ? await recorderSetup.catch(() => null) : null)
      await readyRecorder?.stop().catch(() => undefined)
      socket.close()
      await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
      if (!isCurrentSession(generation, socket)) return
      await closePlayers(false)
      if (!isCurrentSession(generation, socket)) return
      analyticsEvent('session_error', { reason: caught instanceof DOMException && caught.name === 'NotAllowedError' ? 'microphone_denied' : 'start_failed' })
      setError(caught instanceof Error ? caught.message : '无法启动多语同传。')
      setRuntimeStatus('error')
    } finally {
      clearStartController()
    }
  }

  const changeInputDevice = async (nextInputDeviceId: string, nextRecorderFactory?: RecorderFactory) => {
    if (!privacyAllowed()) return false
    if (statusRef.current !== 'recording' || pausedRef.current || finishingRef.current || inputDeviceSwitchingRef.current) return false
    if (nextInputDeviceId !== 'default' && nextInputDeviceId === inputDeviceId && !nextRecorderFactory && recorderRef.current?.inputTrack?.readyState !== 'ended') return true
    const generation = sessionGenerationRef.current
    inputDeviceSwitchingRef.current = true
    setInputDeviceSwitching(true)
    setError('')
    // Open the replacement first, then atomically advance the generation so
    // old and new recorders never feed the WebSocket at the same time.
    const nextGeneration = recorderGenerationRef.current + 1
    const consumeNextPCM = (pcm: ArrayBuffer) => {
      if (isCurrentSession(generation) && recorderGenerationRef.current === nextGeneration) consumePCMRef.current(pcm)
    }
    let nextRecorder: RecorderHandle | null = null
    try {
      nextRecorder = nextRecorderFactory
        ? await nextRecorderFactory(consumeNextPCM)
        : activeRecorderFactoryRef.current
          ? await activeRecorderFactoryRef.current(consumeNextPCM, nextInputDeviceId)
          : await createRecorder(consumeNextPCM, nextInputDeviceId, { processing: inputProcessing, browserAudioProcessing, signal: captureAbortRef.current?.signal })
      if (!isCurrentSession(generation) || statusRef.current !== 'recording' || finishingRef.current || !privacyAllowed()) {
        await releaseMultilingualRecorder(nextRecorder)
        return false
      }
      const previousRecorder = recorderRef.current
      recorderGenerationRef.current = nextGeneration
      recorderRef.current = nextRecorder
      setInputTrack(nextRecorder.inputTrack ?? null)
      setInputDeviceUnavailable(false)
      setAudioProcessingDiagnostics(nextRecorder.diagnostics)
      await previousRecorder?.stop().catch(() => {
        if (isCurrentSession(generation)) setError('麦克风已切换，但旧设备未能正常释放。')
      })
      if (!isCurrentSession(generation)) return false
      refreshAudioDevices()
      return true
    } catch (caught) {
      await releaseMultilingualRecorder(nextRecorder)
      if (isCurrentSession(generation)) setError(caught instanceof Error ? caught.message : '无法切换麦克风。')
      return false
    } finally {
      if (isCurrentSession(generation)) { inputDeviceSwitchingRef.current = false; setInputDeviceSwitching(false) }
    }
  }

  useEffect(() => {
    if (service !== 'websocket' || recorderFactory || status !== 'recording' || paused) return
    const recorder = recorderRef.current
    if (!recorder) return
    let active = true
    let checking = false
    const checkDefault = async () => {
      if (!active || checking || inputDeviceId !== 'default' || inputDeviceSwitchingRef.current) return
      checking = true
      try {
        const device = await getDefaultAudioInput()
        if (!active || recorderRef.current !== recorder) return
        if (!device) {
          setError('未找到默认麦克风，请连接设备或手动选择麦克风。')
          return
        }
        if (defaultAudioInputKey(device) === recorder.diagnostics.defaultInputDeviceKey && recorder.inputTrack?.readyState !== 'ended') return
        await changeInputDevice('default')
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : '无法检测默认麦克风。')
      } finally {
        checking = false
      }
    }
    const ended = () => {
      if (!active || recorderRef.current !== recorder) return
      setInputDeviceUnavailable(true)
      setError('麦克风已断开，输入已中断，请连接设备或重新选择麦克风。')
      void checkDefault()
    }
    const refresh = () => { void checkDefault() }
    const visible = () => { if (document.visibilityState === 'visible') refresh() }
    setInputDeviceUnavailable(recorder.inputTrack?.readyState === 'ended')
    recorder.inputTrack?.addEventListener?.('ended', ended)
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visible)
    // Some browsers delay devicechange; only enumerate here, never open a
    // microphone unless the default identity changes or the active track ends.
    const timer = inputDeviceId === 'default' ? window.setInterval(refresh, 2000) : undefined
    refresh()
    return () => {
      active = false
      window.clearInterval(timer)
      recorder.inputTrack?.removeEventListener?.('ended', ended)
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [service, recorderFactory, status, paused, inputDeviceId, audioProcessingDiagnostics])

  const changeOutputDevice = async (nextOutputDeviceId: string) => {
    if (statusRef.current !== 'recording' || finishingRef.current || outputDeviceSwitchingRef.current) return false
    if (nextOutputDeviceId === outputDeviceId) return true
    const generation = sessionGenerationRef.current
    outputDeviceSwitchingRef.current = true
    setOutputDeviceSwitching(true)
    setError('')
    const players = [...playersRef.current.values()]
    try {
      const results = await Promise.allSettled(players.map((player) => player.setOutputDevice(nextOutputDeviceId)))
      if (!isCurrentSession(generation)) return false
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) {
        await Promise.allSettled(players.map((player) => player.setOutputDevice(outputDeviceId)))
        throw failure.reason
      }
      return true
    } catch (caught) {
      if (isCurrentSession(generation)) setError(caught instanceof Error ? caught.message : '无法切换音频输出设备。')
      return false
    } finally {
      if (isCurrentSession(generation)) { outputDeviceSwitchingRef.current = false; setOutputDeviceSwitching(false) }
    }
  }

  // Called directly from the device chooser so browser playback starts from
  // the user's gesture. The controlled prop remains the saved page selection.
  const changeMonitorOutput = (nextDeviceId: string | null) => monitor.configure(nextDeviceId)

  const pause = async () => {
    if (statusRef.current !== 'recording' || pausedRef.current || finishingRef.current || inputDeviceSwitchingRef.current) return false
    const generation = sessionGenerationRef.current
    inputDeviceSwitchingRef.current = true
    setInputDeviceSwitching(true)
    setError('')
    playbackSuppressedRef.current = true
    analyticsEvent('session_paused')
    setPausedState(true)
    skipQueuedPlayback()
    clearPlaybackHighlights()
    closePlayersAfterNextPaint()
    const recorder = recorderRef.current
    recorderRef.current = null
    setInputTrack(null)
    try {
      await recorder?.stop()
      if (!isCurrentSession(generation)) return false
      // Pausing removes the microphone immediately. Feed a short synthetic
      // silent tail through the normal archive/socket path so server-side VAD
      // can close the last utterance and return all text already spoken.
      const silenceBytes = 16_000 * 2 * PAUSE_VAD_CHUNK_MS / 1000
      for (let elapsedMs = 0; elapsedMs < PAUSE_VAD_DRAIN_MS; elapsedMs += PAUSE_VAD_CHUNK_MS) {
        consumePCMRef.current(new ArrayBuffer(silenceBytes))
      }
      refreshAudioDevices()
      return true
    } catch (caught) {
      if (isCurrentSession(generation)) setError(caught instanceof Error ? caught.message : '无法暂停麦克风。')
      return false
    } finally {
      if (isCurrentSession(generation)) {
        recorderGenerationRef.current += 1
        inputDeviceSwitchingRef.current = false
        setInputDeviceSwitching(false)
      }
    }
  }

  const resume = async () => {
    if (!privacyAllowed()) return false
    if (statusRef.current !== 'recording' || !pausedRef.current || finishingRef.current || inputDeviceSwitchingRef.current) return false
    const generation = sessionGenerationRef.current
    inputDeviceSwitchingRef.current = true
    setInputDeviceSwitching(true)
    setError('')
    const nextGeneration = recorderGenerationRef.current + 1
    const consumeNextPCM = (pcm: ArrayBuffer) => {
      if (isCurrentSession(generation) && recorderGenerationRef.current === nextGeneration) consumePCMRef.current(pcm)
    }
    let recorder: RecorderHandle | null = null
    let readyPlayers: Array<readonly [string, PCMStreamPlayer]> = []
    try {
      const runtime = await createRuntime(inputDeviceId, outputDeviceId)
      readyPlayers = [...runtime.players.entries()]
      if (!isCurrentSession(generation) || !privacyAllowed() || statusRef.current !== 'recording' || finishingRef.current || !pausedRef.current) {
        await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
        return false
      }
      activeRecorderFactoryRef.current = runtime.createRecorder
      readyPlayers.forEach(([targetLanguage, player]) => {
        player.setVolume?.(playbackVolumeRef.current)
        player.setMuted(mutedLanguagesRef.current.has(targetLanguage))
      })
      const readyRecorder = await runtime.createRecorder(consumeNextPCM, inputDeviceId)
      recorder = readyRecorder
      if (!isCurrentSession(generation) || statusRef.current !== 'recording' || finishingRef.current || !pausedRef.current || !privacyAllowed()) {
        await releaseMultilingualRecorder(recorder)
        await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
        return false
      }
      readyPlayers.forEach(([targetLanguage, player]) => {
        // Resume also creates new players while microphone permission/setup is
        // pending; adopt the latest choices before accepting translated PCM.
        player.setVolume?.(playbackVolumeRef.current)
        player.setMuted(mutedLanguagesRef.current.has(targetLanguage))
        playersRef.current.set(targetLanguage, player)
      })
      monitor.setPlayers([...playersRef.current.values()])
      recorderGenerationRef.current = nextGeneration
      recorderRef.current = recorder
      setInputTrack(recorder.inputTrack ?? null)
      setAudioProcessingDiagnostics(recorder.diagnostics)
      playbackSuppressedRef.current = false
      analyticsEvent('session_resumed')
      setPausedState(false)
      refreshAudioDevices()
      return true
    } catch (caught) {
      await releaseMultilingualRecorder(recorder)
      if (isCurrentSession(generation)) activeRecorderFactoryRef.current = null
      await Promise.all(readyPlayers.map(([, player]) => player.close().catch(() => undefined)))
      if (isCurrentSession(generation)) setError(caught instanceof Error ? caught.message : '无法继续使用麦克风。')
      return false
    } finally {
      if (isCurrentSession(generation)) { inputDeviceSwitchingRef.current = false; setInputDeviceSwitching(false) }
    }
  }

  const stop = async (reason?: 'session_time_limit') => {
    if (statusRef.current !== 'recording') return
    const generation = sessionGenerationRef.current
    if (reason) {
      completionReasonRef.current = reason
      setCompletionReason(reason)
    }
    stopRequestedRef.current = true
    playbackSuppressedRef.current = !drainingTurnRef.current
    const recorder = recorderRef.current
    recorderRef.current = null
    setInputTrack(null)
    recorderGenerationRef.current += 1
    consumePCMRef.current = () => undefined
    const socket = socketRef.current
    let stopSent = false
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'stop' }))
        stopSent = true
        armCompletionTimer()
      } catch {
        // The close handler or the fallback below completes the local session.
      }
    }
    setPausedState(false)
    setRuntimeStatus('processing')
    playbackSegmentsRef.current.clear()
    activePlaybackRef.current.clear()
    for (const output of Object.values(outputsRef.current)) {
      output.status = 'processing'
      output.playingTranslationSegmentId = null
    }
    publishOutputs()
    if (!drainingTurnRef.current) closePlayersAfterNextPaint()
    const recorderRelease = recorder?.stop().catch((caught) => {
      if (isCurrentSession(generation) && statusRef.current === 'processing') {
        setError(caught instanceof Error ? caught.message : '无法停止麦克风。')
      }
    })
    if (stopSent) {
      void recorderRelease
      return
    }
    await recorderRelease
    if (!isCurrentSession(generation)) return
    void finish()
  }

  privacyShutdownRef.current = () => {
    if (!mountedRef.current) return
    startAbortRef.current?.abort()
    // Fence callbacks run synchronously with revocation, before React effects.
    recorderGenerationRef.current += 1
    consumePCMRef.current = () => undefined
    drainingTurnRef.current = false
    playbackSuppressedRef.current = true
    setError(MULTILINGUAL_PRIVACY_STOPPED_MESSAGE)
    if (statusRef.current === 'recording') { void stop(); return }
    if (privacyRuntimeRef.current?.initialized && (statusRef.current === 'connecting' || statusRef.current === 'processing')) {
      stopRequestedRef.current = true
      void finish()
      return
    }
    socketRef.current?.close()
    if (statusRef.current === 'connecting') setRuntimeStatus('idle')
  }

  useEffect(() => {
    const attempt = privacyRuntimeRef.current
    if (attempt && attempt.fence.gate !== options.privacyGate) attempt.fence.invalidate()
  }, [options.privacyGate])

  /** Finish one physical speaking turn before its successor opens a socket/mic.
   * Unlike ordinary user completion this lets the final queued translation play.
   * The caller retains aggregate rows and real turn session IDs outside this hook.
   */
  const stopAndDrain = async (): Promise<boolean> => {
    if (statusRef.current !== 'recording' && statusRef.current !== 'processing') return statusRef.current === 'finished' || statusRef.current === 'idle' || statusRef.current === 'error'
    drainingTurnRef.current = true
    return new Promise<boolean>(resolve => {
      let timer: number | undefined
      const settle = (completed: boolean) => {
        if (timer !== undefined) window.clearTimeout(timer)
        finishWaitersRef.current.delete(settle)
        resolve(completed)
      }
      finishWaitersRef.current.add(settle)
      timer = window.setTimeout(() => {
        if (!mountedRef.current) { settle(false); return }
        setError('上一轮仍在收尾，请稍后重试；已有字幕已保留。')
        settle(false)
      }, 20_000)
      void stop().catch(() => settle(false))
    })
  }

  // consumer 模式：录音期间按分钟真实计量（与 iOS LiveScreen 同节奏，服务端按
  // (sessionId, minuteIndex) 幂等）。额度耗尽 → 中文提示并自动收尾会话。
  useEffect(() => {
    if ((mode !== 'consumer' && mode !== 'guest') || status !== 'recording' || backfill) return undefined
    quotaMinuteIndexRef.current = 0
    const timer = window.setInterval(() => {
      if (!privacyAllowed()) return
      const generation = sessionGenerationRef.current
      const sessionId = parentSessionIDRef.current
      if (!sessionId) return
      const index = quotaMinuteIndexRef.current
      quotaMinuteIndexRef.current += 1
      void consumeConsumerQuotaMinute(sessionId, index, mode === 'guest' ? options.guestFetcher : undefined).then((result) => {
        if (!isCurrentSession(generation) || parentSessionIDRef.current !== sessionId) return
        if (result === 'quota_exhausted') {
          setError(QUOTA_EXHAUSTED_MESSAGE)
          void stop()
          return
        }
        if (result) onQuotaRef.current?.(result)
      })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [backfill, mode, status])

  return {
    status, error, completionReason, sourceText, sourceSegments, outputs, audioProcessingDiagnostics, inputDeviceUnavailable, inputTrack,
    paused, inputDeviceSwitching, outputDeviceSwitching, start, capturePageLease, pause, resume, stop, stopAndDrain, changeInputDevice, changeOutputDevice,
    monitorError, monitorDeviceSwitching, monitorSupported: service === 'websocket', changeMonitorOutput,
    // 逐句反馈需要归属会话：状态每次变化都会重渲染，取 ref 当前值足够新鲜。
    analyticsAttemptId: analyticsScopeRef.current.attemptId,
    parentSessionID: parentSessionIDRef.current,
    // start 帧 traceparent 的 trace-id（同上，取 ref 当前值），随历史记录上报后
    // 可与后端 trace、客户端日志对齐。
    traceId: traceRef.current.traceId,
    /** 服务端 ready 帧回报的音色模式（'clone' | 'default'），未收到时为空串。 */
    voiceMode,
    /** 本场会话的预期结束时刻（Unix ms）；未开始 / 已收尾时为 null。 */
    sessionEndsAtMs,
  }
}
