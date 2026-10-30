// Change record (2026-08-05): track streamed TTS completion per sentence so
// playback highlighting follows the full sentence rather than one PCM chunk.
// Change record (2026-08-05): keep cumulative model output separate from
// stable translation/TTS state for immediate preview rendering.
import { useEffect, useRef, useState } from 'react'
import { pcmChunksToWav, type AudioProcessingDiagnostics, type PCMStreamPlayer, type RecorderHandle } from '../audio'
import type { HistoryAudioArchive } from '../historyAudio'
import type { RTCStatsArchive } from '../webrtcStats'
import { clientUnixUsAt, type ServerClockSync } from '../lib/clockSync'
import { calculateInputSendIntervalMetrics, calculateValueStats, historyAudioTimelineStats, historyNativeMetricStats, historyTimelineStats } from '../lib/stats'
import type { StreamedPlaybackSegments } from '../lib/streamedPlayback'
import { useSessionTrace } from './useSessionTrace'
import type {
  BrowserLatencyMetrics,
  DiagnosticEvent,
  EngineLatencyMetrics,
  HistoryEntry,
  NativeMetricSample,
  ObservabilityContext,
  SentenceDiagnostic,
  TimedAudioSegment,
  TimedTranscriptSegment,
  TranslationDisplayUnit,
} from '../types/history'
import type { ApiObservation } from '../lib/apiFetch'

export type Status = 'idle' | 'connecting' | 'recording' | 'processing' | 'finished' | 'error'

export const CONNECTION_TIMEOUT_MS = 10_000
export const PROCESSING_TIMEOUT_MS = 25_000
const WAV_HEADER_BYTES = 44
export const MAX_ARCHIVED_AUDIO_BYTES = 64 * 1024 * 1024 - WAV_HEADER_BYTES
const MAX_DIAGNOSTIC_EVENTS = 1_000

export function appendPCMArchiveChunk(
  chunks: Uint8Array[],
  receivedBytes: number,
  chunk: Uint8Array,
  limit = MAX_ARCHIVED_AUDIO_BYTES,
) {
  const nextReceivedBytes = receivedBytes + chunk.byteLength
  if (nextReceivedBytes <= limit) chunks.push(chunk)
  return { receivedBytes: nextReceivedBytes, truncated: nextReceivedBytes > limit }
}

type ProcessingTerminalClaim = 'completed' | 'failed'
export type ProcessingDeliverableKind = 'preview' | 'stable-text' | 'audio'

export type ProcessingWatchdogSnapshot = {
  generation: number
  armed: boolean
  progressSeen: boolean
  deliverable: boolean
  textDeliverable: boolean
  audioDeliverable: boolean
  terminal: ProcessingTerminalClaim | null
}

type ProcessingEvidenceEvent = {
  type: string
  text?: string
  epochText?: string
  segmentText?: string
  audio?: string
  utteranceId?: string
  speechEpoch?: number
}

export function processingEventEvidence(
  event: ProcessingEvidenceEvent,
  hasAudioSignal = false,
) {
  const hasText = Boolean(
    event.epochText?.trim() || event.segmentText?.trim() || event.text?.trim(),
  )
  const anchoredModelOutput = event.type === 'model_output' && Boolean(event.epochText?.trim())
  const stableTranslation = (
    event.type === 'translation' || event.type === 'translation_done'
  ) && hasText
  const deliverableKind: ProcessingDeliverableKind | undefined = hasAudioSignal
    ? 'audio'
    : anchoredModelOutput
      ? 'preview'
      : stableTranslation
        ? 'stable-text'
        : undefined
  const deliverable = deliverableKind !== undefined
  const utteranceId = event.utteranceId?.trim()
  const evidenceKey = utteranceId || (
    typeof event.speechEpoch === 'number' && event.speechEpoch > 0
      ? `vad-${event.speechEpoch}`
      : undefined
  )
  const textProgress = hasText && (
    event.type === 'source' || event.type === 'transcription' ||
    event.type === 'source_delta' || event.type === 'source_update' || event.type === 'source_done' ||
    event.type === 'model_output' || event.type === 'translation' ||
    event.type === 'translation_delta' || event.type === 'translation_update' || event.type === 'translation_done'
  )
  const markerProgress = event.type === 'source_vad_state' || event.type === 'source_vad_segment' ||
    event.type === 'source_vad_commit' || event.type === 'model_output_reset' ||
    event.type === 'audio_done' || event.type === 'audio_playout_started' ||
    event.type === 'provider_finished' || event.type === 'playout_drained' ||
    event.type === 'completed' || event.type === 'session_metrics'
  const audioProgress = event.type === 'audio' && Boolean(event.audio)
  return {
    progress: deliverable || textProgress || markerProgress || audioProgress,
    deliverable,
    ...(deliverableKind ? { deliverableKind } : {}),
    ...(evidenceKey ? { evidenceKey } : {}),
    ...(event.type === 'model_output_reset' ? { resetPreview: true as const } : {}),
  }
}

export type ProcessingEvidenceActions = {
  noteProgress: (generation: number) => unknown
  markDeliverable: (
    generation: number,
    kind: ProcessingDeliverableKind,
    evidenceKey?: string,
  ) => unknown
  resetPreview: (generation: number, evidenceKey?: string) => unknown
}

export function applyProcessingEventEvidence(
  event: ProcessingEvidenceEvent,
  generation: number,
  actions: ProcessingEvidenceActions,
  hasAudioSignal = false,
) {
  const evidence = processingEventEvidence(event, hasAudioSignal)
  if (evidence.resetPreview) actions.resetPreview(generation, evidence.evidenceKey)
  if (evidence.deliverableKind) {
    actions.markDeliverable(generation, evidence.deliverableKind, evidence.evidenceKey)
  } else if (evidence.progress && !evidence.resetPreview) {
    actions.noteProgress(generation)
  }
  return evidence
}

