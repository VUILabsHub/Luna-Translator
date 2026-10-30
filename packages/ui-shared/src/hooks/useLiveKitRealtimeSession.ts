import { observeSharePCMBytes } from '@simultrans/core/liveShareAudio'
// Change record (2026-08-05): forward cumulative model snapshots to the live
// transcript without treating revisable Qwen3 previews as first stable text.
import type {
  LocalAudioTrack,
  RemoteTrack,
  Room,
} from 'livekit-client'
import { useEffect, useRef, useState } from 'react'
import { queueHistoryPCMChunk } from '../historyAudio'
import {
  createPCMTrackReader,
  echoCancellationSetting,
  defaultBrowserAudioProcessing,
  type BrowserAudioProcessingOptions,
  pcm16HasSignal,
  pcmChunksToWav,
  type AudioProcessingDiagnostics,
} from '../audio'
import {
  cumulativeTranscriptSegments,
  emptyCumulativeTranscriptState,
  reconcileCumulativeTranscript,
  reconcileStreamingTranslationSegments,
  selectStreamingTranslationSnapshot,
  upsertNativeMetricSample,
  type CumulativeTranscriptState,
} from '../lib/transcript'
import { ensureServerClockSync } from '../lib/clockSync'
import { apiFetch, createApiTraceContext, type ApiTraceContext } from '../lib/apiFetch'
import { upsertSentenceDiagnostic } from '../lib/sentenceDiagnostics'
import {
  emptyVadTranscriptPairState,
  reduceVadTranscriptPairEvent,
  sourceVadStartMsForEvent,
  type VadTranscriptPair,
  type VadTranscriptPairState,
} from '../lib/vadTranscriptPairs'
import {
  attributePlayoutSegmentsToUnits,
  bridgePlaybackMarker,
  bridgeScheduledPlaybackAtMs,
  bridgeSentenceUnits,
  canStartBridgePlaybackHighlight,
  finalizeBridgeTranslation,
  nextBridgePlaybackMarker,
  nextBridgeSourceSnapshot,
  reconcileBridgeTranslation,
  shouldAcceptBridgeEvent,
  type BridgeEvent,
  type BridgeMediaRange,
  type BridgeParticipant,
  type BridgePlaybackMarker,
  type BridgeTranslationState,
} from '@simultrans/core/bridge'

export {
  attributePlayoutSegmentsToUnits,
  bridgeMediaRange,
  bridgePlaybackMarker,
  bridgeScheduledPlaybackAtMs,
  canStartBridgePlaybackHighlight,
  finalizeBridgeTranslation,
  nextBridgePlaybackMarker,
  nextBridgeSourceSnapshot,
  reconcileBridgeTranslation,
  shouldAcceptBridgeEvent,
} from '@simultrans/core/bridge'
export type {
  BridgeEvent,
  BridgeMediaRange,
  BridgePlaybackMarker,
  BridgeTranslationState,
} from '@simultrans/core/bridge'
import {
  attachWebRTCOutputAudio,
  classifyWebRTCOutputCompletion,
  emptyWebRTCOutputEvidence,
  hasLiveWebRTCOutput,
  isUserGesturePlaybackError,
  reduceWebRTCOutputEvidence,
  type WebRTCOutputCompletion,
  type WebRTCOutputAudioController,
  type WebRTCOutputEvidence,
} from '../lib/webrtcOutputAudio'
import {
  startWebRTCInputArchive,
  type WebRTCInputArchiveController,
} from '../lib/webrtcInputArchive'
import { createRTCStatsCollector } from '../webrtcStats'
import type { EngineLatencyMetrics, SentenceDiagnostic, TranslationDisplayUnit } from '../types/history'
import type { RealtimeService } from '../lib/config'
import {
  appendPCMArchiveChunk,
  applyProcessingEventEvidence,
  processingTimeoutFailure,
  useSessionRuntime,
  type ProcessingEvidenceActions,
  type Status,
} from './useSessionRuntime'
import type { RealtimeSession, RealtimeSessionOptions } from './useRealtimeSession'

const CONTROL_TOPIC = 's2st.control'
const EVENT_TOPIC = 's2st.events'
const PREPARED_SESSION_MAX_AGE_MS = 90_000
// Re-create the standby room when it ages out so an idle user still gets a warm
// start. Bounded so an abandoned tab stops creating LiveKit rooms (~15 min).
const PREPARED_SESSION_REARM_LIMIT = 9
const WEBRTC_CLEANUP_TIMEOUT_MS = 5_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

type LiveKitSessionResponse = {
  sessionId: string
  roomName: string
  identity: string
  livekitUrl: string
  token: string
  agentName: string
  dispatchId?: string
  phase?: 'standby' | 'active'
  prepareExpiresInSeconds?: number
  traceContext?: ApiTraceContext
}

export function applyWebRTCProcessingEventEvidence(
  event: BridgeEvent,
  generation: number,
  actions: ProcessingEvidenceActions,
  hasAudioSignal = false,
) {
  return applyProcessingEventEvidence(event, generation, actions, hasAudioSignal)
}

export function applyWebRTCNativePlaybackProgress(
  generation: number,
  actions: Pick<ProcessingEvidenceActions, 'noteProgress'>,
) {
  return actions.noteProgress(generation)
}

export function withBridgeMediaPlaybackEstimates(
  diagnostics: SentenceDiagnostic[],
  firstNativePlaybackAtMs: number | null,
) {
  let changed = false
  const next = diagnostics.map((diagnostic) => {
    if (diagnostic.playbackTimingSource === 'browser_observed') return diagnostic
    const playbackStartedAtMs = bridgeScheduledPlaybackAtMs(
      firstNativePlaybackAtMs,
      diagnostic.agentMediaStartSample,
      diagnostic.agentMediaSampleRateHz,
    )
    if (playbackStartedAtMs === null) return diagnostic
    if (
      diagnostic.playbackStartedAtMs === playbackStartedAtMs &&
      diagnostic.playbackTimingSource === 'browser_scheduled'
    ) return diagnostic
    changed = true
    return { ...diagnostic, playbackStartedAtMs, playbackTimingSource: 'browser_scheduled' as const }
  })
  return changed ? next : diagnostics
}

export function canFailWebRTCSession(
  generation: number,
  currentGeneration: number,
  status: Status,
) {
  return generation === currentGeneration && status !== 'error' && status !== 'finished'
}

export function shouldArmWebRTCProcessingTimeout(
  generation: number,
  currentGeneration: number,
  status: Status,
  finishing: boolean,
) {
  return generation === currentGeneration && status === 'processing' && !finishing
}

export function canPrewarmLiveKitSession(
  service: RealtimeService,
  ready: boolean,
  status: Status,
) {
  return service === 'livekit' && ready && (
    status === 'idle' || status === 'finished' || status === 'error'
  )
}

export async function stopWebRTCInputBeforeFinish(
  stopInputArchive: () => unknown | Promise<unknown>,
  unpublishInputTrack: () => unknown | Promise<unknown>,
  publishFinish: () => unknown | Promise<unknown>,
  cleanupTimeoutMs = WEBRTC_CLEANUP_TIMEOUT_MS,
) {
  const cleanup = await settleWebRTCCleanup([
    stopInputArchive,
    unpublishInputTrack,
  ], cleanupTimeoutMs)
  const finishPublish = await settleWebRTCCleanup([publishFinish], cleanupTimeoutMs)
  if (finishPublish.cleanupTimedOut) {
    throw new Error('WebRTC 结束指令发布超时。')
  }
  if (finishPublish.cleanupErrors.length > 0) throw finishPublish.cleanupErrors[0]
  return cleanup
}

export type WebRTCCleanupResult = {
  cleanupTimedOut: boolean
  cleanupErrors: unknown[]
}

export async function settleWebRTCCleanup(
  cleanupTasks: Array<() => unknown | Promise<unknown>>,
  timeoutMs = WEBRTC_CLEANUP_TIMEOUT_MS,
): Promise<WebRTCCleanupResult> {
  const settled = Promise.allSettled(
    cleanupTasks.map((task) => Promise.resolve().then(task)),
  )
  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timeout = globalThis.setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  const outcome = await Promise.race([
    settled.then((results) => ({ timedOut: false as const, results })),
    deadline,
  ])
  if (timeout !== null) globalThis.clearTimeout(timeout)
  if (outcome.timedOut) return { cleanupTimedOut: true, cleanupErrors: [] }
  return {
    cleanupTimedOut: false,
    cleanupErrors: outcome.results.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    )),
  }
}

export function bridgeLifecycleTraceKey(eventType: string) {
  if (eventType === 'provider_finished') return 'providerFinished' as const
  if (eventType === 'playout_drained') return 'agentPlayoutDrained' as const
  return null
}

export function webRTCOutputCompletionFailure(completion: WebRTCOutputCompletion) {
  if (completion === 'confirmed') return null
  if (completion === 'active-silent') {
    return { category: 'audio_output', message: 'WebRTC 已订阅翻译音轨，但未收到任何非静音音频。' }
  }
  if (completion === 'reader-unavailable') {
    return { category: 'audio_output', message: 'WebRTC 音频分析读取器不可用，无法验证翻译音轨包含有效非静音输出。' }
  }
  return { category: 'audio_output', message: 'WebRTC 已收到翻译音频，但浏览器未确认原生音轨开始播放。' }
}

export function canCompleteWebRTCWithoutConfirmedOutput(
  completion: WebRTCOutputCompletion,
  hasOutputController: boolean,
  allowNoOutputTrack: boolean,
) {
  return allowNoOutputTrack && completion === 'not-playing' && !hasOutputController
}

export function commitWebRTCCompletedHistory(
  prepareInputArchive: () => void,
  prepareOutputArchive: () => void,
  markFinished: () => void,
  recordCompleted: () => void,
) {
  prepareInputArchive()
  prepareOutputArchive()
  markFinished()
  recordCompleted()
}

export function deriveBridgeOutputToPlaybackMs(
  captureToFirstPlaybackMs: number | null,
  bridgeFirstInputToFirstOutputMs: number | null,
) {
  if (captureToFirstPlaybackMs === null || bridgeFirstInputToFirstOutputMs === null) return null
  const value = captureToFirstPlaybackMs - bridgeFirstInputToFirstOutputMs
  return Number.isFinite(value) && value >= 0 ? value : null
}

export function nextFirstStableTranslationLatency(
  currentLatencyMs: number | null,
  captureStartedAt: number,
  receivedAt: number,
  newlyConfirmedUnitCount: number,
) {
  if (currentLatencyMs !== null || captureStartedAt <= 0 || newlyConfirmedUnitCount <= 0) {
    return currentLatencyMs
  }
  return Math.max(0, receivedAt - captureStartedAt)
}

type LiveKitModule = typeof import('livekit-client')

type PreparedLiveKitSession = {
  session: LiveKitSessionResponse
  liveKit: LiveKitModule
  room: Room
  expiresAt: number
  connected: boolean
  standbySeen: () => boolean
  detachStandbyListener: () => void
}

type WebRTCLocalTrackStartup = {
  adopt: () => Promise<LocalAudioTrack>
  cancel: () => void
}

type WebRTCActivationOwner = {
  generation: number
  prepared: PreparedLiveKitSession
}

type WebRTCLocalTrackStartupOwner = {
  generation: number
  startup: WebRTCLocalTrackStartup
}

type SinkSelectableAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>
}

type BridgeReadyRoom = Pick<Room, 'localParticipant'>