export function processingTimeoutFailure(
  deliverable: boolean,
  progressSeen: boolean,
  transport: 'websocket' | 'webrtc',
) {
  const transportLabel = transport === 'webrtc' ? 'WebRTC ' : ''
  if (deliverable) {
    return {
      category: 'completion_timeout',
      message: `模型已有可交付输出，但连续 ${PROCESSING_TIMEOUT_MS / 1000} 秒未完成 ${transportLabel}会话。`,
      graceful: true as const,
    }
  }
  if (progressSeen) {
    return {
      category: 'processing_stalled_timeout',
      message: `模型已有处理进度，但连续 ${PROCESSING_TIMEOUT_MS / 1000} 秒未继续推进或完成 ${transportLabel}会话。`,
      graceful: false as const,
    }
  }
  return {
    category: 'no_output_timeout',
    message: `模型连续 ${PROCESSING_TIMEOUT_MS / 1000} 秒未返回任何${transportLabel}处理进度或可交付输出。`,
    graceful: false as const,
  }
}

export function createProcessingWatchdog(timeoutMs = PROCESSING_TIMEOUT_MS) {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let onTimeout: ((snapshot: ProcessingWatchdogSnapshot) => void) | null = null
  const previewDeliverableKeys = new Set<string>()
  let progressSeen = false
  let stableTextDeliverable = false
  let audioDeliverable = false
  let terminal: ProcessingTerminalClaim | null = null

  const snapshot = (): ProcessingWatchdogSnapshot => ({
    generation,
    armed: timer !== null,
    progressSeen,
    deliverable: previewDeliverableKeys.size > 0 || stableTextDeliverable || audioDeliverable,
    textDeliverable: previewDeliverableKeys.size > 0 || stableTextDeliverable,
    audioDeliverable,
    terminal,
  })
  const clearTimer = () => {
    if (timer === null) return
    globalThis.clearTimeout(timer)
    timer = null
  }
  const schedule = () => {
    clearTimer()
    if (!onTimeout || terminal) return
    const scheduledGeneration = generation
    timer = globalThis.setTimeout(() => {
      if (generation !== scheduledGeneration || terminal || !onTimeout) return
      timer = null
      const callback = onTimeout
      onTimeout = null
      callback(snapshot())
    }, timeoutMs)
  }

  return {
    reset(nextGeneration: number) {
      clearTimer()
      generation = nextGeneration
      onTimeout = null
      previewDeliverableKeys.clear()
      progressSeen = false
      stableTextDeliverable = false
      audioDeliverable = false
      terminal = null
    },
    arm(nextGeneration: number, callback: (state: ProcessingWatchdogSnapshot) => void) {
      if (generation !== nextGeneration || terminal) return false
      onTimeout = callback
      schedule()
      return true
    },
    noteProgress(nextGeneration: number) {
      if (generation !== nextGeneration || terminal) return false
      progressSeen = true
      if (onTimeout) schedule()
      return true
    },
    noteDeliverable(
      nextGeneration: number,
      kind: ProcessingDeliverableKind = 'stable-text',
      evidenceKey?: string,
    ) {
      if (generation !== nextGeneration || terminal) return false
      progressSeen = true
      if (kind === 'preview') previewDeliverableKeys.add(evidenceKey || '__unscoped__')
      else if (kind === 'stable-text') stableTextDeliverable = true
      else audioDeliverable = true
      if (onTimeout) schedule()
      return true
    },
    resetPreview(nextGeneration: number, evidenceKey?: string) {
      if (generation !== nextGeneration || terminal) return false
      progressSeen = true
      if (evidenceKey) previewDeliverableKeys.delete(evidenceKey)
      else previewDeliverableKeys.clear()
      if (onTimeout) schedule()
      return true
    },
    hasDeliverable(nextGeneration: number) {
      return generation === nextGeneration && (
        previewDeliverableKeys.size > 0 || stableTextDeliverable || audioDeliverable
      )
    },
    claimTerminal(nextGeneration: number, claim: ProcessingTerminalClaim) {
      if (generation !== nextGeneration || terminal) return false
      terminal = claim
      onTimeout = null
      clearTimer()
      return true
    },
    cancel() {
      onTimeout = null
      clearTimer()
    },
    snapshot,
  }
}

export type SessionRuntimeOptions = {
  onSessionRecorded: (entry: HistoryEntry, audio: HistoryAudioArchive) => void
}

export const emptyEngineLatency = (): EngineLatencyMetrics => ({
  firstModelTokenMs: null,
  firstTextMs: null,
  firstTTSReadyMs: null,
  audioToModelFeedMs: null,
  modelFeedToFirstOutputMs: null,
  modelFeedToStableTextMs: null,
  modelFeedToTTSReadyMs: null,
  recordingToModelSubmitMs: null,
  ttsReadyToFirstPlaybackMs: null,
  clockSyncUncertaintyMs: null,
})

export const emptyBrowserLatency = (): BrowserLatencyMetrics => ({
  captureToWSSendMs: null,
  inputSendIntervalP95Ms: null,
  maxInputSendGapMs: null,
  inputSendIntervalSampleCount: 0,
  captureToFirstTextMs: null,
  captureToFirstStableSentenceMs: null,
  captureToFirstAudioMs: null,
  firstAudioReceiveToPlaybackScheduledMs: null,
  captureToFirstPlaybackScheduledMs: null,
  firstAudioReceiveToPlaybackMs: null,
  captureToFirstPlaybackMs: null,
})

export function deriveTTSReadyToPlaybackMs(
  captureToFirstPlaybackMs: number | null,
  recordingToModelSubmitMs: number | null,
  modelFeedToTTSReadyMs: number | null,
) {
  if (
    captureToFirstPlaybackMs === null
    || recordingToModelSubmitMs === null
    || modelFeedToTTSReadyMs === null
  ) return null
  const value = captureToFirstPlaybackMs - recordingToModelSubmitMs - modelFeedToTTSReadyMs
  return Number.isFinite(value) && value >= 0 ? value : null
}