export function loadWebRTCStartupDependencies<TSession, TModule>(
  requestSession: () => Promise<TSession>,
  loadModule: () => Promise<TModule>,
): Promise<[TSession, TModule]> {
  const sessionPromise = requestSession()
  const modulePromise = loadModule()
  return Promise.all([sessionPromise, modulePromise])
}

export function throwIfWebRTCPreparationAborted(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('WebRTC 预备会话已取消。', 'AbortError')
}

export function deferWebRTCPreparation(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        throwIfWebRTCPreparationAborted(signal)
        resolve()
      } catch (caught) {
        reject(caught)
      }
    })
  })
}

export function createCancellableWebRTCPreparation<T>(
  prepare: (signal: AbortSignal) => Promise<T>,
  dispose: (value: T) => void | Promise<void>,
) {
  let adopted = false
  let cancelled = false
  let disposed = false
  let ready: { value: T } | null = null
  const abortController = new AbortController()
  const result = prepare(abortController.signal).then(
    (value) => {
      ready = { value }
      return { ok: true as const, value }
    },
    (error: unknown) => ({ ok: false as const, error }),
  )
  const disposeOnce = (value: T) => {
    if (disposed) return
    disposed = true
    void dispose(value)
  }

  return {
    peek() {
      return !adopted && !cancelled ? ready?.value ?? null : null
    },
    async adopt() {
      const outcome = await result
      if (!outcome.ok) throw outcome.error
      if (cancelled) {
        disposeOnce(outcome.value)
        throw new Error('WebRTC 预备会话已取消。')
      }
      adopted = true
      ready = null
      return outcome.value
    },
    cancel() {
      cancelled = true
      ready = null
      if (!adopted) abortController.abort()
      void result.then((outcome) => {
        if (outcome.ok && !adopted) disposeOnce(outcome.value)
      })
    },
  }
}

export function isCurrentWebRTCRoomScope<TRoom>(
  generation: number,
  currentGeneration: number,
  expectedRoom: TRoom,
  currentRoom: TRoom | null,
) {
  return generation === currentGeneration && expectedRoom === currentRoom
}

export function isCurrentWebRTCAudioAttachment<TRoom>(
  generation: number,
  currentGeneration: number,
  expectedRoom: TRoom,
  currentRoom: TRoom | null,
  attachmentVersion: number,
  currentAttachmentVersion: number,
) {
  return isCurrentWebRTCRoomScope(generation, currentGeneration, expectedRoom, currentRoom) &&
    attachmentVersion === currentAttachmentVersion
}

export function claimWebRTCStartupOwner<TOwner>(
  ownerRef: { current: TOwner | null },
  expectedOwner?: TOwner,
) {
  const owner = ownerRef.current
  if (owner === null || (expectedOwner !== undefined && owner !== expectedOwner)) return null
  ownerRef.current = null
  return owner
}

export function canCommitWebRTCActivation<TRoom, TTrack>(
  generation: number,
  currentGeneration: number,
  status: Status,
  expectedRoom: TRoom,
  currentRoom: TRoom | null,
  expectedTrack: TTrack,
  currentTrack: TTrack | null,
  publishSucceeded: boolean,
) {
  return publishSucceeded && status === 'connecting' && expectedTrack === currentTrack &&
    isCurrentWebRTCRoomScope(generation, currentGeneration, expectedRoom, currentRoom)
}

export type WebRTCActivationFailureStage = 'connection' | 'handshake' | 'commit' | 'provider'

export function canRetryWarmWebRTCActivation(
  wasWarm: boolean,
  stage: WebRTCActivationFailureStage,
  generation: number,
  currentGeneration: number,
  status: Status,
) {
  return wasWarm && (stage === 'connection' || stage === 'handshake') &&
    generation === currentGeneration && status === 'connecting'
}

export function createCancellableStartupTrack<TTrack extends { stop: () => void }>(
  createTrack: () => Promise<TTrack>,
) {
  let adopted = false
  let cancelled = false
  let stopped = false
  const result = createTrack().then(
    (track) => ({ ok: true as const, track }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  const stopOnce = (track: TTrack) => {
    if (stopped) return
    stopped = true
    track.stop()
  }

  return {
    async adopt() {
      const outcome = await result
      if (!outcome.ok) throw outcome.error
      if (cancelled) {
        stopOnce(outcome.track)
        throw new Error('WebRTC 会话启动已取消。')
      }
      adopted = true
      return outcome.track
    },
    cancel() {
      cancelled = true
      void result.then((outcome) => {
        if (outcome.ok && !adopted) stopOnce(outcome.track)
      })
    },
  }
}

export function webRTCAudioProcessingConstraints(enableEchoCancellation = true, processing = defaultBrowserAudioProcessing) {
  return {
    echoCancellation: { exact: enableEchoCancellation },
    ...processing,
  }
}

export function webRTCAudioCaptureOptions(inputDeviceId: string, enableEchoCancellation = true, processing = defaultBrowserAudioProcessing) {
  return {
    ...(inputDeviceId === 'default' ? {} : { deviceId: inputDeviceId }),
    channelCount: 1,
    ...webRTCAudioProcessingConstraints(enableEchoCancellation, processing),
  }
}

type VoiceIsolationSettings = Omit<MediaTrackSettings, 'echoCancellation'> & {
  echoCancellation?: boolean | 'all' | 'remote-only'
  voiceIsolation?: boolean
}

type ConfigurableLocalAudioTrack = Pick<LocalAudioTrack, 'applyConstraints' | 'mediaStreamTrack'>

export async function configureAndInspectWebRTCAudioTrack(
  track: ConfigurableLocalAudioTrack,
  enableEchoCancellation = true,
  processing = defaultBrowserAudioProcessing,
): Promise<AudioProcessingDiagnostics> {
  let applyConstraintsError = ''
  try {
    // LiveKit's types still expose the older boolean-only constraint shape.
    await track.applyConstraints(
      webRTCAudioProcessingConstraints(enableEchoCancellation, processing) as unknown as Parameters<ConfigurableLocalAudioTrack['applyConstraints']>[0],
    )
  } catch (caught) {
    applyConstraintsError = caught instanceof Error ? caught.message : '浏览器拒绝应用 RTC 输入音频处理约束。'
  }
  const settings = track.mediaStreamTrack.getSettings() as VoiceIsolationSettings
  return {
    echoCancellation: echoCancellationSetting(settings.echoCancellation),
    noiseSuppression: booleanSetting(settings.noiseSuppression),
    autoGainControl: booleanSetting(settings.autoGainControl),
    voiceIsolation: booleanSetting(settings.voiceIsolation),
    capturePipeline: 'script-processor',
    capturePurpose: 'rtc-local-archive',
    applyConstraintsError: applyConstraintsError || undefined,
  }
}

export function enabledWebRTCAudioProcessing(diagnostics: AudioProcessingDiagnostics) {
  return [
    ['回声消除', diagnostics.echoCancellation],
    ['降噪', diagnostics.noiseSuppression],
    ['自动增益', diagnostics.autoGainControl],
    ['语音隔离', diagnostics.voiceIsolation],
  ].filter(([, value]) => value === true || typeof value === 'string').map(([label]) => label as string)
}

export function assertWebRTCAudioProcessingDisabled(diagnostics: AudioProcessingDiagnostics) {
  if (diagnostics.echoCancellation !== false) {
    throw new Error('未确认浏览器 AEC 已关闭，已拒绝开始 WebRTC 录音；请确认浏览器允许关闭输入处理。')
  }
  const stillEnabled = enabledWebRTCAudioProcessing(diagnostics)
  if (stillEnabled.length === 0) return
  throw new Error(`浏览器仍在启用${stillEnabled.join('、')}，已拒绝开始 WebRTC 录音；请使用设备 AEC 或耳机并确认浏览器允许关闭输入处理。`)
}

export function assertWebRTCAudioProcessingMatches(
  diagnostics: AudioProcessingDiagnostics,
  enableEchoCancellation: boolean,
  processing: BrowserAudioProcessingOptions = defaultBrowserAudioProcessing,
) {
  // Explicitly requested processing is allowed; unsupported optional features are
  // reported by getSettings, not treated as a fatal capture error.
  const checked = {
    ...diagnostics,
    noiseSuppression: processing.noiseSuppression || processing.voiceIsolation ? false : diagnostics.noiseSuppression,
    autoGainControl: processing.autoGainControl ? false : diagnostics.autoGainControl,
    voiceIsolation: processing.voiceIsolation ? false : diagnostics.voiceIsolation,
  }
  if (!enableEchoCancellation) {
    assertWebRTCAudioProcessingDisabled(checked)
    return
  }
  if (diagnostics.echoCancellation !== true && typeof diagnostics.echoCancellation !== 'string') {
    throw new Error('未确认浏览器 AEC 已开启，已拒绝开始 WebRTC 录音。')
  }
  const unexpectedlyEnabled = [
    ['降噪', checked.noiseSuppression],
    ['自动增益', checked.autoGainControl],
    ['语音隔离', checked.voiceIsolation],
  ].filter(([, value]) => value === true).map(([label]) => label as string)
  if (unexpectedlyEnabled.length > 0) {
    throw new Error(`浏览器仍在启用未请求的${unexpectedlyEnabled.join('、')}，已拒绝开始 WebRTC 录音。`)
  }
}

export function assertWebRTCAudioProcessingMatchesOrStop(
  track: Pick<LocalAudioTrack, 'stop'>,
  diagnostics: AudioProcessingDiagnostics,
  enableEchoCancellation: boolean,
  processing = defaultBrowserAudioProcessing,
) {
  try {
    assertWebRTCAudioProcessingMatches(diagnostics, enableEchoCancellation, processing)
  } catch (caught) {
    try {
      track.stop()
    } catch {
      // Preserve the processing mismatch as the actionable startup error.
    }
    throw caught
  }
}

export async function waitForBridgeHandshake(
  room: BridgeReadyRoom,
  bridgeReady: Promise<void>,
  sessionId: string,
  agentParticipantSeen: () => boolean,
  timeoutMs = 15_000,
  retryMs = 200,
  action: 'ready_probe' | 'start' = 'ready_probe',
) {
  let settled = false
  const deadline = Date.now() + timeoutMs
  const probe = async () => {
    while (!settled && Date.now() < deadline) {
      try {
        await room.localParticipant.publishData(
          encoder.encode(JSON.stringify({ action, sessionId })),
          { reliable: true, topic: CONTROL_TOPIC },
        )
      } catch {
        // The Agent or publisher data channel may still be joining. Retry until the shared deadline.
      }
      if (!settled) await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
    if (!settled) {
      throw new Error(agentParticipantSeen()
        ? 'S2ST Agent 已加入房间，但 Ready 握手未完成。'
        : 'S2ST Agent 未在 15 秒内加入房间。')
    }
  }
  try {
    await Promise.race([
      bridgeReady.then(() => { settled = true }),
      probe(),
    ])
  } finally {
    settled = true
  }
}

export function useLiveKitRealtimeSession(options: RealtimeSessionOptions): RealtimeSession {
  const {
    provider, asrProvider, transport = 'websocket', model, sourceLanguage, targetLanguage, effectiveVoiceClone, selectedVoice, deepFilterNet, qwen3ModelIntervalMs, vadLoudnessMode, vadLoudnessThresholdDbfs, ready, notReadyReason,
    inputDeviceId, outputDeviceId, webRTCEchoCancellation = true, browserAudioProcessing,
    refreshAudioDevices, onSessionRecorded,
  } = options
  const service: RealtimeService = options.service || (
    transport === 'webrtc' ? 'livekit' : 'websocket'
  )
  const runtime = useSessionRuntime({ onSessionRecorded })
  const {
    status, error, completionWarning, sourceText, translation, modelOutputTranslation, sourceSegments, translationSegments,
    translationDisplayUnits, playingTranslationSegmentId, audioSegments,
    providerLagSamples, synthesisDurationSamples, sentenceDiagnostics, diagnosticEvents, observability, trace, stability, engineLatency,
    browserLatency, ttsWarning, audioProcessingDiagnostics, firstTextLatency, elapsed,
    inputAudioURL, audioURL, streamingAudio, playbackIncomplete, audioArchiveSkipped, outputAudioRef,
    setStatus, setError, setCompletionWarning, setSourceText, setTranslation, setModelOutputTranslation, setSourceSegments,
    setTranslationSegments, setTranslationDisplayUnits, setPlayingTranslationSegmentId,
    setProviderLagSamples, setSynthesisDurationSamples, setSentenceDiagnostics,
    setEngineLatency, setInputAudioURL, setAudioURL,
    setAudioProcessingDiagnostics, setFirstTextLatency, setStreamingAudio,
    setAudioArchiveSkipped, inputAudioRef, rtcStatsRef, inputAudioBytesRef, inputAudioArchiveSkippedRef,
    outputAudioBytesRef, outputAudioSampleRateRef, audioArchiveSkippedRef, playerRef,
    startedAtRef, audioTimelineStartedAtRef, firstAudioReceivedAtRef,
    firstAudioPlaybackAtRef, engineLatencyRef, browserLatencyRef, serverClockSyncRef,
    firstModelSubmitUnixUsRef, firstTTSReadyUnixUsRef, firstTextSeenRef, firstTextLatencyRef,
    firstAudioByteSeenRef, firstAudioByteLatencyRef, firstAudioPlaybackSeenRef,
    firstAudioPlaybackLatencyRef, sourceTextRef, translationRef, modelOutputTranslationRef, sourceSegmentsRef,
    translationSegmentsRef, translationDisplayUnitsRef, providerLagSamplesRef,
    synthesisDurationSamplesRef, sentenceDiagnosticsRef, sessionMetaRef, sessionGenerationRef,
    statusRef, startInFlightRef, resetSessionState, recordHistory,
    resetProcessingWatchdog, armProcessingWatchdog, noteProcessingProgress,
    markProcessingDeliverable, resetProcessingPreviewEvidence,
    claimProcessingTerminal,
    setFailure, recordBrowserLatency, recordDiagnosticEvent, updateObservability, clearProcessingTimeout, markTrace, markTraceOnce,
    markTraceAt, markDisconnect, markReconnectAttempt, markConnectionRestored, markOutputActivity, recordNoOutputTimeout, updateCrossDomainLatency,
    resetTraceForNewSession,
  } = runtime

  const roomRef = useRef<Room | null>(null)
  const preparedStartupRef = useRef<{
    key: string
    startup: {
      peek: () => PreparedLiveKitSession | null
      adopt: () => Promise<PreparedLiveKitSession>
      cancel: () => void
    }
  } | null>(null)
  const startingPreparationRef = useRef<{
    generation: number
    startup: {
      peek: () => PreparedLiveKitSession | null
      adopt: () => Promise<PreparedLiveKitSession>
      cancel: () => void
    }
  } | null>(null)
  const activationOwnerRef = useRef<WebRTCActivationOwner | null>(null)
  const localTrackStartupOwnerRef = useRef<WebRTCLocalTrackStartupOwner | null>(null)
  const localTrackRef = useRef<LocalAudioTrack | null>(null)
  const collectorRef = useRef<ReturnType<typeof createRTCStatsCollector> | null>(null)
  // Finalize the WebRTC stats collector into rtcStatsRef. Called before recordHistory
  // on the record paths (so the archive captures the samples) and in cleanup() as the
  // leak-safety net for teardown-only paths (StrictMode unmount, startup cancellation).
  const finalizeRtcStats = () => {
    if (collectorRef.current) {
      rtcStatsRef.current = collectorRef.current.stop()
      collectorRef.current = null
    }
  }
  const inputArchiveControllerRef = useRef<WebRTCInputArchiveController | null>(null)
  const outputControllerRef = useRef<WebRTCOutputAudioController | null>(null)
  const outputAttachmentVersionRef = useRef(0)
  const outputEvidenceRef = useRef<WebRTCOutputEvidence>(emptyWebRTCOutputEvidence())
  const nativePlaybackStartedRef = useRef(false)
  const outputSignalSeenRef = useRef(false)
  const expectedDisconnectRef = useRef(false)
  const finishingRef = useRef(false)
  const lastAudioChunkAtRef = useRef(0)
  const bridgeReadyRef = useRef<(() => void) | null>(null)
  const activeSessionRef = useRef<LiveKitSessionResponse | null>(null)
  const agentParticipantSeenRef = useRef(false)
  const cumulativeSourceRef = useRef<CumulativeTranscriptState>(emptyCumulativeTranscriptState())
  const vadTranscriptStateRef = useRef<VadTranscriptPairState>(emptyVadTranscriptPairState())
  const [vadTranscriptPairs, setVadTranscriptPairs] = useState<VadTranscriptPair[]>([])
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false)
  const bridgeFirstInputToFirstOutputMsRef = useRef<number | null>(null)
  const activeBridgeAudioSegmentIdRef = useRef<string | null>(null)
  const bridgePlaybackQueueRef = useRef<BridgePlaybackMarker[]>([])
  const bridgePlaybackLastSequenceRef = useRef(0)
  // Distinct playout segment ids in sequence order, used to attribute playback
  // highlight onto the matching sentence unit (see attributePlayoutSegmentsToUnits).
  const bridgePlayoutOrderRef = useRef<string[]>([])
  const bridgePlaybackHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preparationKey = `${provider}\u0000${asrProvider}\u0000${sourceLanguage}\u0000${targetLanguage}\u0000${effectiveVoiceClone}\u0000${selectedVoice}\u0000${deepFilterNet}\u0000${qwen3ModelIntervalMs}\u0000${vadLoudnessMode}\u0000${vadLoudnessThresholdDbfs}\u0000${options.qwen3SimulSystemPrompt || ''}\u0000${options.asrContext || ''}\u0000${options.asrContextOverride === true}`

  const recordSentenceDiagnostic = (
    segmentId: string | undefined,
    patch: Parameters<typeof upsertSentenceDiagnostic>[2],
  ) => {
    const next = upsertSentenceDiagnostic(sentenceDiagnosticsRef.current, segmentId, patch)
    if (next === sentenceDiagnosticsRef.current) return
    sentenceDiagnosticsRef.current = next
    setSentenceDiagnostics(next)
  }

  const clearBridgePlaybackHighlight = () => {
    if (bridgePlaybackHighlightTimerRef.current !== null) {
      clearTimeout(bridgePlaybackHighlightTimerRef.current)
      bridgePlaybackHighlightTimerRef.current = null
    }
    bridgePlaybackQueueRef.current = []
    bridgePlaybackLastSequenceRef.current = 0
    bridgePlayoutOrderRef.current = []
    activeBridgeAudioSegmentIdRef.current = null
    setPlayingTranslationSegmentId(null)
  }

  const startNextBridgePlaybackHighlight = (generation: number) => {
    if (!canStartBridgePlaybackHighlight(
      generation,
      sessionGenerationRef.current,
      activeBridgeAudioSegmentIdRef.current,
      nativePlaybackStartedRef.current,
      outputSignalSeenRef.current,
    )) return
    const marker = bridgePlaybackQueueRef.current.shift()
    if (!marker) return
    activeBridgeAudioSegmentIdRef.current = marker.providerSegmentId
    setPlayingTranslationSegmentId(marker.providerSegmentId)
    console.info('[s2st-webrtc]', {
      stage: 'playback_highlight_started',
      sessionId: activeSessionRef.current?.sessionId,
      segmentId: marker.providerSegmentId,
      sequence: marker.sequence,
      durationMs: marker.durationMs,
      pendingSegments: bridgePlaybackQueueRef.current.length,
    })
    bridgePlaybackHighlightTimerRef.current = setTimeout(() => {
      if (
        generation !== sessionGenerationRef.current ||
        activeBridgeAudioSegmentIdRef.current !== marker.providerSegmentId
      ) return
      bridgePlaybackHighlightTimerRef.current = null
      activeBridgeAudioSegmentIdRef.current = null
      setPlayingTranslationSegmentId(null)
      startNextBridgePlaybackHighlight(generation)
    }, marker.durationMs)
  }

  const enqueueBridgePlaybackHighlight = (event: BridgeEvent, generation: number) => {
    const marker = nextBridgePlaybackMarker(event, bridgePlaybackLastSequenceRef.current)
    if (!marker) return
    bridgePlaybackLastSequenceRef.current = marker.sequence
    bridgePlaybackQueueRef.current.push(marker)
    if (!bridgePlayoutOrderRef.current.includes(marker.providerSegmentId)) {
      bridgePlayoutOrderRef.current = [...bridgePlayoutOrderRef.current, marker.providerSegmentId]
      const nextUnits = attributePlayoutSegmentsToUnits(
        translationDisplayUnitsRef.current,
        bridgePlayoutOrderRef.current,
      )
      if (nextUnits !== translationDisplayUnitsRef.current) {
        translationDisplayUnitsRef.current = nextUnits
        setTranslationDisplayUnits(nextUnits)
      }
    }
    startNextBridgePlaybackHighlight(generation)
  }

  // The VUILabs relay emits a clean cumulative `model_output` alongside the
  // fragile per-word `translation` reassembly, and the word-join can scramble
  // (e.g. "Test, test." torn across rows). Treat model_output as the text of
  // record so the display units, timed rows, finalize and persistence all agree
  // with the streaming panel instead of the scrambled join. Provider audio
  // windows still arrive via translation events and attach to their sentence.
  const applyBridgeTranslation = (
    bridgeText: string,
    arrivalMs: number | undefined,
    providerSegment?: {
      segmentId?: string
      segmentText?: string
      startMs?: number
      endMs?: number
    },
  ): { newlyConfirmedUnits: TranslationDisplayUnit[] } => {
    const authoritativeText = selectStreamingTranslationSnapshot(
      modelOutputTranslationRef.current,
      bridgeText,
    )
    if (!authoritativeText.trim()) return { newlyConfirmedUnits: [] }

    const previousUnits = translationDisplayUnitsRef.current
    const nextUnits = attributePlayoutSegmentsToUnits(
      bridgeSentenceUnits(authoritativeText, false),
      bridgePlayoutOrderRef.current,
    )
    const newlyConfirmedUnits = nextUnits.filter((unit) => (
      !previousUnits.some((previous) => previous.id === unit.id && previous.text === unit.text)
    ))
    translationDisplayUnitsRef.current = nextUnits
    setTranslationDisplayUnits(nextUnits)
    translationRef.current = authoritativeText
    setTranslation(authoritativeText)

    const nextSegments = reconcileStreamingTranslationSegments(
      translationSegmentsRef.current,
      authoritativeText,
      arrivalMs,
      'webrtc-translation-sentence',
      providerSegment?.segmentId,
      providerSegment?.segmentText,
      providerSegment?.startMs,
      providerSegment?.endMs,
    )
    translationSegmentsRef.current = nextSegments
    setTranslationSegments(nextSegments)
    return { newlyConfirmedUnits }
  }

  const updateBridgeOutputToPlaybackLatency = () => {
    if (engineLatencyRef.current.ttsReadyToFirstPlaybackMs !== null) return
    const value = deriveBridgeOutputToPlaybackMs(
      firstAudioPlaybackLatencyRef.current,
      bridgeFirstInputToFirstOutputMsRef.current,
    )
    if (value === null) return
    const next = { ...engineLatencyRef.current, ttsReadyToFirstPlaybackMs: value }
    engineLatencyRef.current = next
    setEngineLatency(next)
  }

  const recordFirstStableTranslation = (receivedAt: number, newlyConfirmedUnitCount: number) => {
    const current = browserLatencyRef.current.captureToFirstStableSentenceMs
    const next = nextFirstStableTranslationLatency(
      current,
      startedAtRef.current,
      receivedAt,
      newlyConfirmedUnitCount,
    )
    if (current !== null || next === null) return
    recordBrowserLatency('captureToFirstStableSentenceMs', next)
    markTraceAt('firstStableTranslation', receivedAt)
  }

  const cancelPreparedSession = async (session: LiveKitSessionResponse) => {
    await apiFetch('/api/webrtc/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', token: session.token }),
      keepalive: true,
    }, session.traceContext).catch(() => undefined)
  }

  const activatePreparedSession = async (session: LiveKitSessionResponse) => {
    const response = await apiFetch('/api/webrtc/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'activate', token: session.token }),
    }, session.traceContext)
    const result = await response.json() as { error?: string }
    if (!response.ok) {
      throw new Error(result.error || `激活 WebRTC 会话失败 (${response.status})`)
    }
  }

  const commitPreparedSession = async (session: LiveKitSessionResponse) => {
    const response = await apiFetch('/api/webrtc/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commit', token: session.token }),
    }, session.traceContext)
    const result = await response.json() as { error?: string }
    if (!response.ok) {
      throw new Error(result.error || `确认 WebRTC 会话激活失败 (${response.status})`)
    }
  }

  const disposePreparedSession = async (prepared: PreparedLiveKitSession) => {
    prepared.detachStandbyListener()
    await Promise.all([
      prepared.room.disconnect().catch(() => undefined),
      cancelPreparedSession(prepared.session),
    ])
  }

  const createPreparedStartup = (warmAhead: boolean) => createCancellableWebRTCPreparation(
    async (signal): Promise<PreparedLiveKitSession> => {
      const preparationStartedAt = performance.now()
      // Warm the page-level clock-sync cache while the room is on standby so
      // the click path never waits on the 7-sample /api/time exchange.
      void ensureServerClockSync().catch(() => undefined)
      const traceContext = createApiTraceContext()
      let session: (LiveKitSessionResponse & { error?: string }) | null = null
      let prepared: PreparedLiveKitSession | null = null
      try {
        // React StrictMode runs the first effect setup/cleanup synchronously. Deferring the
        // network side effect lets that cleanup abort before a duplicate room is created.
        await deferWebRTCPreparation(signal)
        throwIfWebRTCPreparationAborted(signal)
        const [response, liveKit] = await loadWebRTCStartupDependencies(
          () => apiFetch('/api/webrtc/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'prepare', provider, asrProvider, sourceLanguage, targetLanguage,
              asrContext: options.asrContext,
              asrContextOverride: options.asrContextOverride,
              voiceClone: effectiveVoiceClone,
              voice: effectiveVoiceClone ? '' : selectedVoice,
              deepFilterNet, qwen3ModelIntervalMs, vadLoudnessThresholdDbfs,
              qwen3SimulSystemPrompt: options.qwen3SimulSystemPrompt,
              vadLoudnessMode, asrUseFilteredAudio: true,
            }),
            signal,
          }, traceContext),
          () => import('livekit-client'),
        )
        throwIfWebRTCPreparationAborted(signal)
        session = await response.json() as LiveKitSessionResponse & { error?: string }
        session.traceContext = traceContext
        if (!response.ok) throw new Error(session.error || `准备 WebRTC 会话失败 (${response.status})`)
        throwIfWebRTCPreparationAborted(signal)
        const room = new liveKit.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true })
        const validForSeconds = Math.max(5, Number(session.prepareExpiresInSeconds) || 60)
        let standbySeen = false
        const handleStandbyData = (
          payload: Uint8Array,
          participant: BridgeParticipant | undefined,
          _kind: unknown,
          topic?: string,
        ) => {
          if (topic !== EVENT_TOPIC) return
          try {
            const event = JSON.parse(decoder.decode(payload)) as BridgeEvent
            if (
              event.type !== 'standby_ready' || event.sessionId !== session?.sessionId ||
              (participant && participant.kind !== liveKit.ParticipantKind.AGENT && !participant.identity.startsWith('agent-'))
            ) return
            standbySeen = true
            console.info('[s2st-webrtc]', {
              stage: 'agent_standby_ready',
              sessionId: session?.sessionId,
            })
          } catch {
            // The active listener validates and reports malformed bridge events after startup.
          }
        }
        room.on(liveKit.RoomEvent.DataReceived, handleStandbyData)
        prepared = {
          session,
          liveKit,
          room,
          expiresAt: Date.now() + validForSeconds * 1000,
          connected: false,
          standbySeen: () => standbySeen,
          detachStandbyListener: () => {
            room.off(liveKit.RoomEvent.DataReceived, handleStandbyData)
          },
        }
        signal.addEventListener('abort', () => { void room.disconnect() }, { once: true })
        if (warmAhead) {
          await room.prepareConnection(session.livekitUrl, session.token)
          throwIfWebRTCPreparationAborted(signal)
          await room.connect(session.livekitUrl, session.token, { autoSubscribe: true })
          throwIfWebRTCPreparationAborted(signal)
          prepared.connected = true
        }
      } catch (caught) {
        if (prepared) {
          await disposePreparedSession(prepared)
        } else if (session?.token) {
          await cancelPreparedSession(session)
        }
        throw caught
      }
      throwIfWebRTCPreparationAborted(signal)
      console.info('[s2st-webrtc]', {
        stage: warmAhead ? 'connection_prepared' : 'session_prepared_on_demand',
        sessionId: prepared.session.sessionId,
        elapsedMs: Math.round(performance.now() - preparationStartedAt),
      })
      return prepared
    },
    disposePreparedSession,
  )

  const cleanup = async (preserveStartingGeneration?: number) => {
    const startingPreparation = startingPreparationRef.current
    if (
      startingPreparation &&
      startingPreparation.generation !== preserveStartingGeneration
    ) {
      startingPreparationRef.current = null
      startingPreparation.startup.cancel()
    }
    expectedDisconnectRef.current = true
    const localTrackStartupOwner = claimWebRTCStartupOwner(localTrackStartupOwnerRef)
    localTrackStartupOwner?.startup.cancel()
    const activationOwner = claimWebRTCStartupOwner(activationOwnerRef)
    // Start the keepalive cancellation before the first cleanup await so unload cannot strand
    // an ACTIVATING room behind a pending microphone prompt or commit response.
    const activationDisposal = activationOwner
      ? disposePreparedSession(activationOwner.prepared)
      : null
    clearBridgePlaybackHighlight()
    outputAttachmentVersionRef.current++
    const inputArchiveController = inputArchiveControllerRef.current
    inputArchiveControllerRef.current = null
    const outputController = outputControllerRef.current
    outputControllerRef.current = null
    nativePlaybackStartedRef.current = false
    outputEvidenceRef.current = emptyWebRTCOutputEvidence()
    setAudioPlaybackBlocked(false)
    const localTrack = localTrackRef.current
    localTrackRef.current = null
    const player = playerRef.current
    playerRef.current = null
    const room = roomRef.current
    roomRef.current = null
    activeSessionRef.current = null
    agentParticipantSeenRef.current = false
    finalizeRtcStats()
    localTrack?.stop()
    const cleanupResult = await settleWebRTCCleanup([
      () => inputArchiveController?.stop(),
      () => outputController?.detach(),
      () => player?.close(),
      () => room && room !== activationOwner?.prepared.room ? room.disconnect() : undefined,
      () => activationDisposal,
    ])
    if (cleanupResult.cleanupTimedOut || cleanupResult.cleanupErrors.length > 0) {
      console.warn('[s2st-webrtc]', {
        stage: 'cleanup_degraded',
        timedOut: cleanupResult.cleanupTimedOut,
        errors: cleanupResult.cleanupErrors.map((caught) => (
          caught instanceof Error ? caught.message : String(caught)
        )),
      })
    }
  }

  useEffect(() => {
    const canPrepare = canPrewarmLiveKitSession(service, ready, status)
    if (!canPrepare) return
    const existing = preparedStartupRef.current
    if (existing?.key === preparationKey) return
    existing?.startup.cancel()
    let activeEntry: NonNullable<typeof preparedStartupRef.current> | null = null
    let expiryTimer: ReturnType<typeof setTimeout> | null = null
    const arm = (cycle: number) => {
      const entry = { key: preparationKey, startup: createPreparedStartup(true) }
      activeEntry = entry
      preparedStartupRef.current = entry
      expiryTimer = setTimeout(() => {
        if (preparedStartupRef.current !== entry) return
        preparedStartupRef.current = null
        entry.startup.cancel()
        if (cycle < PREPARED_SESSION_REARM_LIMIT) {
          console.info('[s2st-webrtc]', { stage: 'standby_rearmed', cycle: cycle + 1 })
          arm(cycle + 1)
          return
        }
        console.info('[s2st-webrtc]', { stage: 'standby_expired' })
      }, PREPARED_SESSION_MAX_AGE_MS)
    }
    arm(0)
    return () => {
      if (expiryTimer !== null) clearTimeout(expiryTimer)
      if (!activeEntry || preparedStartupRef.current !== activeEntry) return
      preparedStartupRef.current = null
      activeEntry.startup.cancel()
    }
  }, [preparationKey, ready, service, status])

  useEffect(() => () => {
    sessionGenerationRef.current++
    const prepared = preparedStartupRef.current
    preparedStartupRef.current = null
    prepared?.startup.cancel()
    const startingPreparation = startingPreparationRef.current
    startingPreparationRef.current = null
    startingPreparation?.startup.cancel()
    void cleanup()
  }, [])

  const failSession = (
    message: string,
    category: string,
    generation: number,
    terminalClaimed = false,
  ) => {
    if (!canFailWebRTCSession(generation, sessionGenerationRef.current, statusRef.current)) return
    if (!terminalClaimed && !claimProcessingTerminal(generation, 'failed')) return
    clearProcessingTimeout()
    if (category === 'no_output_timeout') recordNoOutputTimeout()
    setFailure(message, category)
    markTrace('failed')
    setError(message)
    setStreamingAudio(false)
    statusRef.current = 'error'
    setStatus('error')
    finalizeRtcStats()
    recordHistory('error')
    void cleanup()
  }

  const handleBridgeEvent = (
    event: BridgeEvent,
    generation: number,
  ) => {
    if (generation !== sessionGenerationRef.current || statusRef.current === 'error' || statusRef.current === 'finished') return
    const receivedAt = performance.now()
    const eventTextChars = (event.segmentText || event.text || '').length
    if (event.type !== 'source_update' || eventTextChars <= 1) {
      console.info('[s2st-webrtc]', {
        stage: 'bridge_event_received',
        eventType: event.type,
        eventSchemaVersion: event.eventSchemaVersion,
        agentBuildSha: event.agentBuildSha,
        sessionId: activeSessionRef.current?.sessionId,
        captureElapsedMs: startedAtRef.current > 0
          ? Math.round(receivedAt - startedAtRef.current)
          : null,
        textChars: eventTextChars,
      })
    }
    const receivedAtMs = audioTimelineStartedAtRef.current > 0
      ? Math.max(0, receivedAt - audioTimelineStartedAtRef.current)
      : undefined
    recordDiagnosticEvent('agent', event.type, event.segmentId, event, receivedAtMs)
    const processingActions = {
      noteProgress: noteProcessingProgress,
      markDeliverable: markProcessingDeliverable,
      resetPreview: resetProcessingPreviewEvidence,
    }
    applyWebRTCProcessingEventEvidence(event, generation, processingActions)
    const nextVadTranscriptState = reduceVadTranscriptPairEvent(vadTranscriptStateRef.current, event)
    if (nextVadTranscriptState !== vadTranscriptStateRef.current) {
      vadTranscriptStateRef.current = nextVadTranscriptState
      setVadTranscriptPairs(nextVadTranscriptState.pairs)
    }
    const sourceVadStartMs = sourceVadStartMsForEvent(nextVadTranscriptState.pairs, event)
    const providerLagMs = numberValue(event.providerLagMs)
    if (providerLagMs !== undefined && providerLagMs >= 0) {
      const samples = upsertNativeMetricSample(providerLagSamplesRef.current, event.segmentId, providerLagMs)
      providerLagSamplesRef.current = samples
      setProviderLagSamples(samples)
    }
    const synthesisDurationMs = numberValue(event.synthesisDurationMs)
    if (synthesisDurationMs !== undefined && synthesisDurationMs >= 0) {
      const samples = upsertNativeMetricSample(synthesisDurationSamplesRef.current, event.segmentId, synthesisDurationMs)
      synthesisDurationSamplesRef.current = samples
      setSynthesisDurationSamples(samples)
    }
    if (event.type === 'bridge_ready') {
      bridgeReadyRef.current?.()
      bridgeReadyRef.current = null
      markTraceOnce('providerConnected')
      return
    }
    if (event.type === 'started') {
      markTraceOnce('providerReady')
      return
    }
    const lifecycleTraceKey = bridgeLifecycleTraceKey(event.type)
    if (lifecycleTraceKey) {
      markTraceAt(lifecycleTraceKey, receivedAt)
      return
    }
    if (event.type === 'audio_playout_started') {
      const marker = bridgePlaybackMarker(event)
      const scheduledPlaybackAtMs = marker
        ? bridgeScheduledPlaybackAtMs(
          firstAudioPlaybackLatencyRef.current,
          marker.mediaStartSample,
          marker.mediaSampleRateHz,
        )
        : null
      recordSentenceDiagnostic(event.segmentId, {
        providerAudioStartMs: numberValue(event.startMs, event.start_ms),
        providerAudioEndMs: numberValue(event.endMs, event.end_ms),
        providerLagMs,
        synthesisDurationMs,
        engineFirstModelTokenMs: numberValue(event.engineFirstModelTokenMs),
        engineModelFeedToStableTextMs: numberValue(event.engineModelFeedToStableTextMs),
        engineModelFeedToTTSReadyMs: numberValue(event.engineModelFeedToTTSReadyMs),
        agentPlayoutStartedAtMs: startedAtRef.current > 0
          ? Math.max(0, receivedAt - startedAtRef.current)
          : undefined,
        audioDurationMs: event.durationMs,
        agentQueueWaitMs: event.queueWaitMs,
        playbackSequence: event.sequence,
        agentMediaStartSample: marker?.mediaStartSample,
        agentMediaEndSample: marker?.mediaEndSample,
        agentMediaSampleRateHz: marker?.mediaSampleRateHz,
        agentFirstFrameSequence: marker?.firstFrameSequence,
        playbackStartedAtMs: scheduledPlaybackAtMs ?? undefined,
        playbackTimingSource: scheduledPlaybackAtMs === null ? undefined : 'browser_scheduled',
      })
      enqueueBridgePlaybackHighlight(event, generation)
      return
    }
    if (event.type === 'model_output' && event.text) {
      markOutputActivity()
      modelOutputTranslationRef.current = event.text
      setModelOutputTranslation(event.text)
      // model_output is the authoritative translation text; refresh the display
      // units and timed rows so they track it without waiting for a (scramble-
      // prone) translation event. Provider audio windows attach later.
      applyBridgeTranslation(event.text, receivedAtMs)
      if (event.modelOutputStable && !firstTextSeenRef.current && startedAtRef.current > 0) {
        const latency = Math.max(0, receivedAt - startedAtRef.current)
        firstTextSeenRef.current = true
        firstTextLatencyRef.current = latency
        setFirstTextLatency(latency)
        recordBrowserLatency('captureToFirstTextMs', latency)
        markTraceOnce('firstTranslation')
      }
      return
    }
    if (
      event.type === 'translation' || event.type === 'translation_done' ||
      event.type === 'translation_update' || event.type === 'translation_delta'
    ) {
      const currentTranslation = {
        text: translationRef.current,
        units: translationDisplayUnitsRef.current,
      }
      const nextTranslation = reconcileBridgeTranslation(currentTranslation, event)
      if (nextTranslation === currentTranslation) return
      recordSentenceDiagnostic(event.segmentId, {
        textReceivedAtMs: startedAtRef.current > 0
          ? Math.max(0, receivedAt - startedAtRef.current)
          : undefined,
        textStableAtMs: event.type === 'translation_done' || event.type === 'translation'
          ? startedAtRef.current > 0
            ? Math.max(0, receivedAt - startedAtRef.current)
            : undefined
          : undefined,
        providerAudioStartMs: numberValue(event.startMs, event.start_ms),
        providerAudioEndMs: numberValue(event.endMs, event.end_ms),
        providerLagMs,
        synthesisDurationMs,
        engineFirstModelTokenMs: numberValue(event.engineFirstModelTokenMs),
        engineModelFeedToStableTextMs: numberValue(event.engineModelFeedToStableTextMs),
        engineModelFeedToTTSReadyMs: numberValue(event.engineModelFeedToTTSReadyMs),
      })
      markOutputActivity()
      if (
        !firstTextSeenRef.current
        && startedAtRef.current > 0
        && (event.type === 'translation_done' || event.type === 'translation')
      ) {
        const latency = Math.max(0, receivedAt - startedAtRef.current)
        firstTextSeenRef.current = true
        firstTextLatencyRef.current = latency
        setFirstTextLatency(latency)
        recordBrowserLatency('captureToFirstTextMs', latency)
        markTraceOnce('firstTranslation')
      }
      const { newlyConfirmedUnits } = applyBridgeTranslation(
        nextTranslation.text,
        receivedAtMs,
        {
          segmentId: event.segmentId,
          segmentText: event.segmentText,
          startMs: numberValue(event.startMs, event.start_ms),
          endMs: numberValue(event.endMs, event.end_ms),
        },
      )
      recordFirstStableTranslation(receivedAt, newlyConfirmedUnits.length)
      return
    }
    if (
      event.type === 'source' || event.type === 'transcription' ||
      event.type === 'source_done' || event.type === 'source_update' || event.type === 'source_delta'
    ) {
      const stableSegmentEvent = event.type === 'source' || event.type === 'transcription'
      const segmentText = (event.segmentText || event.text || '').trim()
      const snapshot = nextBridgeSourceSnapshot(cumulativeSourceRef.current.snapshot, event)
      if (!snapshot) return
      markOutputActivity()
      markTraceOnce('firstSource')
      const sessionScope = activeSessionRef.current?.sessionId || `generation-${generation}`
      const nextSource = reconcileCumulativeTranscript(cumulativeSourceRef.current, {
        text: snapshot,
        done: event.type === 'source_done' || stableSegmentEvent,
        segmentId: event.segmentId || (event.index !== undefined ? String(event.index) : undefined),
        segmentText: event.type === 'source_done' || stableSegmentEvent ? segmentText : undefined,
        startMs: numberValue(event.startMs, event.start_ms),
        endMs: numberValue(event.endMs, event.end_ms),
        receivedAtMs,
        inputAudioStartMs: sourceVadStartMs,
      }, `${sessionScope}:source`)
      cumulativeSourceRef.current = nextSource
      sourceTextRef.current = nextSource.snapshot
      setSourceText(nextSource.snapshot)
      const nextSegments = cumulativeTranscriptSegments(nextSource)
      sourceSegmentsRef.current = nextSegments
      setSourceSegments(nextSegments)
      return
    }
    if (event.type === 'session_metrics') {
      const firstModelSubmitUnixUs = numberValue(
        event.engineFirstModelSubmitUnixUs,
        event.latency?.engineFirstModelSubmitUnixUs,
        event.latency?.engine_first_model_submit_unix_us,
      )
      const firstTTSReadyUnixUs = numberValue(
        event.engineFirstTTSReadyUnixUs,
        event.latency?.engineFirstTTSReadyUnixUs,
        event.latency?.engine_first_tts_ready_unix_us,
      )
      if (firstModelSubmitUnixUs !== undefined && firstModelSubmitUnixUs > 0) {
        firstModelSubmitUnixUsRef.current = firstModelSubmitUnixUs
      }
      if (firstTTSReadyUnixUs !== undefined && firstTTSReadyUnixUs > 0) {
        firstTTSReadyUnixUsRef.current = firstTTSReadyUnixUs
      }
      const next = mergeBridgeEngineLatency(engineLatencyRef.current, event)
      const bridgeFirstInputToFirstOutputMs = numberValue(event.bridgeFirstInputToFirstOutputMs)
      if (bridgeFirstInputToFirstOutputMs !== undefined && bridgeFirstInputToFirstOutputMs >= 0) {
        bridgeFirstInputToFirstOutputMsRef.current = bridgeFirstInputToFirstOutputMs
      }
      engineLatencyRef.current = next
      setEngineLatency(next)
      updateCrossDomainLatency()
      updateBridgeOutputToPlaybackLatency()
      console.info('[s2st-webrtc]', {
        stage: 'session_metrics_applied',
        sessionId: activeSessionRef.current?.sessionId,
        engineLatency: engineLatencyRef.current,
        firstModelSubmitUnixUs: firstModelSubmitUnixUsRef.current || null,
        firstTTSReadyUnixUs: firstTTSReadyUnixUsRef.current || null,
        bridgeFirstInputToFirstOutputMs: bridgeFirstInputToFirstOutputMsRef.current,
      })
      const warning = (event.ttsError || event.tts_error || '').trim()
      if (warning) runtime.setTTSWarning(warning)
      return
    }
    if (event.type === 'tts_error') {
      runtime.setTTSWarning((event.ttsError || event.tts_error || event.message || 'TTS 生成失败').trim())
      return
    }
    if (event.type === 'asr_error') {
      runtime.setCompletionWarning(`原文识别不可用：${event.error || event.message || 'ASR 服务返回错误。'}`)
      return
    }
    if (event.type === 'completed') {
      const currentSource = cumulativeSourceRef.current
      if (currentSource.snapshot) {
        const sessionScope = activeSessionRef.current?.sessionId || `generation-${generation}`
        const finalizedSource = reconcileCumulativeTranscript(currentSource, {
          text: currentSource.snapshot,
          done: true,
          receivedAtMs,
        }, `${sessionScope}:source`)
        cumulativeSourceRef.current = finalizedSource
        const finalizedSegments = cumulativeTranscriptSegments(finalizedSource)
        sourceSegmentsRef.current = finalizedSegments
        setSourceSegments(finalizedSegments)
      }
      const finalizedTranslation = finalizeBridgeTranslation({
        text: translationRef.current,
        units: translationDisplayUnitsRef.current,
      })
      const newlyConfirmedUnits = finalizedTranslation.units.filter((unit) => (
        !translationDisplayUnitsRef.current.some((currentUnit) => (
          currentUnit.id === unit.id && currentUnit.text === unit.text
        ))
      ))
      recordFirstStableTranslation(receivedAt, newlyConfirmedUnits.length)
      translationRef.current = finalizedTranslation.text
      setTranslation(finalizedTranslation.text)
      const finalizedUnitsWithMembers = attributePlayoutSegmentsToUnits(
        finalizedTranslation.units,
        bridgePlayoutOrderRef.current,
      )
      translationDisplayUnitsRef.current = finalizedUnitsWithMembers
      setTranslationDisplayUnits(finalizedUnitsWithMembers)
      const finalizedSegments = reconcileStreamingTranslationSegments(
        translationSegmentsRef.current,
        finalizedTranslation.text,
        receivedAtMs,
        'webrtc-translation-sentence',
      )
      translationSegmentsRef.current = finalizedSegments
      setTranslationSegments(finalizedSegments)
      void finishSession(generation)
      return
    }
    if (event.type === 'error' || event.type === 'bridge_error') {
      failSession(event.message || event.error || 'WebRTC 翻译服务返回错误。', 'service_error', generation)
    }
  }

  const attachRoomListeners = (
    room: Room,
    generation: number,
    liveKit: LiveKitModule,
    onActivationDisconnected: () => void,
  ) => {
    const scopeCurrent = () => isCurrentWebRTCRoomScope(
      generation,
      sessionGenerationRef.current,
      room,
      roomRef.current,
    )
    room.on(liveKit.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (!scopeCurrent() || topic !== EVENT_TOPIC) return
      try {
        const event = JSON.parse(decoder.decode(payload)) as BridgeEvent
        const sessionId = activeSessionRef.current?.sessionId || ''
        if (!shouldAcceptBridgeEvent(event, participant, sessionId, liveKit.ParticipantKind.AGENT)) return
        if (participant) agentParticipantSeenRef.current = true
        handleBridgeEvent(event, generation)
      } catch {
        // Ignore unrelated or malformed room data.
      }
    })
    room.on(liveKit.RoomEvent.ParticipantConnected, (participant) => {
      if (!scopeCurrent()) return
      if (participant.kind === liveKit.ParticipantKind.AGENT || participant.identity.startsWith('agent-')) {
        agentParticipantSeenRef.current = true
      }
    })
    room.on(liveKit.RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication, participant) => {
      if (!scopeCurrent() || track.kind !== liveKit.Track.Kind.Audio) return
      if (participant.kind !== liveKit.ParticipantKind.AGENT && !participant.identity.startsWith('agent-')) return
      console.info('[s2st-webrtc]', {
        stage: 'output_track_subscribed',
        sessionId: activeSessionRef.current?.sessionId,
        captureElapsedMs: startedAtRef.current > 0
          ? Math.round(performance.now() - startedAtRef.current)
          : null,
      })
      void attachOutputTrack(track, generation, room).catch((caught) => {
        if (!scopeCurrent()) return
        failSession(
          caught instanceof Error ? caught.message : '无法播放 WebRTC 翻译音频。',
          'audio_output',
          generation,
        )
      })
    })
    room.on(liveKit.RoomEvent.Reconnecting, () => {
      if (!scopeCurrent()) return
      markReconnectAttempt()
      markDisconnect()
    })
    room.on(liveKit.RoomEvent.Reconnected, () => {
      if (scopeCurrent()) markConnectionRestored()
    })
    room.on(liveKit.RoomEvent.Disconnected, () => {
      if (!scopeCurrent() || expectedDisconnectRef.current) return
      if (statusRef.current === 'connecting') {
        markDisconnect()
        onActivationDisconnected()
        return
      }
      failSession('LiveKit 房间连接已关闭。', 'disconnected', generation)
    })
  }

  const attachOutputTrack = async (track: RemoteTrack, generation: number, expectedRoom: Room) => {
    const scopeCurrent = () => isCurrentWebRTCRoomScope(
      generation,
      sessionGenerationRef.current,
      expectedRoom,
      roomRef.current,
    )
    if (!scopeCurrent()) return
    const attachmentVersion = ++outputAttachmentVersionRef.current
    const attachmentCurrent = () => isCurrentWebRTCAudioAttachment(
      generation,
      sessionGenerationRef.current,
      expectedRoom,
      roomRef.current,
      attachmentVersion,
      outputAttachmentVersionRef.current,
    )
    const previousController = outputControllerRef.current
    if (outputControllerRef.current === previousController) outputControllerRef.current = null
    await previousController?.detach().catch(() => undefined)
    if (!attachmentCurrent()) return
    nativePlaybackStartedRef.current = false
    outputEvidenceRef.current = emptyWebRTCOutputEvidence()
    const element = document.createElement('audio')
    element.autoplay = true
    element.hidden = true
    element.setAttribute('playsinline', '')
    element.setAttribute('aria-hidden', 'true')
    element.dataset.simultransWebrtcOutput = 'true'
    const selectableElement = element as SinkSelectableAudioElement
    if (outputDeviceId !== 'default') {
      if (!selectableElement.setSinkId) {
        throw new Error('当前浏览器不支持指定音频输出设备，请改用系统默认输出。')
      }
      try {
        await selectableElement.setSinkId(outputDeviceId)
      } catch {
        if (!attachmentCurrent()) return
        throw new Error('无法使用所选音频输出设备，请确认设备仍已连接。')
      }
      if (!attachmentCurrent()) return
    }
    outputAudioSampleRateRef.current = 24000
    const controller = await attachWebRTCOutputAudio({
      track,
      room: expectedRoom,
      element,
      append: (audioElement) => document.body.append(audioElement),
      onPlaying: () => {
        if (!attachmentCurrent()) return
        setAudioPlaybackBlocked(false)
        applyWebRTCNativePlaybackProgress(generation, {
          noteProgress: noteProcessingProgress,
        })
        const playedAt = performance.now()
        outputEvidenceRef.current = reduceWebRTCOutputEvidence(
          outputEvidenceRef.current,
          { type: 'native-playing' },
        )
        nativePlaybackStartedRef.current = true
        startNextBridgePlaybackHighlight(generation)
        if (hasLiveWebRTCOutput(outputEvidenceRef.current)) {
          markFirstNativePlayback(generation, playedAt)
        }
      },
      onPlaybackBlocked: (caught) => {
        if (!attachmentCurrent()) return
        setAudioPlaybackBlocked(true)
        console.warn('[s2st-webrtc]', {
          stage: 'output_playback_waiting_for_user_gesture',
          sessionId: activeSessionRef.current?.sessionId,
          error: caught instanceof Error ? caught.message : String(caught),
        })
      },
      createReader: () => createPCMTrackReader(track.mediaStreamTrack, 24000, (chunk) => {
        if (
          !attachmentCurrent() ||
          (statusRef.current !== 'recording' && statusRef.current !== 'processing')
        ) return
        const receivedAt = performance.now()
        const hasSignal = pcm16HasSignal(chunk)
        outputEvidenceRef.current = reduceWebRTCOutputEvidence(
          outputEvidenceRef.current,
          { type: 'pcm', hasSignal },
        )
        if (hasSignal) {
          outputSignalSeenRef.current = true
          lastAudioChunkAtRef.current = receivedAt
          markOutputActivity()
          markProcessingDeliverable(generation, 'audio')
          startNextBridgePlaybackHighlight(generation)
        }
        if (hasSignal && !firstAudioByteSeenRef.current && startedAtRef.current > 0) {
          const latency = Math.max(0, receivedAt - startedAtRef.current)
          firstAudioByteSeenRef.current = true
          firstAudioReceivedAtRef.current = receivedAt
          firstAudioByteLatencyRef.current = latency
          recordBrowserLatency('captureToFirstAudioMs', latency)
          markTraceOnce('firstAudioByte')
          console.info('[s2st-webrtc]', {
            stage: 'first_output_signal_received',
            sessionId: activeSessionRef.current?.sessionId,
            captureElapsedMs: Math.round(latency),
            bytes: chunk.byteLength,
          })
        }
        observeSharePCMBytes(sessionMetaRef.current.id, 'output', new Uint8Array(chunk), 24000)
        const archived = appendPCMArchiveChunk(
          outputAudioRef.current,
          outputAudioBytesRef.current,
          new Uint8Array(chunk),
        )
        if (!archived.truncated) queueHistoryPCMChunk(sessionMetaRef.current.id, 'output', new Uint8Array(chunk), 24000)
        outputAudioBytesRef.current = archived.receivedBytes
        if (archived.truncated && !audioArchiveSkippedRef.current) {
          audioArchiveSkippedRef.current = true
          setAudioArchiveSkipped(true)
        }
        if (hasLiveWebRTCOutput(outputEvidenceRef.current)) {
          markFirstNativePlayback(generation, receivedAt)
        }
      }),
      onReaderError: (caught) => {
        if (!attachmentCurrent()) return
        outputEvidenceRef.current = reduceWebRTCOutputEvidence(
          outputEvidenceRef.current,
          { type: 'reader-unavailable' },
        )
        audioArchiveSkippedRef.current = true
        setAudioArchiveSkipped(true)
        console.warn('[s2st-webrtc]', {
          stage: 'output_analysis_unavailable',
          sessionId: activeSessionRef.current?.sessionId,
          error: caught instanceof Error ? caught.message : String(caught),
        })
      },
    })
    if (!attachmentCurrent()) {
      await controller.detach().catch(() => undefined)
      return
    }
    outputControllerRef.current = controller
    void controller.readerReady.then((reader) => {
      if (
        !attachmentCurrent() ||
        outputControllerRef.current !== controller || !reader
      ) return
      outputEvidenceRef.current = reduceWebRTCOutputEvidence(
        outputEvidenceRef.current,
        { type: 'reader-ready' },
      )
    })
  }

  const markFirstNativePlayback = (generation: number, playedAt: number) => {
    if (generation !== sessionGenerationRef.current || firstAudioPlaybackSeenRef.current) return
    firstAudioPlaybackSeenRef.current = true
    firstAudioPlaybackAtRef.current = playedAt
    const latency = Math.max(0, playedAt - startedAtRef.current)
    firstAudioPlaybackLatencyRef.current = latency
    const nextDiagnostics = withBridgeMediaPlaybackEstimates(
      sentenceDiagnosticsRef.current,
      latency,
    )
    if (nextDiagnostics !== sentenceDiagnosticsRef.current) {
      sentenceDiagnosticsRef.current = nextDiagnostics
      setSentenceDiagnostics(nextDiagnostics)
    }
    recordBrowserLatency('captureToFirstPlaybackMs', latency)
    if (firstAudioReceivedAtRef.current > 0) {
      recordBrowserLatency('firstAudioReceiveToPlaybackMs', Math.max(0, playedAt - firstAudioReceivedAtRef.current))
    }
    markTraceAt('firstAudioPlayback', playedAt)
    updateCrossDomainLatency()
    updateBridgeOutputToPlaybackLatency()
    setStreamingAudio(true)
    console.info('[s2st-webrtc]', {
      stage: 'first_native_playback',
      sessionId: activeSessionRef.current?.sessionId,
      captureElapsedMs: Math.round(latency),
      receiveToPlaybackMs: firstAudioReceivedAtRef.current > 0
        ? Math.round(playedAt - firstAudioReceivedAtRef.current)
        : null,
    })
  }

  const finishSession = async (generation: number, allowNoOutputTrack = true) => {
    if (generation !== sessionGenerationRef.current || finishingRef.current) return
    if (!claimProcessingTerminal(generation, 'completed')) return
    finishingRef.current = true
    clearProcessingTimeout()
    statusRef.current = 'processing'
    setStatus('processing')
    await waitForAudioQuiet(lastAudioChunkAtRef, 350, 3000)
    // Freeze the attachment before awaiting reader shutdown. A stuck reader may
    // still invoke its callback, but the version guard prevents it from mutating
    // audio/history snapshots after terminal finalization begins.
    outputAttachmentVersionRef.current++
    const readerCleanup = await settleWebRTCCleanup([
      () => outputControllerRef.current?.stopReader(),
    ])
    if (readerCleanup.cleanupTimedOut || readerCleanup.cleanupErrors.length > 0) {
      recordDiagnosticEvent('browser', 'webrtc_output_reader_cleanup_degraded', undefined, {
        timedOut: readerCleanup.cleanupTimedOut,
        errors: readerCleanup.cleanupErrors.map((caught) => (
          caught instanceof Error ? caught.message : String(caught)
        )),
      })
    }
    if (generation !== sessionGenerationRef.current) return
    const completion = classifyWebRTCOutputCompletion(outputEvidenceRef.current)
    const completionFailure = webRTCOutputCompletionFailure(completion)
    const textOnlyOrSilentCompletion = canCompleteWebRTCWithoutConfirmedOutput(
      completion,
      outputControllerRef.current !== null,
      allowNoOutputTrack,
    )
    if (completionFailure && !textOnlyOrSilentCompletion) {
      finishingRef.current = false
      failSession(completionFailure.message, completionFailure.category, generation, true)
      return
    }
    setStreamingAudio(false)
    finalizeRtcStats()
    commitWebRTCCompletedHistory(
      () => {
        if (inputAudioRef.current.length > 0) {
          setInputAudioURL(URL.createObjectURL(pcmChunksToWav(inputAudioRef.current, 16000)))
        }
      },
      () => {
        if (outputAudioRef.current.length > 0) {
          setAudioURL(URL.createObjectURL(pcmChunksToWav(outputAudioRef.current, 24000)))
        }
      },
      () => {
        markTrace('finished')
        statusRef.current = 'finished'
        setStatus('finished')
      },
      () => recordHistory('completed'),
    )
    await cleanup()
    finishingRef.current = false
  }

  const start = async () => {
    if (service !== 'livekit') return
    if (!ready) {
      setError(notReadyReason)
      statusRef.current = 'error'
      setStatus('error')
      return
    }
    if (startInFlightRef.current || statusRef.current === 'connecting' || statusRef.current === 'recording') return
    const existingPreparation = preparedStartupRef.current
    const preparationWasWarm = existingPreparation?.key === preparationKey
    const gestureRoom = preparationWasWarm ? existingPreparation?.startup.peek()?.room : null
    if (gestureRoom) {
      // Must be invoked before the first await so restrictive mobile WebViews
      // still associate the audio unlock with the start button's click/tap.
      try {
        void Promise.resolve(gestureRoom.startAudio()).catch(() => undefined)
      } catch {
        // Track attachment will surface a recoverable unlock prompt if needed.
      }
    }
    if (preparationWasWarm) {
      preparedStartupRef.current = null
    } else {
      existingPreparation?.startup.cancel()
      preparedStartupRef.current = null
    }
    let preparedStartup = preparationWasWarm
      ? existingPreparation!.startup
      : createPreparedStartup(false)
    const generation = ++sessionGenerationRef.current
    resetProcessingWatchdog(generation)
    const registerStartingPreparation = (startup: typeof preparedStartup) => {
      startingPreparationRef.current = { generation, startup }
    }
    const clearStartingPreparation = (startup: typeof preparedStartup) => {
      const current = startingPreparationRef.current
      if (current?.generation === generation && current.startup === startup) {
        startingPreparationRef.current = null
      }
    }
    const startCurrent = (expectedRoom?: Room) => (
      generation === sessionGenerationRef.current &&
      statusRef.current === 'connecting' &&
      (expectedRoom === undefined || roomRef.current === expectedRoom)
    )
    const assertStartCurrent = (expectedRoom?: Room) => {
      if (!startCurrent(expectedRoom)) throw new Error('WebRTC 会话启动已取消。')
    }
    const adoptPrepared = async (startup: typeof preparedStartup) => {
      let prepared: PreparedLiveKitSession
      try {
        prepared = await startup.adopt()
      } finally {
        clearStartingPreparation(startup)
      }
      if (!startCurrent()) {
        await disposePreparedSession(prepared)
        throw new Error('WebRTC 会话启动已取消。')
      }
      return prepared
    }
    registerStartingPreparation(preparedStartup)
    startInFlightRef.current = true
    expectedDisconnectRef.current = false
    finishingRef.current = false
    lastAudioChunkAtRef.current = 0
    statusRef.current = 'connecting'
    setStatus('connecting')
    let localTrackStartupOwner: WebRTCLocalTrackStartupOwner | null = null
    let activationOwner: WebRTCActivationOwner | null = null
    const ownActivation = (prepared: PreparedLiveKitSession) => {
      const owner = { generation, prepared }
      activationOwnerRef.current = owner
      activationOwner = owner
    }
    try {
      await cleanup(generation)
      assertStartCurrent()
      expectedDisconnectRef.current = false
      resetSessionState({ provider, transport: 'webrtc', model, sourceLanguage, targetLanguage })
      cumulativeSourceRef.current = emptyCumulativeTranscriptState()
      vadTranscriptStateRef.current = emptyVadTranscriptPairState()
      setVadTranscriptPairs([])
      bridgeFirstInputToFirstOutputMsRef.current = null
      clearBridgePlaybackHighlight()
      outputSignalSeenRef.current = false
      nativePlaybackStartedRef.current = false
      outputEvidenceRef.current = emptyWebRTCOutputEvidence()
      setAudioPlaybackBlocked(false)
      resetTraceForNewSession()
      // Clock sync only enriches cross-domain latency metrics; resolve it in
      // the background so recording never waits on /api/time round trips.
      void ensureServerClockSync().then((sync) => {
        if (generation !== sessionGenerationRef.current) return
        serverClockSyncRef.current = sync
        updateCrossDomainLatency()
      }).catch(() => undefined)
      let prepared: PreparedLiveKitSession
      let preparedWasWarm = Boolean(preparationWasWarm)
      try {
        prepared = await adoptPrepared(preparedStartup)
      } catch (caught) {
        if (!preparationWasWarm || !startCurrent()) throw caught
        console.warn('[s2st-webrtc]', {
          stage: 'prepared_connection_fallback',
          error: caught instanceof Error ? caught.message : String(caught),
        })
        preparedStartup = createPreparedStartup(false)
        preparedWasWarm = false
        registerStartingPreparation(preparedStartup)
        prepared = await adoptPrepared(preparedStartup)
      }
      if (prepared.expiresAt <= Date.now() + 5_000) {
        await disposePreparedSession(prepared)
        assertStartCurrent()
        preparedStartup = createPreparedStartup(false)
        preparedWasWarm = false
        registerStartingPreparation(preparedStartup)
        prepared = await adoptPrepared(preparedStartup)
      }
      ownActivation(prepared)
      const localTrackStartup = createCancellableStartupTrack(() => (
        // LiveKit forwards this object unchanged to getUserMedia; its types
        // have not yet adopted the string echo-cancellation modes.
        prepared.liveKit.createLocalAudioTrack(
          webRTCAudioCaptureOptions(inputDeviceId, webRTCEchoCancellation, browserAudioProcessing) as unknown as Parameters<LiveKitModule['createLocalAudioTrack']>[0],
        )
      ))
      localTrackStartupOwner = { generation, startup: localTrackStartup }
      localTrackStartupOwnerRef.current = localTrackStartupOwner
      let warmRetryUsed = false
      while (true) {
        assertStartCurrent()
        const { session, liveKit, room } = prepared
        prepared.detachStandbyListener()
        agentParticipantSeenRef.current = prepared.standbySeen()
        activeSessionRef.current = session
        sessionMetaRef.current.id = session.sessionId
        const sessionObservability = {
          traceId: session.traceContext?.traceId,
          requestId: session.traceContext?.requestId,
          sessionId: session.sessionId,
        }
        updateObservability(sessionObservability)
        recordDiagnosticEvent('browser', 'session_trace_created', undefined, sessionObservability)
        roomRef.current = room
        let rejectBridgeReady: (reason: Error) => void = () => undefined
        const bridgeReady = new Promise<void>((resolve, reject) => {
          bridgeReadyRef.current = resolve
          rejectBridgeReady = reject
        })
        attachRoomListeners(room, generation, liveKit, () => {
          rejectBridgeReady(new Error('LiveKit 预备房间在启动握手期间断开。'))
        })
        let activationStage: WebRTCActivationFailureStage = 'connection'
        try {
          if (!prepared.connected || room.state !== liveKit.ConnectionState.Connected) {
            await room.connect(session.livekitUrl, session.token, { autoSubscribe: true })
            assertStartCurrent(room)
          }
          markTrace('socketOpen')
          for (const participant of room.remoteParticipants.values()) {
            if (participant.kind === liveKit.ParticipantKind.AGENT || participant.identity.startsWith('agent-')) {
              agentParticipantSeenRef.current = true
            }
          }
          activationStage = 'handshake'
          // The Agent start handshake rides the LiveKit data channel and does
          // not depend on the backend activation lease, which must only be in
          // place before commit — run both in parallel.
          await Promise.all([
            activatePreparedSession(session),
            waitForBridgeHandshake(
              room,
              bridgeReady,
              session.sessionId,
              () => agentParticipantSeenRef.current,
              15_000,
              200,
              'start',
            ),
          ])
          assertStartCurrent(room)
          break
        } catch (caught) {
          const retryWarmRoom = !warmRetryUsed && canRetryWarmWebRTCActivation(
            preparedWasWarm,
            activationStage,
            generation,
            sessionGenerationRef.current,
            statusRef.current,
          )
          expectedDisconnectRef.current = true
          bridgeReadyRef.current = null
          if (roomRef.current === room) roomRef.current = null
          if (activeSessionRef.current === session) activeSessionRef.current = null
          agentParticipantSeenRef.current = false
          const failedActivationOwner = activationOwner
          activationOwner = null
          const claimedActivationOwner = failedActivationOwner
            ? claimWebRTCStartupOwner(activationOwnerRef, failedActivationOwner)
            : null
          if (claimedActivationOwner) {
            await disposePreparedSession(claimedActivationOwner.prepared)
          }
          if (!retryWarmRoom) throw caught
          warmRetryUsed = true
          console.warn('[s2st-webrtc]', {
            stage: 'standby_activation_retry',
            failedStage: activationStage,
            sessionId: session.sessionId,
            error: caught instanceof Error ? caught.message : String(caught),
          })
          assertStartCurrent()
          expectedDisconnectRef.current = false
          preparedStartup = createPreparedStartup(false)
          preparedWasWarm = false
          registerStartingPreparation(preparedStartup)
          prepared = await adoptPrepared(preparedStartup)
          ownActivation(prepared)
        }
      }
      const { session, liveKit, room } = prepared
      assertStartCurrent(room)
      const localTrack = await localTrackStartup.adopt()
      if (!startCurrent(room)) {
        localTrack.stop()
        throw new Error('WebRTC 会话启动已取消。')
      }
      localTrackRef.current = localTrack
      if (localTrackStartupOwner) {
        claimWebRTCStartupOwner(localTrackStartupOwnerRef, localTrackStartupOwner)
        localTrackStartupOwner = null
      }
      const diagnostics = await configureAndInspectWebRTCAudioTrack(localTrack, webRTCEchoCancellation, browserAudioProcessing)
      if (!startCurrent(room) || localTrackRef.current !== localTrack) {
        localTrack.stop()
        throw new Error('WebRTC 会话启动已取消。')
      }
      setAudioProcessingDiagnostics(diagnostics)
      try {
        assertWebRTCAudioProcessingMatchesOrStop(localTrack, diagnostics, webRTCEchoCancellation, browserAudioProcessing)
      } catch (caught) {
        if (localTrackRef.current === localTrack) localTrackRef.current = null
        throw caught
      }
      // Renew the bounded ACTIVATING lease after any microphone permission wait.
      await activatePreparedSession(session)
      assertStartCurrent(room)
      await room.localParticipant.publishTrack(localTrack, {
        name: 'browser-microphone',
        source: liveKit.Track.Source.Microphone,
      })
      if (!canCommitWebRTCActivation(
        generation,
        sessionGenerationRef.current,
        statusRef.current,
        room,
        roomRef.current,
        localTrack,
        localTrackRef.current,
        true,
      )) {
        localTrack.stop()
        throw new Error('WebRTC 会话启动已取消。')
      }
      // Optimistic commit: recording starts immediately while the backend
      // confirms in the background; a rejected commit aborts the young session
      // (the backend deletes the room on an expired lease anyway).
      commitPreparedSession(session).catch((caught: unknown) => {
        failSession(
          caught instanceof Error ? caught.message : '确认 WebRTC 会话激活失败。',
          'service_error',
          generation,
        )
      })
      if (activationOwner) {
        claimWebRTCStartupOwner(activationOwnerRef, activationOwner)
        activationOwner = null
      }
      startedAtRef.current = performance.now()
      audioTimelineStartedAtRef.current = startedAtRef.current
      markTrace('captureStarted')
      statusRef.current = 'recording'
      setStatus('recording')
      inputArchiveControllerRef.current = startWebRTCInputArchive({
        createReader: () => createPCMTrackReader(localTrack.mediaStreamTrack, 16000, (chunk) => {
          if (generation !== sessionGenerationRef.current || statusRef.current !== 'recording') return
          if (!inputAudioArchiveSkippedRef.current) {
            const archived = appendPCMArchiveChunk(
              inputAudioRef.current,
              inputAudioBytesRef.current,
              new Uint8Array(chunk),
            )
            if (!archived.truncated) queueHistoryPCMChunk(sessionMetaRef.current.id, 'input', new Uint8Array(chunk), 16000)
            inputAudioBytesRef.current = archived.receivedBytes
            if (archived.truncated) {
              inputAudioArchiveSkippedRef.current = true
            }
          }
        }),
        onReady: (reader) => {
          if (
            generation !== sessionGenerationRef.current ||
            statusRef.current !== 'recording' ||
            localTrackRef.current !== localTrack
          ) return
          if (reader.capturePipeline) {
            setAudioProcessingDiagnostics({
              ...diagnostics,
              capturePipeline: reader.capturePipeline,
              captureError: undefined,
            })
          }
        },
        onError: (caught) => {
          if (
            generation !== sessionGenerationRef.current ||
            statusRef.current !== 'recording' ||
            localTrackRef.current !== localTrack
          ) return
          inputAudioArchiveSkippedRef.current = true
          setAudioProcessingDiagnostics({
            ...diagnostics,
            captureError: caught instanceof Error ? caught.message : '浏览器无法启动本地输入归档。',
          })
        },
      })
      collectorRef.current = createRTCStatsCollector({
        localTrack,
        getRemoteAudioTrack: () => {
          for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.audioTrackPublications.values()) {
              if (publication.track) return publication.track
            }
          }
          return null
        },
      })
      collectorRef.current.start()
      refreshAudioDevices()
    } catch (caught) {
      const pendingLocalTrackOwner = localTrackStartupOwner
      localTrackStartupOwner = null
      const claimedLocalTrackOwner = pendingLocalTrackOwner
        ? claimWebRTCStartupOwner(localTrackStartupOwnerRef, pendingLocalTrackOwner)
        : null
      claimedLocalTrackOwner?.startup.cancel()
      const uncommittedActivationOwner = activationOwner
      activationOwner = null
      const claimedActivationOwner = uncommittedActivationOwner
        ? claimWebRTCStartupOwner(activationOwnerRef, uncommittedActivationOwner)
        : null
      if (claimedActivationOwner) {
        expectedDisconnectRef.current = true
        if (roomRef.current === claimedActivationOwner.prepared.room) roomRef.current = null
        if (activeSessionRef.current === claimedActivationOwner.prepared.session) activeSessionRef.current = null
        await disposePreparedSession(claimedActivationOwner.prepared)
      }
      const startingPreparation = startingPreparationRef.current
      if (startingPreparation?.generation === generation) {
        startingPreparationRef.current = null
        startingPreparation.startup.cancel()
      }
      failSession(caught instanceof Error ? caught.message : '无法启动 WebRTC 会话。', 'service_error', generation)
    } finally {
      startInFlightRef.current = false
    }
  }

  const stop = async () => {
    if (statusRef.current !== 'recording') return
    const generation = sessionGenerationRef.current
    statusRef.current = 'processing'
    setStatus('processing')
    markTrace('inputStopped')
    armProcessingWatchdog(generation, (snapshot) => {
      if (!shouldArmWebRTCProcessingTimeout(
        generation,
        sessionGenerationRef.current,
        statusRef.current,
        finishingRef.current,
      )) return
      const timeoutFailure = processingTimeoutFailure(
        snapshot.deliverable,
        snapshot.progressSeen,
        'webrtc',
      )
      if (timeoutFailure.graceful) {
        recordDiagnosticEvent('browser', 'processing_completion_timeout', undefined, {
          transport: 'webrtc', deliverable: true,
        })
        setFailure(timeoutFailure.message, timeoutFailure.category)
        setCompletionWarning(timeoutFailure.message)
        void finishSession(generation, snapshot.textDeliverable)
        return
      }
      failSession(timeoutFailure.message, timeoutFailure.category, generation)
    })
    const inputArchiveController = inputArchiveControllerRef.current
    const localTrack = localTrackRef.current
    const room = roomRef.current
    localTrack?.stop()
    try {
      const stopResult = await stopWebRTCInputBeforeFinish(
        () => inputArchiveController?.stop(),
        () => localTrack && room
          ? room.localParticipant.unpublishTrack(localTrack, true)
          : undefined,
        () => room?.localParticipant.publishData(
          encoder.encode(JSON.stringify({ action: 'finish' })),
          { reliable: true, topic: CONTROL_TOPIC },
        ),
      )
      if (inputArchiveControllerRef.current === inputArchiveController) {
        inputArchiveControllerRef.current = null
      }
      if (localTrackRef.current === localTrack) {
        localTrackRef.current = null
      }
      if (stopResult.cleanupTimedOut || stopResult.cleanupErrors.length > 0) {
        recordDiagnosticEvent('browser', 'webrtc_input_cleanup_degraded', undefined, {
          timedOut: stopResult.cleanupTimedOut,
          errors: stopResult.cleanupErrors.map((caught) => (
            caught instanceof Error ? caught.message : String(caught)
          )),
        })
      }
    } catch (caught) {
      if (!shouldArmWebRTCProcessingTimeout(
        generation,
        sessionGenerationRef.current,
        statusRef.current,
        finishingRef.current,
      )) return
      failSession(
        caught instanceof Error ? caught.message : '无法结束 WebRTC 麦克风输入。',
        'capture_error',
        generation,
      )
      return
    }
  }

  const resumeAudioPlayback = async () => {
    const controller = outputControllerRef.current
    const generation = sessionGenerationRef.current
    if (!controller || (statusRef.current !== 'recording' && statusRef.current !== 'processing')) return
    try {
      // This call begins synchronously in the button's click/tap handler.
      await controller.startAudio()
      if (generation === sessionGenerationRef.current && outputControllerRef.current === controller) {
        setAudioPlaybackBlocked(false)
      }
    } catch (caught) {
      if (generation !== sessionGenerationRef.current || outputControllerRef.current !== controller) return
      if (isUserGesturePlaybackError(caught)) {
        setAudioPlaybackBlocked(true)
        return
      }
      failSession(
        caught instanceof Error ? `浏览器无法播放翻译音频：${caught.message}` : '浏览器无法播放翻译音频。',
        'audio_output',
        generation,
      )
    }
  }

  return {
    status, error, completionWarning, setError, sourceText, translation, modelOutputTranslation, sourceSegments, translationSegments,
    translationDisplayUnits, vadTranscriptPairs, playingTranslationSegmentId, audioSegments, providerLagSamples,
    synthesisDurationSamples, sentenceDiagnostics, diagnosticEvents, observability, trace, stability, engineLatency, browserLatency, ttsWarning,
    audioProcessingDiagnostics, firstTextLatency, elapsed, inputAudioURL, audioURL, streamingAudio,
    playbackIncomplete, audioArchiveSkipped, audioPlaybackBlocked, outputAudioRef,
    start, stop, resumeAudioPlayback,
  }
}