export function useSessionRuntime({ onSessionRecorded }: SessionRuntimeOptions) {
  const onSessionRecordedRef = useRef(onSessionRecorded)
  onSessionRecordedRef.current = onSessionRecorded
  const recordHistoryRef = useRef<(outcome: HistoryEntry['outcome']) => void>(() => undefined)
  const [status, setStatus] = useState<Status>('idle')
  const [sourceText, setSourceText] = useState('')
  const [translation, setTranslation] = useState('')
  const [modelOutputTranslation, setModelOutputTranslation] = useState('')
  const [sourceSegments, setSourceSegments] = useState<TimedTranscriptSegment[]>([])
  const [translationSegments, setTranslationSegments] = useState<TimedTranscriptSegment[]>([])
  const [translationDisplayUnits, setTranslationDisplayUnits] = useState<TranslationDisplayUnit[]>([])
  const [audioSegments, setAudioSegments] = useState<TimedAudioSegment[]>([])
  const [providerLagSamples, setProviderLagSamples] = useState<NativeMetricSample[]>([])
  const [synthesisDurationSamples, setSynthesisDurationSamples] = useState<NativeMetricSample[]>([])
  const [sentenceDiagnostics, setSentenceDiagnostics] = useState<SentenceDiagnostic[]>([])
  const [error, setError] = useState('')
  const [completionWarning, setCompletionWarning] = useState('')
  const [inputAudioURL, setInputAudioURL] = useState('')
  const [audioURL, setAudioURL] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [firstTextLatency, setFirstTextLatency] = useState<number | null>(null)
  const [playingTranslationSegmentId, setPlayingTranslationSegmentId] = useState<string | null>(null)
  const [engineLatency, setEngineLatency] = useState<EngineLatencyMetrics>(emptyEngineLatency)
  const [browserLatency, setBrowserLatency] = useState<BrowserLatencyMetrics>(emptyBrowserLatency)
  const [ttsWarning, setTTSWarning] = useState('')
  const [audioProcessingDiagnostics, setAudioProcessingDiagnostics] = useState<AudioProcessingDiagnostics | null>(null)
  const [streamingAudio, setStreamingAudio] = useState(false)
  const [playbackIncomplete, setPlaybackIncomplete] = useState(false)
  const [audioArchiveSkipped, setAudioArchiveSkipped] = useState(false)
  const [observability, setObservability] = useState<ObservabilityContext>({})
  const [diagnosticEvents, setDiagnosticEvents] = useState<DiagnosticEvent[]>([])

  const socketRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<RecorderHandle | null>(null)
  const playerRef = useRef<PCMStreamPlayer | null>(null)
  const outputAudioRef = useRef<Uint8Array[]>([])
  const inputAudioRef = useRef<Uint8Array[]>([])
  const rtcStatsRef = useRef<RTCStatsArchive | null>(null)
  const outputSampleRateRef = useRef(24000)
  const outputAudioSampleRateRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const audioTimelineStartedAtRef = useRef(0)
  const firstAudioReceivedAtRef = useRef(0)
  const firstAudioPlaybackAtRef = useRef(0)
  const engineLatencyRef = useRef<EngineLatencyMetrics>(emptyEngineLatency())
  const browserLatencyRef = useRef<BrowserLatencyMetrics>(emptyBrowserLatency())
  const serverClockSyncRef = useRef<ServerClockSync | null>(null)
  const firstModelSubmitUnixUsRef = useRef(0)
  const firstTTSReadyUnixUsRef = useRef(0)
  const ttsWarningRef = useRef('')
  const firstTextSeenRef = useRef(false)
  const firstAudioByteSeenRef = useRef(false)
  const firstAudioPlaybackSeenRef = useRef(false)
  const firstTextLatencyRef = useRef<number | null>(null)
  const firstAudioByteLatencyRef = useRef<number | null>(null)
  const firstAudioPlaybackLatencyRef = useRef<number | null>(null)
  const outputAudioBytesRef = useRef(0)
  const inputAudioBytesRef = useRef(0)
  const inputAudioArchiveSkippedRef = useRef(false)
  const audioArchiveSkippedRef = useRef(false)
  const inputSendTimestampsRef = useRef<number[]>([])
  const inputSendMetricsPublishedAtRef = useRef(0)
  const processingWatchdogRef = useRef<ReturnType<typeof createProcessingWatchdog> | null>(null)
  if (processingWatchdogRef.current === null) {
    processingWatchdogRef.current = createProcessingWatchdog()
  }
  const sourceTextRef = useRef('')
  const translationRef = useRef('')
  const modelOutputTranslationRef = useRef('')
  const sourceSegmentsRef = useRef<TimedTranscriptSegment[]>([])
  const translationSegmentsRef = useRef<TimedTranscriptSegment[]>([])
  const translationDisplayUnitsRef = useRef<TranslationDisplayUnit[]>([])
  const audioSegmentsRef = useRef<TimedAudioSegment[]>([])
  const providerLagSamplesRef = useRef<NativeMetricSample[]>([])
  const synthesisDurationSamplesRef = useRef<NativeMetricSample[]>([])
  const sentenceDiagnosticsRef = useRef<SentenceDiagnostic[]>([])
  const diagnosticEventsRef = useRef<DiagnosticEvent[]>([])
  const diagnosticEventsTruncatedRef = useRef(false)
  const diagnosticEventsPublishTimerRef = useRef<number | null>(null)
  const observabilityRef = useRef<ObservabilityContext>({})
  const derivedAudioBytesBySegmentRef = useRef<Map<string, number>>(new Map())
  const outputAudioStartBySegmentRef = useRef<Map<string, number>>(new Map())
  const historyRecordedRef = useRef(false)
  const sessionMetaRef = useRef({
    id: '',
    provider: '',
    transport: 'websocket' as 'websocket' | 'webrtc',
    model: '',
    sourceLanguage: '',
    targetLanguage: '',
  })
  const statusRef = useRef<Status>('idle')
  const expectedCloseRef = useRef(false)
  const failureCategoryRef = useRef('')
  const failureReasonRef = useRef('')
  const sessionGenerationRef = useRef(0)
  const playbackGenerationRef = useRef(0)
  const playbackTokenRef = useRef(0)
  const activePlaybackRef = useRef<{ token: number; segmentId: string | null } | null>(null)
  const playbackSegmentsRef = useRef<StreamedPlaybackSegments>(new Map())
  const startInFlightRef = useRef(false)
  const finishingGenerationRef = useRef<number | null>(null)
  const playerCleanupRef = useRef<{
    player: PCMStreamPlayer
    promise: Promise<{ drained: boolean; reason: string }>
  } | null>(null)

  const {
    trace,
    stability,
    traceRef,
    traceStartedAtRef,
    disconnectCountRef,
    reconnectAttemptsRef,
    maxOutputGapMsRef,
    noOutputTimeoutsRef,
    markTrace,
    markTraceOnce,
    markTraceAt,
    markDisconnect,
    markReconnectAttempt,
    markConnectionRestored,
    markOutputActivity,
    recordNoOutputTimeout,
    resetForNewSession: resetTraceForNewSession,
  } = useSessionTrace()

  const recordDiagnosticEvent = (
    producer: DiagnosticEvent['producer'],
    eventType: string,
    segmentId: string | undefined,
    rawPayload: unknown,
    receivedAtMs?: number,
  ) => {
    if (diagnosticEventsRef.current.length >= MAX_DIAGNOSTIC_EVENTS) {
      diagnosticEventsTruncatedRef.current = true
      return
    }
    const payload = sanitizeDiagnosticPayload(rawPayload)
    diagnosticEventsRef.current.push({
      sequence: diagnosticEventsRef.current.length + 1,
      producer,
      eventType: eventType.slice(0, 128),
      ...(typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs) && receivedAtMs >= 0 ? { receivedAtMs } : {}),
      ...(segmentId ? { segmentId: segmentId.slice(0, 128) } : {}),
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    })
    if (diagnosticEventsPublishTimerRef.current === null) {
      diagnosticEventsPublishTimerRef.current = window.setTimeout(() => {
        diagnosticEventsPublishTimerRef.current = null
        setDiagnosticEvents(diagnosticEventsRef.current.slice(-200))
      }, 100)
    }
  }

  useEffect(() => () => {
    if (diagnosticEventsPublishTimerRef.current !== null) {
      window.clearTimeout(diagnosticEventsPublishTimerRef.current)
    }
  }, [])

  const updateObservability = (value: ObservabilityContext) => {
    observabilityRef.current = value
    setObservability(value)
  }

  useEffect(() => {
    const recordAPIObservation = (event: Event) => {
      const observation = (event as CustomEvent<ApiObservation>).detail
      if (!observation) return
      recordDiagnosticEvent('browser', observation.event, undefined, observation)
    }
    window.addEventListener('simultrans:api-observation', recordAPIObservation)
    return () => window.removeEventListener('simultrans:api-observation', recordAPIObservation)
  }, [])

  useEffect(() => {
    if (status !== 'recording') return
    const timer = window.setInterval(() => {
      setElapsed(startedAtRef.current > 0 ? Math.floor((performance.now() - startedAtRef.current) / 1000) : 0)
    }, 500)
    return () => window.clearInterval(timer)
  }, [status])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const recordInterruptedHistory = () => {
    if (
      traceStartedAtRef.current <= 0
      || (statusRef.current !== 'connecting' && statusRef.current !== 'recording' && statusRef.current !== 'processing')
    ) return
    if (!failureCategoryRef.current) failureCategoryRef.current = 'client_navigation'
    if (!failureReasonRef.current) failureReasonRef.current = '页面在会话完成前离开；已保存当前文本快照。'
    recordHistoryRef.current('error')
  }

  useEffect(() => {
    const handlePageHide = () => recordInterruptedHistory()
    window.addEventListener('pagehide', handlePageHide)
    return () => window.removeEventListener('pagehide', handlePageHide)
  }, [])

  useEffect(() => () => {
    recordInterruptedHistory()
    sessionGenerationRef.current++
    playbackGenerationRef.current++
    activePlaybackRef.current = null
    playbackSegmentsRef.current.clear()
    processingWatchdogRef.current?.cancel()
    const recorder = recorderRef.current
    if (recorder) void recorder.stop().catch(() => undefined)
    socketRef.current?.close()
    const player = playerRef.current
    if (player) void player.close().catch(() => undefined)
    playerRef.current = null
  }, [])

  useEffect(() => () => {
    if (audioURL) URL.revokeObjectURL(audioURL)
  }, [audioURL])

  useEffect(() => () => {
    if (inputAudioURL) URL.revokeObjectURL(inputAudioURL)
  }, [inputAudioURL])

  const isCurrentSession = (generation: number, socket?: WebSocket | null) => (
    generation === sessionGenerationRef.current
    && (!socket || socketRef.current === socket)
  )

  const invalidatePlaybackHighlight = () => {
    playbackGenerationRef.current++
    activePlaybackRef.current = null
    playbackSegmentsRef.current.clear()
    setPlayingTranslationSegmentId(null)
  }

  const recordBrowserLatency = (field: keyof BrowserLatencyMetrics, valueMs: number) => {
    if (!Number.isFinite(valueMs) || valueMs < 0 || browserLatencyRef.current[field] !== null) return
    const next = { ...browserLatencyRef.current, [field]: valueMs }
    browserLatencyRef.current = next
    setBrowserLatency(next)
  }

  const recordInputSendAt = (sentAtMs: number) => {
    if (!Number.isFinite(sentAtMs) || sentAtMs < 0) return
    inputSendTimestampsRef.current.push(sentAtMs)
    const sampleCount = inputSendTimestampsRef.current.length - 1
    if (sampleCount === 0) return
    if (sampleCount > 2 && sentAtMs - inputSendMetricsPublishedAtRef.current < 1_000) return
    const metrics = calculateInputSendIntervalMetrics(inputSendTimestampsRef.current)
    inputSendMetricsPublishedAtRef.current = sentAtMs
    const next = {
      ...browserLatencyRef.current,
      inputSendIntervalP95Ms: metrics.p95Ms,
      maxInputSendGapMs: metrics.maxGapMs,
      inputSendIntervalSampleCount: metrics.sampleCount,
    }
    browserLatencyRef.current = next
    setBrowserLatency(next)
  }

  const updateCrossDomainLatency = () => {
    const sync = serverClockSyncRef.current
    if (!sync) return
    const next = { ...engineLatencyRef.current }
    let changed = false
    if (startedAtRef.current > 0 && firstModelSubmitUnixUsRef.current > 0) {
      const recordingStartServerUnixUs = clientUnixUsAt(startedAtRef.current) + sync.offsetUs
      const value = (firstModelSubmitUnixUsRef.current - recordingStartServerUnixUs) / 1000
      if (Number.isFinite(value) && value >= 0 && next.recordingToModelSubmitMs !== value) {
        next.recordingToModelSubmitMs = value
        changed = true
      }
    }
    if (firstAudioPlaybackAtRef.current > 0 && firstTTSReadyUnixUsRef.current > 0) {
      const playbackServerUnixUs = clientUnixUsAt(firstAudioPlaybackAtRef.current) + sync.offsetUs
      const value = (playbackServerUnixUs - firstTTSReadyUnixUsRef.current) / 1000
      if (Number.isFinite(value) && value >= 0 && next.ttsReadyToFirstPlaybackMs !== value) {
        next.ttsReadyToFirstPlaybackMs = value
        changed = true
      }
    }
    if (next.ttsReadyToFirstPlaybackMs === null) {
      const derived = deriveTTSReadyToPlaybackMs(
        browserLatencyRef.current.captureToFirstPlaybackMs,
        next.recordingToModelSubmitMs,
        next.modelFeedToTTSReadyMs,
      )
      if (derived !== null) {
        next.ttsReadyToFirstPlaybackMs = derived
        changed = true
      }
    }
    if (
      (next.recordingToModelSubmitMs !== null || next.ttsReadyToFirstPlaybackMs !== null)
      && next.clockSyncUncertaintyMs !== sync.uncertaintyMs
    ) {
      next.clockSyncUncertaintyMs = sync.uncertaintyMs
      changed = true
    }
    if (!changed) return
    engineLatencyRef.current = next
    setEngineLatency(next)
  }

  const drainAndClosePlayer = (player: PCMStreamPlayer) => {
    const currentCleanup = playerCleanupRef.current
    if (currentCleanup?.player === player) return currentCleanup.promise
    const previousCleanup = currentCleanup?.promise
    const promise = (async () => {
      if (previousCleanup) await previousCleanup
      let drained = true
      let reason = ''
      try {
        await player.drain()
      } catch (caught) {
        drained = false
        reason = caught instanceof Error ? caught.message : '浏览器音频输出发生未知错误。'
      }
      try {
        await player.close()
      } catch {
        // Closing is best-effort once playback can no longer be resumed.
      }
      return { drained, reason }
    })()
    const cleanup = { player, promise }
    playerCleanupRef.current = cleanup
    void promise.then(
      () => {
        if (playerCleanupRef.current === cleanup) playerCleanupRef.current = null
      },
      () => {
        if (playerCleanupRef.current === cleanup) playerCleanupRef.current = null
      },
    )
    return promise
  }

  const resetProcessingWatchdog = (generation: number) => {
    processingWatchdogRef.current?.reset(generation)
  }

  const armProcessingWatchdog = (
    generation: number,
    onTimeout: (snapshot: ProcessingWatchdogSnapshot) => void,
  ) => processingWatchdogRef.current?.arm(generation, onTimeout) ?? false

  const noteProcessingProgress = (generation: number) => (
    processingWatchdogRef.current?.noteProgress(generation) ?? false
  )

  const markProcessingDeliverable = (
    generation: number,
    kind: ProcessingDeliverableKind = 'stable-text',
    evidenceKey?: string,
  ) => (
    processingWatchdogRef.current?.noteDeliverable(generation, kind, evidenceKey) ?? false
  )

  const resetProcessingPreviewEvidence = (generation: number, evidenceKey?: string) => (
    processingWatchdogRef.current?.resetPreview(generation, evidenceKey) ?? false
  )

  const hasProcessingDeliverable = (generation: number) => (
    processingWatchdogRef.current?.hasDeliverable(generation) ?? false
  )

  const claimProcessingTerminal = (
    generation: number,
    claim: ProcessingTerminalClaim,
  ) => processingWatchdogRef.current?.claimTerminal(generation, claim) ?? false

  const clearProcessingTimeout = () => {
    processingWatchdogRef.current?.cancel()
  }

  const resetSessionState = ({ id = '', provider, transport = 'websocket', model, sourceLanguage, targetLanguage }: {
    id?: string
    provider: string
    transport?: 'websocket' | 'webrtc'
    model: string
    sourceLanguage: string
    targetLanguage: string
  }) => {
    setError('')
    setCompletionWarning('')
    setSourceText('')
    setTranslation('')
    setSourceSegments([])
    setTranslationSegments([])
    setTranslationDisplayUnits([])
    setAudioSegments([])
    setProviderLagSamples([])
    setSynthesisDurationSamples([])
    setSentenceDiagnostics([])
    setEngineLatency(emptyEngineLatency())
    setBrowserLatency(emptyBrowserLatency())
    engineLatencyRef.current = emptyEngineLatency()
    browserLatencyRef.current = emptyBrowserLatency()
    serverClockSyncRef.current = null
    firstModelSubmitUnixUsRef.current = 0
    firstTTSReadyUnixUsRef.current = 0
    firstAudioReceivedAtRef.current = 0
    firstAudioPlaybackAtRef.current = 0
    ttsWarningRef.current = ''
    setTTSWarning('')
    setAudioProcessingDiagnostics(null)
    sourceTextRef.current = ''
    translationRef.current = ''
    modelOutputTranslationRef.current = ''
    sourceSegmentsRef.current = []
    translationSegmentsRef.current = []
    translationDisplayUnitsRef.current = []
    audioSegmentsRef.current = []
    providerLagSamplesRef.current = []
    synthesisDurationSamplesRef.current = []
    sentenceDiagnosticsRef.current = []
    diagnosticEventsRef.current = []
    diagnosticEventsTruncatedRef.current = false
    if (diagnosticEventsPublishTimerRef.current !== null) {
      window.clearTimeout(diagnosticEventsPublishTimerRef.current)
      diagnosticEventsPublishTimerRef.current = null
    }
    setDiagnosticEvents([])
    observabilityRef.current = {}
    setObservability({})
    derivedAudioBytesBySegmentRef.current.clear()
    outputAudioStartBySegmentRef.current.clear()
    outputAudioRef.current = []
    inputAudioRef.current = []
    rtcStatsRef.current = null
    outputSampleRateRef.current = provider === 'volcengine' || provider === 'iflytek' || provider === 'tencent' || provider === 'youdao' || provider === 'luna' ? 16000 : 24000
    outputAudioSampleRateRef.current = null
    firstTextSeenRef.current = false
    firstAudioByteSeenRef.current = false
    firstAudioPlaybackSeenRef.current = false
    firstTextLatencyRef.current = null
    firstAudioByteLatencyRef.current = null
    firstAudioPlaybackLatencyRef.current = null
    outputAudioBytesRef.current = 0
    inputAudioBytesRef.current = 0
    inputAudioArchiveSkippedRef.current = false
    audioArchiveSkippedRef.current = false
    inputSendTimestampsRef.current = []
    inputSendMetricsPublishedAtRef.current = 0
    historyRecordedRef.current = false
    expectedCloseRef.current = false
    failureCategoryRef.current = ''
    failureReasonRef.current = ''
    startedAtRef.current = 0
    audioTimelineStartedAtRef.current = 0
    sessionMetaRef.current = { id, provider, transport, model, sourceLanguage, targetLanguage }
    invalidatePlaybackHighlight()
    setFirstTextLatency(null)
    setModelOutputTranslation('')
    setStreamingAudio(false)
    setPlaybackIncomplete(false)
    setAudioArchiveSkipped(false)
    if (inputAudioURL) URL.revokeObjectURL(inputAudioURL)
    setInputAudioURL('')
    if (audioURL) URL.revokeObjectURL(audioURL)
    setAudioURL('')
    setElapsed(0)
  }

  const recordHistory = (outcome: HistoryEntry['outcome']) => {
    if (historyRecordedRef.current || traceStartedAtRef.current <= 0) return
    historyRecordedRef.current = true
    const meta = sessionMetaRef.current
    const audioArchive: HistoryAudioArchive = {
      input: inputAudioRef.current.length > 0
        ? pcmChunksToWav(inputAudioRef.current, 16000)
        : undefined,
      output: outputAudioRef.current.length > 0
        ? pcmChunksToWav(
          outputAudioRef.current,
          outputAudioSampleRateRef.current ?? outputSampleRateRef.current,
        )
        : undefined,
      rtcStats: rtcStatsRef.current ?? undefined,
    }
    const audioReceiveToPlaybackStats = calculateValueStats(sentenceDiagnosticsRef.current.flatMap((item) => {
      if (typeof item.audioReceivedAtMs !== 'number' || typeof item.playbackStartedAtMs !== 'number') return []
      const value = item.playbackStartedAtMs - item.audioReceivedAtMs
      return Number.isFinite(value) && value >= 0 ? [value] : []
    }))
    const ttsRTFStats = calculateValueStats(sentenceDiagnosticsRef.current.flatMap((item) => {
      if (typeof item.synthesisDurationMs !== 'number' || typeof item.audioDurationMs !== 'number' || item.audioDurationMs <= 0) return []
      const value = item.synthesisDurationMs / item.audioDurationMs
      return Number.isFinite(value) && value >= 0 ? [value] : []
    }))
    const inputSendMetrics = calculateInputSendIntervalMetrics(inputSendTimestampsRef.current)
    if (inputSendMetrics.sampleCount > 0) {
      const finalBrowserLatency = {
        ...browserLatencyRef.current,
        inputSendIntervalP95Ms: inputSendMetrics.p95Ms,
        maxInputSendGapMs: inputSendMetrics.maxGapMs,
        inputSendIntervalSampleCount: inputSendMetrics.sampleCount,
      }
      browserLatencyRef.current = finalBrowserLatency
      setBrowserLatency(finalBrowserLatency)
    }
    const entry: HistoryEntry = {
      schemaVersion: 3,
      id: meta.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      provider: meta.provider,
      transport: meta.transport,
      model: meta.model,
      sourceLanguage: meta.sourceLanguage,
      targetLanguage: meta.targetLanguage,
      sourceText: sourceTextRef.current,
      translationText: translationRef.current,
      sourceSegments: [...sourceSegmentsRef.current],
      translationSegments: [...translationSegmentsRef.current],
      sentenceDiagnostics: sentenceDiagnosticsRef.current.slice(0, 1_000),
      latencyAnalysisTruncated: sentenceDiagnosticsRef.current.length > 1_000,
      diagnosticEvents: [...diagnosticEventsRef.current],
      diagnosticEventsTruncated: diagnosticEventsTruncatedRef.current,
      observability: { ...observabilityRef.current },
      ...historyTimelineStats(translationSegmentsRef.current),
      ...historyAudioTimelineStats(audioSegmentsRef.current),
      ...historyNativeMetricStats(providerLagSamplesRef.current, 'providerLag'),
      ...historyNativeMetricStats(synthesisDurationSamplesRef.current, 'synthesisDuration'),
      audioReceiveToPlaybackAverageMs: audioReceiveToPlaybackStats.averageMs,
      audioReceiveToPlaybackP95Ms: audioReceiveToPlaybackStats.p95Ms,
      audioReceiveToPlaybackSampleCount: audioReceiveToPlaybackStats.sampleCount,
      ttsRTFAverage: ttsRTFStats.averageMs,
      ttsRTFP95: ttsRTFStats.p95Ms,
      ttsRTFSampleCount: ttsRTFStats.sampleCount,
      inputSendIntervalP95Ms: inputSendMetrics.p95Ms,
      maxInputSendGapMs: inputSendMetrics.maxGapMs,
      inputSendIntervalSampleCount: inputSendMetrics.sampleCount,
      engineFirstModelTokenMs: engineLatencyRef.current.firstModelTokenMs,
      engineFirstTextMs: engineLatencyRef.current.firstTextMs,
      engineFirstTTSReadyMs: engineLatencyRef.current.firstTTSReadyMs,
      engineAudioToModelFeedMs: engineLatencyRef.current.audioToModelFeedMs,
      engineModelFeedToFirstOutputMs: engineLatencyRef.current.modelFeedToFirstOutputMs,
      engineModelFeedToStableTextMs: engineLatencyRef.current.modelFeedToStableTextMs,
      engineModelFeedToTTSReadyMs: engineLatencyRef.current.modelFeedToTTSReadyMs,
      recordingToModelSubmitMs: engineLatencyRef.current.recordingToModelSubmitMs,
      ttsReadyToFirstPlaybackMs: engineLatencyRef.current.ttsReadyToFirstPlaybackMs,
      clockSyncUncertaintyMs: engineLatencyRef.current.clockSyncUncertaintyMs,
      browserCaptureToWSSendMs: browserLatencyRef.current.captureToWSSendMs,
      browserCaptureToFirstTextMs: browserLatencyRef.current.captureToFirstTextMs,
      browserCaptureToFirstStableSentenceMs: browserLatencyRef.current.captureToFirstStableSentenceMs,
      browserCaptureToFirstAudioMs: browserLatencyRef.current.captureToFirstAudioMs,
      browserFirstAudioReceiveToPlaybackScheduledMs: browserLatencyRef.current.firstAudioReceiveToPlaybackScheduledMs,
      browserCaptureToFirstPlaybackScheduledMs: browserLatencyRef.current.captureToFirstPlaybackScheduledMs,
      browserFirstAudioReceiveToPlaybackMs: browserLatencyRef.current.firstAudioReceiveToPlaybackMs,
      browserCaptureToFirstPlaybackMs: browserLatencyRef.current.captureToFirstPlaybackMs,
      ttsError: ttsWarningRef.current || undefined,
      inputAudioAvailable: audioArchive.input !== undefined,
      outputAudioAvailable: audioArchive.output !== undefined,
      firstTextLatency: firstTextLatencyRef.current,
      firstAudioByteLatency: firstAudioByteLatencyRef.current,
      firstAudioPlaybackLatency: firstAudioPlaybackLatencyRef.current,
      outcome,
      errorCategory: failureCategoryRef.current || undefined,
      errorReason: failureReasonRef.current || undefined,
      disconnectCount: disconnectCountRef.current,
      reconnectAttempts: reconnectAttemptsRef.current,
      maxOutputGapMs: maxOutputGapMsRef.current,
      noOutputTimeouts: noOutputTimeoutsRef.current,
      sessionDurationMs: Math.max(0, performance.now() - traceStartedAtRef.current),
      trace: { ...traceRef.current },
    }
    onSessionRecordedRef.current(entry, audioArchive)
  }
  recordHistoryRef.current = recordHistory

  const setFailure = (message: string, category = 'service_error') => {
    failureCategoryRef.current = category
    failureReasonRef.current = message
  }

  const finishAudio = async (
    generation: number,
    socket: WebSocket,
    player: PCMStreamPlayer,
    providerTerminal = true,
  ) => {
    if (
      !isCurrentSession(generation, socket)
      || playerRef.current !== player
      || finishingGenerationRef.current === generation
      || !claimProcessingTerminal(generation, 'completed')
    ) return
    finishingGenerationRef.current = generation
    expectedCloseRef.current = true
    socket.close()
    clearProcessingTimeout()
    if (providerTerminal) markTraceOnce('providerFinished')
    statusRef.current = 'processing'
    setStatus('processing')
    const recorder = recorderRef.current
    let recorderStop: Promise<Error | null> = Promise.resolve(null)
    if (recorder) {
      recorderRef.current = null
      recorderStop = recorder.stop().then(
        () => null,
        (caught) => caught instanceof Error ? caught : new Error('未知错误'),
      )
    }
    const playbackDrain = drainAndClosePlayer(player).then((playback) => {
      if (playback.drained) markTraceOnce('playbackDrained')
      return playback
    })
    const [playback, recorderStopError] = await Promise.all([playbackDrain, recorderStop])
    if (!isCurrentSession(generation, socket)) return
    invalidatePlaybackHighlight()
    if (playerRef.current === player) playerRef.current = null
    if (socketRef.current === socket) socketRef.current = null
    if (!playback.drained) {
      const message = `已接收的翻译音频未能完整播放：${playback.reason}`
      failureCategoryRef.current = 'audio_output'
      failureReasonRef.current = message
      setError(message)
      setStreamingAudio(false)
      setPlaybackIncomplete(true)
      statusRef.current = 'error'
      setStatus('error')
      recordHistory('error')
      if (finishingGenerationRef.current === generation) finishingGenerationRef.current = null
      return
    }
    if (recorderStopError) {
      const message = `无法停止麦克风：${recorderStopError.message}`
      failureCategoryRef.current = 'capture_error'
      failureReasonRef.current = message
      setError(message)
      setStreamingAudio(false)
      statusRef.current = 'error'
      setStatus('error')
      recordHistory('error')
      if (finishingGenerationRef.current === generation) finishingGenerationRef.current = null
      return
    }
    const chunks = outputAudioRef.current
    if (inputAudioRef.current.length > 0) {
      setInputAudioURL(URL.createObjectURL(pcmChunksToWav(inputAudioRef.current, 16000)))
    }
    if (chunks.length > 0) {
      const blob = pcmChunksToWav(
        chunks,
        outputAudioSampleRateRef.current ?? outputSampleRateRef.current,
      )
      setAudioURL(URL.createObjectURL(blob))
    }
    statusRef.current = 'finished'
    setStatus('finished')
    markTraceOnce('finished')
    recordHistory('completed')
    if (finishingGenerationRef.current === generation) finishingGenerationRef.current = null
  }

  const fail = (
    message: string,
    category = 'service_error',
    generation = sessionGenerationRef.current,
    socket = socketRef.current,
    player = playerRef.current,
  ) => {
    if (
      !isCurrentSession(generation, socket)
      || statusRef.current === 'error'
      || finishingGenerationRef.current === generation
      || !claimProcessingTerminal(generation, 'failed')
    ) return
    clearProcessingTimeout()
    if (category === 'no_output_timeout') recordNoOutputTimeout()
    failureCategoryRef.current = category
    failureReasonRef.current = message
    const shouldRecordHistory = traceStartedAtRef.current > 0
    if (shouldRecordHistory) markTrace('failed')
    setError(message)
    const recorder = recorderRef.current
    if (recorder) {
      recorderRef.current = null
      void recorder.stop().catch(() => undefined)
    }
    expectedCloseRef.current = true
    socket?.close()
    finishingGenerationRef.current = generation
    if (!player) {
      invalidatePlaybackHighlight()
      statusRef.current = 'error'
      setStatus('error')
      if (shouldRecordHistory) recordHistory('error')
      if (finishingGenerationRef.current === generation) finishingGenerationRef.current = null
      return
    }
    statusRef.current = 'processing'
    setStatus('processing')
    const cleanup = drainAndClosePlayer(player)
    void cleanup.then((playback) => {
      if (!isCurrentSession(generation, socket)) return
      if (playback.drained) markTraceOnce('playbackDrained')
      invalidatePlaybackHighlight()
      if (playerRef.current === player) playerRef.current = null
      if (socketRef.current === socket) socketRef.current = null
      setStreamingAudio(false)
      if (!playback.drained) {
        const playbackMessage = `${message} 已接收的翻译音频未能完整播放：${playback.reason}`
        failureCategoryRef.current = 'audio_output'
        failureReasonRef.current = playbackMessage
        setError(playbackMessage)
        setPlaybackIncomplete(true)
      }
      statusRef.current = 'error'
      setStatus('error')
      if (shouldRecordHistory) recordHistory('error')
      if (finishingGenerationRef.current === generation) finishingGenerationRef.current = null
    })
  }

  return {
    status, sourceText, translation, modelOutputTranslation, sourceSegments, translationSegments, translationDisplayUnits,
    audioSegments,
    providerLagSamples, synthesisDurationSamples, sentenceDiagnostics, diagnosticEvents, observability, error, completionWarning, inputAudioURL, audioURL, elapsed, firstTextLatency,
    playingTranslationSegmentId, engineLatency, browserLatency, ttsWarning, audioProcessingDiagnostics,
    streamingAudio, playbackIncomplete, audioArchiveSkipped, trace, stability,
    setStatus, setError, setCompletionWarning, setSourceText, setTranslation, setModelOutputTranslation, setSourceSegments, setTranslationSegments,
    setTranslationDisplayUnits, setPlayingTranslationSegmentId, setTTSWarning,
    setEngineLatency, setBrowserLatency, setInputAudioURL, setAudioURL, setAudioProcessingDiagnostics,
    setAudioSegments, setProviderLagSamples, setSynthesisDurationSamples, setSentenceDiagnostics, setFirstTextLatency,
    setStreamingAudio, setAudioArchiveSkipped,
    socketRef, recorderRef, playerRef, playerCleanupRef, outputAudioRef, inputAudioRef, rtcStatsRef,
    inputAudioBytesRef, inputAudioArchiveSkippedRef, outputSampleRateRef, outputAudioSampleRateRef,
    outputAudioBytesRef, audioArchiveSkippedRef, startedAtRef, audioTimelineStartedAtRef,
    firstAudioReceivedAtRef, firstAudioPlaybackAtRef, engineLatencyRef, browserLatencyRef,
    serverClockSyncRef, firstModelSubmitUnixUsRef, firstTTSReadyUnixUsRef, ttsWarningRef,
    firstTextSeenRef, firstTextLatencyRef, firstAudioByteSeenRef, firstAudioByteLatencyRef,
    firstAudioPlaybackSeenRef, firstAudioPlaybackLatencyRef, sourceTextRef, translationRef, modelOutputTranslationRef,
    sourceSegmentsRef, translationSegmentsRef, translationDisplayUnitsRef, audioSegmentsRef, providerLagSamplesRef,
    synthesisDurationSamplesRef, sentenceDiagnosticsRef, diagnosticEventsRef, derivedAudioBytesBySegmentRef, outputAudioStartBySegmentRef, sessionMetaRef, statusRef, expectedCloseRef,
    sessionGenerationRef, startInFlightRef, finishingGenerationRef,
    playbackGenerationRef, playbackTokenRef, activePlaybackRef, playbackSegmentsRef,
    isCurrentSession, drainAndClosePlayer, clearProcessingTimeout,
    resetProcessingWatchdog, armProcessingWatchdog, noteProcessingProgress,
    markProcessingDeliverable, resetProcessingPreviewEvidence,
    hasProcessingDeliverable, claimProcessingTerminal,
    recordBrowserLatency, recordInputSendAt, recordDiagnosticEvent, updateObservability, updateCrossDomainLatency,
    resetSessionState, recordHistory, setFailure, finishAudio, fail, markTrace, markTraceOnce, markTraceAt,
    markDisconnect, markReconnectAttempt, markConnectionRestored, markOutputActivity, recordNoOutputTimeout, resetTraceForNewSession,
  }
}