function numberValue(...values: unknown[]) {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function booleanSetting(value: unknown) {
  return typeof value === 'boolean' ? value : null
}

export function mergeBridgeEngineLatency(current: EngineLatencyMetrics, event: BridgeEvent) {
  const latency = event.latency || {}
  const next = { ...current }
  for (const [field, keys] of [
    ['firstModelTokenMs', [event.engineFirstModelTokenMs, latency.firstModelTokenMs, latency.first_model_token_ms]],
    ['firstTextMs', [event.engineFirstTextMs, latency.firstTextMs, latency.first_text_ms]],
    ['firstTTSReadyMs', [event.engineFirstTTSReadyMs, latency.firstTTSReadyMs, latency.first_tts_ready_ms]],
    ['audioToModelFeedMs', [event.engineAudioToModelFeedMs, latency.audioToModelFeedMs, latency.audio_to_model_feed_ms]],
    ['modelFeedToFirstOutputMs', [event.engineModelFeedToFirstOutputMs, latency.modelFeedToFirstOutputMs, latency.model_feed_to_first_output_ms]],
    ['modelFeedToStableTextMs', [event.engineModelFeedToStableTextMs, latency.modelFeedToStableTextMs, latency.model_feed_to_stable_text_ms]],
    ['modelFeedToTTSReadyMs', [event.engineModelFeedToTTSReadyMs, latency.modelFeedToTTSReadyMs, latency.model_feed_to_tts_ready_ms]],
  ] as const) {
    const value = numberValue(...keys)
    if (value !== undefined && value >= 0) next[field] = value
  }
  return next
}

async function waitForAudioQuiet(
  lastAudioChunkAtRef: { current: number },
  quietMs: number,
  timeoutMs: number,
) {
  const startedAt = performance.now()
  while (
    performance.now() - startedAt < timeoutMs &&
    (lastAudioChunkAtRef.current === 0 || performance.now() - lastAudioChunkAtRef.current < quietMs)
  ) {
    await new Promise((resolve) => window.setTimeout(resolve, 50))
  }
}