export type SessionRuntime = ReturnType<typeof useSessionRuntime>

export function sanitizeDiagnosticPayload(value: unknown): Record<string, string | number | boolean | null> {
  if (value === null || typeof value !== 'object') return {}
  const payload: Record<string, string | number | boolean | null> = {}
  const visit = (candidate: unknown, path: string, depth: number) => {
    if (!path || Object.keys(payload).length >= 64 || sensitiveDiagnosticKey(path)) return
    const key = path.slice(0, 128)
    if (candidate === null || typeof candidate === 'boolean') payload[key] = candidate
    else if (typeof candidate === 'number' && Number.isFinite(candidate)) payload[key] = candidate
    else if (typeof candidate === 'string') payload[key] = candidate.slice(0, 4_000)
    else if (Array.isArray(candidate)) {
      const primitives = candidate.filter((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 100)
      if (primitives.length > 0) payload[key] = JSON.stringify(primitives).slice(0, 4_000)
    } else if (candidate && typeof candidate === 'object' && depth < 3) {
      for (const [childKey, child] of Object.entries(candidate)) visit(child, `${path}.${childKey}`, depth + 1)
    }
  }
  for (const [key, candidate] of Object.entries(value)) visit(candidate, key, 0)
  return payload
}

function sensitiveDiagnosticKey(value: string) {
  const key = value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const leaf = (value.split('.').at(-1) || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const credentialToken = leaf === 'token' || ['accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken'].some((marker) => leaf.includes(marker))
  return leaf === 'audio' || leaf.endsWith('audio') || credentialToken || ['secret', 'authorization', 'password', 'cookie', 'credential', 'apikey', 'accesskey', 'signature'].some((marker) => key.includes(marker))
}
