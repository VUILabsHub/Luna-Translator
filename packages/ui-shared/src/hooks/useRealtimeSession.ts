import { apiURL } from '../lib/apiBase'
import { observeSharePCMBytes } from '@simultrans/core/liveShareAudio'
// Change record (2026-08-05): hold the blue translation highlight across all
// streamed TTS chunks and clear it only after sentence completion and playout.
// Change record (2026-08-05): render cumulative model snapshots immediately,
// but count first text only when the snapshot is explicitly stable.
import { type RefObject, useEffect, useRef, useState } from 'react'
import { accumulatePCM16SegmentDurationMs, createPCMStreamPlayer, createRecorder, pcm16HasSignal, type AudioProcessingDiagnostics, type PCMStreamPlayer, type RecorderFactory, type RecorderHandle } from '../audio'
import { queueHistoryPCMChunk, type HistoryAudioArchive } from '../historyAudio'
import { isFixedCloneProvider, isOmniS2STProvider, isVUILabsOmniProvider, usesExperimentalWorkspaceUI } from '../languageCapabilities'
import { synchronizeServerClock } from '../lib/clockSync'
import { createApiTraceContext, traceparentFor } from '../lib/apiFetch'
import { decodeBase64, waitForOpen } from '../lib/realtimeSocket'
import { upsertSentenceDiagnostic } from '../lib/sentenceDiagnostics'
import { orderedShowcasePairs } from '../lib/showcaseRows'
import {
  emptyVadTranscriptPairState,
  reduceVadTranscriptPairEvent,
  sourceVadStartMsForEvent,
  type VadTranscriptPair,
  type VadTranscriptPairState,
} from '../lib/vadTranscriptPairs'
import { finishPlaybackChunk, finishPlaybackInput, queuePlaybackChunk } from '../lib/streamedPlayback'
import {
  applyOutputAudioStarts,
  cumulativeTranscriptSegments,
  emptyCumulativeTranscriptState,
  nextTranslationSnapshot,
  reconcileCumulativeTranscript,
  reconcileStreamingTranslationSegments,
  upsertNativeMetricSample,
  upsertTimedAudioSegment,
  upsertTimedSegment,
  upsertTranslationDisplayUnit,
  type CumulativeTranscriptState,
} from '../lib/transcript'
import {
  CONNECTION_TIMEOUT_MS,
  appendPCMArchiveChunk,
  applyProcessingEventEvidence,
  processingTimeoutFailure,
  useSessionRuntime,
  type ProcessingEvidenceActions,
  type Status,
} from './useSessionRuntime'
import type {
  BrowserLatencyMetrics,
  DiagnosticEvent,
  EngineLatencyMetrics,
  HistoryEntry,
  NativeMetricSample,
  ObservabilityContext,
  SentenceDiagnostic,
  ServerEvent,
  SessionTrace,
  StabilityMetrics,
  TimedAudioSegment,
  TimedTranscriptSegment,
  TranslationDisplayUnit,
} from '../types/history'
import { useLiveKitRealtimeSession } from './useLiveKitRealtimeSession'
import { createVolcRTCBridge } from '../lib/volcRTCTransport'
import type { RealtimeService, SourceASRProvider } from '../lib/config'
import type { VADLoudnessMode, VADLoudnessThresholdDbfs } from '../lib/audioProcessing'
import type { BrowserAudioProcessingOptions } from '../audio'

export type { Status }

export type RealtimeSessionOptions = {
  provider: string
  baseProviderId?: string
  asrProvider: SourceASRProvider
  transport?: 'websocket' | 'webrtc'
  service?: RealtimeService
  model: string
  sourceLanguage: string
  targetLanguage: string
  asrContext?: string
  asrContextOverride?: boolean
  effectiveVoiceClone: boolean
  selectedVoice: string
  deepFilterNet: boolean
  qwen3SimulSystemPrompt?: string
  qwen3ModelIntervalMs: 1000 | 2000
  vadLoudnessMode: VADLoudnessMode
  vadLoudnessThresholdDbfs: VADLoudnessThresholdDbfs
  ready: boolean
  notReadyReason: string
  inputDeviceId: string
  outputDeviceId: string
  webRTCEchoCancellation?: boolean
  browserAudioProcessing?: BrowserAudioProcessingOptions
  refreshAudioDevices: () => void
  onSessionRecorded: (entry: HistoryEntry, audio: HistoryAudioArchive) => void
  /** Silences browser playback without disabling synthesis or audio archival. */
  playbackMuted?: boolean
  webSocketRuntimeFactory?: WebSocketRealtimeRuntimeFactory
}

export type WebSocketRealtimeRuntimeFactoryOptions = {
  provider: string
  inputDeviceId: string
  outputDeviceId: string
  echoCancellation: boolean
  browserAudioProcessing?: BrowserAudioProcessingOptions
  onAudioPlaybackBlocked: () => void
}

export type WebSocketRealtimeRuntime = {
  player: PCMStreamPlayer
  createRecorder: RecorderFactory
  resumeAudioPlayback?: () => Promise<void>
}

export type WebSocketRealtimeRuntimeFactory = (
  options: WebSocketRealtimeRuntimeFactoryOptions,
) => WebSocketRealtimeRuntime | Promise<WebSocketRealtimeRuntime>

export type RealtimeSession = {
  status: Status
  error: string
  completionWarning: string
  setError: (message: string) => void
  sourceText: string
  translation: string
  modelOutputTranslation: string
  sourceSegments: TimedTranscriptSegment[]
  translationSegments: TimedTranscriptSegment[]
  translationDisplayUnits: TranslationDisplayUnit[]
  vadTranscriptPairs?: VadTranscriptPair[]
  playingTranslationSegmentId: string | null
  audioSegments: TimedAudioSegment[]
  providerLagSamples: NativeMetricSample[]
  synthesisDurationSamples: NativeMetricSample[]
  sentenceDiagnostics: SentenceDiagnostic[]
  diagnosticEvents: DiagnosticEvent[]
  observability: ObservabilityContext
  trace: SessionTrace
  stability: StabilityMetrics
  engineLatency: EngineLatencyMetrics
  browserLatency: BrowserLatencyMetrics
  ttsWarning: string
  audioProcessingDiagnostics: AudioProcessingDiagnostics | null
  firstTextLatency: number | null
  elapsed: number
  inputAudioURL: string
  audioURL: string
  streamingAudio: boolean
  playbackIncomplete: boolean
  audioArchiveSkipped: boolean
  audioPlaybackBlocked: boolean
  outputAudioRef: RefObject<Uint8Array[]>
  start: () => Promise<void>
  stop: () => Promise<void>
  resumeAudioPlayback: () => Promise<void>
}

export function applyWebSocketProcessingEventEvidence(
  event: ServerEvent,
  generation: number,
  actions: ProcessingEvidenceActions,
  hasAudioSignal = false,
) {
  return applyProcessingEventEvidence(event, generation, actions, hasAudioSignal)
}

export function finalWebSocketTranslationSnapshot(
  stableTranslation: string,
  pairs: VadTranscriptPair[],
) {
  const stable = stableTranslation.trim()
  if (stable) return stable
  return orderedShowcasePairs(pairs)
    .map((pair) => pair.translation.trim())
    .filter(Boolean)
    .join('\n')
}

export function realtimeServiceForSession(
  options: Pick<RealtimeSessionOptions, 'service' | 'transport'>,
): RealtimeService {
  return options.service || (options.transport === 'webrtc' ? 'livekit' : 'websocket')
}

export function realtimeTransportForSession(
  options: Pick<RealtimeSessionOptions, 'service' | 'transport'>,
): 'websocket' | 'webrtc' {
  return realtimeServiceForSession(options) === 'websocket' ? 'websocket' : 'webrtc'
}

export function backendProviderForRealtimeSession(
  options: Pick<RealtimeSessionOptions, 'provider' | 'baseProviderId'>,
) {
  return options.baseProviderId?.trim() || options.provider
}

const createDefaultWebSocketRuntime: WebSocketRealtimeRuntimeFactory = async ({
  inputDeviceId,
  outputDeviceId,
  browserAudioProcessing,
}) => ({
  player: await createPCMStreamPlayer(outputDeviceId),
  createRecorder: (onPCM) => createRecorder(onPCM, inputDeviceId, { browserAudioProcessing }),
})

function useWebSocketRealtimeSession(options: RealtimeSessionOptions): RealtimeSession {
  const {
    provider, asrProvider, model, sourceLanguage, targetLanguage, effectiveVoiceClone, selectedVoice, deepFilterNet,
    qwen3ModelIntervalMs, vadLoudnessMode, vadLoudnessThresholdDbfs,
    ready, notReadyReason, inputDeviceId, outputDeviceId, refreshAudioDevices, onSessionRecorded,
    webRTCEchoCancellation = true, browserAudioProcessing, playbackMuted = false, webSocketRuntimeFactory,
  } = options
  const service = realtimeServiceForSession(options)
  const sessionTransport = realtimeTransportForSession(options)
  const backendProvider = backendProviderForRealtimeSession(options)
  const runtimeFactory = webSocketRuntimeFactory || (
    service === 'volc-rtc' ? createVolcRTCBridge : createDefaultWebSocketRuntime
  )
  const runtime = useSessionRuntime({ onSessionRecorded })
  const {
    status, sourceText, translation, modelOutputTranslation, sourceSegments, translationSegments, translationDisplayUnits,
    audioSegments,
    providerLagSamples, synthesisDurationSamples, sentenceDiagnostics, diagnosticEvents, observability, error, completionWarning, inputAudioURL, audioURL, elapsed, firstTextLatency,
    playingTranslationSegmentId, engineLatency, browserLatency, ttsWarning, audioProcessingDiagnostics,
    streamingAudio, playbackIncomplete, audioArchiveSkipped, trace, stability,
    setStatus, setError, setCompletionWarning, setSourceText, setTranslation, setModelOutputTranslation, setSourceSegments, setTranslationSegments,
    setTranslationDisplayUnits, setPlayingTranslationSegmentId, setTTSWarning,
    setEngineLatency, setAudioProcessingDiagnostics,
    setAudioSegments, setProviderLagSamples, setSynthesisDurationSamples, setSentenceDiagnostics, setFirstTextLatency,
    setStreamingAudio, setAudioArchiveSkipped,
    socketRef, recorderRef, playerRef, playerCleanupRef, outputAudioRef, inputAudioRef,
    inputAudioBytesRef, inputAudioArchiveSkippedRef, outputSampleRateRef, outputAudioSampleRateRef,
    outputAudioBytesRef, audioArchiveSkippedRef, startedAtRef, audioTimelineStartedAtRef,
    firstAudioReceivedAtRef, firstAudioPlaybackAtRef, engineLatencyRef, browserLatencyRef,
    serverClockSyncRef, firstModelSubmitUnixUsRef, firstTTSReadyUnixUsRef, ttsWarningRef,
    firstTextSeenRef, firstTextLatencyRef, firstAudioByteSeenRef, firstAudioByteLatencyRef,
    firstAudioPlaybackSeenRef, firstAudioPlaybackLatencyRef, sourceTextRef, translationRef, modelOutputTranslationRef,
    sourceSegmentsRef, translationSegmentsRef, translationDisplayUnitsRef, audioSegmentsRef, providerLagSamplesRef,
    synthesisDurationSamplesRef, sentenceDiagnosticsRef, derivedAudioBytesBySegmentRef, outputAudioStartBySegmentRef, sessionMetaRef, statusRef, expectedCloseRef,
    sessionGenerationRef, startInFlightRef, finishingGenerationRef,
    playbackGenerationRef, playbackTokenRef, activePlaybackRef, playbackSegmentsRef,
    isCurrentSession, drainAndClosePlayer, clearProcessingTimeout,
    resetProcessingWatchdog, armProcessingWatchdog, noteProcessingProgress,
    markProcessingDeliverable, resetProcessingPreviewEvidence,
    recordBrowserLatency, recordInputSendAt, recordDiagnosticEvent, updateObservability, updateCrossDomainLatency,
    resetSessionState, setFailure, finishAudio, fail, markTrace, markTraceOnce, markTraceAt,
    markDisconnect, markOutputActivity, resetTraceForNewSession,
  } = runtime
  const cumulativeSourceRef = useRef<CumulativeTranscriptState>(emptyCumulativeTranscriptState())
  const vadTranscriptStateRef = useRef<VadTranscriptPairState>(emptyVadTranscriptPairState())
  const playbackMutedRef = useRef(playbackMuted)
  const resumeAudioPlaybackRef = useRef<(() => Promise<void>) | null>(null)
  const [vadTranscriptPairs, setVadTranscriptPairs] = useState<VadTranscriptPair[]>([])
  const [audioPlaybackBlocked, setAudioPlaybackBlocked] = useState(false)

  playbackMutedRef.current = playbackMuted
  useEffect(() => {
    playerRef.current?.setMuted(playbackMuted)
  }, [playbackMuted, playerRef])

  const start = async () => {
    if (!ready) {
      setError(notReadyReason)
      statusRef.current = 'error'
      setStatus('error')
      return
    }
    if (
      startInFlightRef.current
      || statusRef.current === 'connecting'
      || statusRef.current === 'recording'
      || statusRef.current === 'processing'
    ) return

    const generation = ++sessionGenerationRef.current
    resetProcessingWatchdog(generation)
    startInFlightRef.current = true
    finishingGenerationRef.current = null
    statusRef.current = 'connecting'
    setStatus('connecting')
    let player: PCMStreamPlayer | null = null
    let socket: WebSocket | null = null
    let recorder: RecorderHandle | null = null

    try {
      setAudioPlaybackBlocked(false)
      resumeAudioPlaybackRef.current = null
      const clockSyncPromise = synchronizeServerClock().catch(() => null)
      const pendingCleanup = playerCleanupRef.current
      if (pendingCleanup) {
        await pendingCleanup.promise
        if (playerRef.current === pendingCleanup.player) playerRef.current = null
      }
      const previousPlayer = playerRef.current
      if (previousPlayer) {
        await drainAndClosePlayer(previousPlayer)
        if (playerRef.current === previousPlayer) playerRef.current = null
      }
      if (!isCurrentSession(generation)) return

      cumulativeSourceRef.current = emptyCumulativeTranscriptState()
      vadTranscriptStateRef.current = emptyVadTranscriptPairState()
      setVadTranscriptPairs([])
      const sessionId = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const sessionTrace = createApiTraceContext()
      resetSessionState({ id: sessionId, provider, transport: sessionTransport, model, sourceLanguage, targetLanguage })
      resetTraceForNewSession()
      const sessionObservability = {
        traceId: sessionTrace.traceId,
        requestId: sessionTrace.requestId,
        sessionId,
      }
      updateObservability(sessionObservability)
      recordDiagnosticEvent('browser', 'session_trace_created', undefined, sessionObservability)

      const sessionRuntime = await runtimeFactory({
        provider,
        inputDeviceId,
        outputDeviceId,
        echoCancellation: webRTCEchoCancellation,
        browserAudioProcessing,
        onAudioPlaybackBlocked: () => {
          if (isCurrentSession(generation)) setAudioPlaybackBlocked(true)
        },
      })
      resumeAudioPlaybackRef.current = sessionRuntime.resumeAudioPlayback || null
      player = sessionRuntime.player
      if (!isCurrentSession(generation)) {
        await player.close()
        return
      }
      playerRef.current = player
      const sessionPlayer = player
      sessionPlayer.setMuted(playbackMutedRef.current)
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const sessionSocket = new WebSocket(apiURL(`${protocol}//${window.location.host}/ws/translate`))
      socket = sessionSocket
      sessionSocket.binaryType = 'arraybuffer'
      socketRef.current = sessionSocket
      await waitForOpen(sessionSocket, CONNECTION_TIMEOUT_MS)
      if (!isCurrentSession(generation, sessionSocket)) {
        sessionSocket.close()
        await sessionPlayer.close()
        return
      }
      markTrace('socketOpen')
      recordDiagnosticEvent('browser', 'socket_open', undefined, { transport: sessionTransport })
      sessionSocket.onmessage = (message) => {
        if (!isCurrentSession(generation, sessionSocket)) return
        let event: ServerEvent
        try {
          event = JSON.parse(message.data) as ServerEvent
        } catch {
          return
        }
        handleEvent(event, generation, sessionSocket, sessionPlayer)
      }
      sessionSocket.onerror = () => {
        if (
          !isCurrentSession(generation, sessionSocket)
          || expectedCloseRef.current
          || finishingGenerationRef.current === generation
        ) return
        markDisconnect()
        fail('翻译连接中断，请检查网络和服务配置。', 'disconnected', generation, sessionSocket, sessionPlayer)
      }
      sessionSocket.onclose = () => {
        if (!isCurrentSession(generation, sessionSocket)) return
        if (!expectedCloseRef.current && (statusRef.current === 'connecting' || statusRef.current === 'recording' || statusRef.current === 'processing')) {
          markDisconnect()
          fail('翻译连接已关闭。', 'disconnected', generation, sessionSocket, sessionPlayer)
        }
      }
      sessionSocket.send(JSON.stringify({
        type: 'start',
        sessionId,
        transport: sessionTransport,
        requestId: sessionTrace.requestId,
        traceparent: traceparentFor(sessionTrace),
        eventSchemaVersion: 1,
        provider: backendProvider,
        asrProvider,
        asrContext: options.asrContext,
        asrContextOverride: options.asrContextOverride,
        sourceLanguage,
        targetLanguage,
        voiceClone: effectiveVoiceClone,
        voiceCloneFrequency: 'once',
        voice: effectiveVoiceClone ? '' : selectedVoice,
        deepFilterNet,
        qwen3SimulSystemPrompt: options.qwen3SimulSystemPrompt,
        qwen3ModelIntervalMs,
        vadLoudnessThresholdDbfs,
        vadLoudnessMode,
        asrUseFilteredAudio: true,
      }))
      recordDiagnosticEvent('browser', 'session_start_sent', undefined, {
        ...sessionObservability,
        provider,
        transport: sessionTransport,
        sourceLanguage,
        targetLanguage,
      })
      serverClockSyncRef.current = await clockSyncPromise
      updateCrossDomainLatency()

      const consumePCM = (pcm: ArrayBuffer) => {
        if (
          !isCurrentSession(generation, sessionSocket)
          || playerRef.current !== sessionPlayer
          || (statusRef.current !== 'connecting' && statusRef.current !== 'recording')
        ) return
        const callbackAt = performance.now()
        if (startedAtRef.current <= 0) {
          const chunkDurationMs = pcm.byteLength / 2 / 16_000 * 1000
          const recordingStartedAt = callbackAt - chunkDurationMs
          startedAtRef.current = recordingStartedAt
          audioTimelineStartedAtRef.current = recordingStartedAt
          markTraceAt('captureStarted', recordingStartedAt)
          updateCrossDomainLatency()
        }
        if (!inputAudioArchiveSkippedRef.current) {
          const chunk = new Uint8Array(pcm.slice(0))
          const archived = appendPCMArchiveChunk(inputAudioRef.current, inputAudioBytesRef.current, chunk)
          if (!archived.truncated) queueHistoryPCMChunk(sessionMetaRef.current.id, 'input', chunk, 16000)
          inputAudioBytesRef.current = archived.receivedBytes
          if (archived.truncated) {
            inputAudioArchiveSkippedRef.current = true
          }
        }
        if (sessionSocket.readyState === WebSocket.OPEN) {
          sessionSocket.send(pcm)
          const sentAt = performance.now()
          recordBrowserLatency('captureToWSSendMs', Math.max(0, sentAt - startedAtRef.current))
          recordInputSendAt(sentAt)
        }
      }
      recorder = await sessionRuntime.createRecorder(consumePCM)
      if (
        !isCurrentSession(generation, sessionSocket)
        || playerRef.current !== sessionPlayer
        || statusRef.current !== 'connecting'
      ) {
        await recorder.stop()
        return
      }
      recorderRef.current = recorder
      setAudioProcessingDiagnostics(recorder.diagnostics)
      refreshAudioDevices()
      statusRef.current = 'recording'
      setStatus('recording')
    } catch (caught) {
      if (!isCurrentSession(generation, socket)) {
        await recorder?.stop().catch(() => undefined)
        socket?.close()
        await player?.close().catch(() => undefined)
        return
      }
      fail(
        caught instanceof Error ? caught.message : '无法启动麦克风。',
        'service_error',
        generation,
        socket,
        player,
      )
    } finally {
      startInFlightRef.current = false
    }
  }

  const stop = async () => {
    if (statusRef.current !== 'recording') return
    const generation = sessionGenerationRef.current
    const socket = socketRef.current
    const recorder = recorderRef.current
    const player = playerRef.current
    statusRef.current = 'processing'
    setStatus('processing')
    markTrace('inputStopped')
    armProcessingWatchdog(generation, (snapshot) => {
      // The raw model snapshot is session-cumulative and is intentionally not
      // suitable for archival: a later model_output_reset may have removed one
      // utterance from the visible paired state. Derive forced-completion text
      // from the current reducer state so reset/reordering semantics are kept.
      const finalTranslation = finalWebSocketTranslationSnapshot(
        translationRef.current,
        vadTranscriptStateRef.current.pairs,
      )
      const timeoutFailure = processingTimeoutFailure(
        snapshot.audioDeliverable || Boolean(finalTranslation),
        snapshot.progressSeen,
        sessionTransport,
      )
      if (timeoutFailure.graceful) {
        recordDiagnosticEvent('browser', 'processing_completion_timeout', undefined, {
          transport: sessionTransport, deliverable: true,
        })
        setFailure(timeoutFailure.message, timeoutFailure.category)
        setCompletionWarning(timeoutFailure.message)
        if (finalTranslation !== translationRef.current) {
          translationRef.current = finalTranslation
          setTranslation(finalTranslation)
        }
        if (socket && player) {
          void finishAudio(generation, socket, player, false)
        } else {
          fail(
            '会话已有可交付输出，但本地播放器或连接已丢失，无法安全完成归档。',
            'completion_timeout',
            generation,
            socket,
            player,
          )
        }
        return
      }
      fail(
        timeoutFailure.message,
        timeoutFailure.category,
        generation,
        socket,
        player,
      )
    })
    try {
      await recorder?.stop()
    } catch (caught) {
      if (isCurrentSession(generation, socket) && finishingGenerationRef.current !== generation) {
        const detail = caught instanceof Error ? caught.message : '未知错误'
        fail(`无法停止麦克风：${detail}`, 'capture_error', generation, socket, player)
      }
      return
    }
    if (recorderRef.current === recorder) recorderRef.current = null
    if (
      !isCurrentSession(generation, socket)
      || playerRef.current !== player
      || statusRef.current !== 'processing'
      || finishingGenerationRef.current === generation
    ) return
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'stop' }))
    }
  }

  const handleEvent = (
    event: ServerEvent,
    generation: number,
    socket: WebSocket,
    player: PCMStreamPlayer,
  ) => {
    if (
      !isCurrentSession(generation, socket)
      || playerRef.current !== player
      || statusRef.current === 'error'
      || statusRef.current === 'finished'
      || finishingGenerationRef.current === generation
    ) return
    const eventReceivedAt = performance.now()
    const receivedAtMs = audioTimelineStartedAtRef.current > 0
      ? Math.max(0, eventReceivedAt - audioTimelineStartedAtRef.current)
      : undefined
    const sessionElapsedMs = startedAtRef.current > 0
      ? Math.max(0, eventReceivedAt - startedAtRef.current)
      : undefined
    const producer = event.type === 'state' || event.type === 'error' || event.type === 'session_metrics'
      ? 'backend'
      : 'provider'
    recordDiagnosticEvent(producer, event.type, event.segmentId, event, sessionElapsedMs)
    const processingActions = {
      noteProgress: noteProcessingProgress,
      markDeliverable: markProcessingDeliverable,
      resetPreview: resetProcessingPreviewEvidence,
    }
    applyWebSocketProcessingEventEvidence(event, generation, processingActions)
    const nextVadTranscriptState = reduceVadTranscriptPairEvent(vadTranscriptStateRef.current, event)
    if (nextVadTranscriptState !== vadTranscriptStateRef.current) {
      vadTranscriptStateRef.current = nextVadTranscriptState
      setVadTranscriptPairs(nextVadTranscriptState.pairs)
    }
    const sourceVadStartMs = sourceVadStartMsForEvent(nextVadTranscriptState.pairs, event)
    const recordSentenceDiagnostic = (
      segmentId: string | undefined,
      patch: Parameters<typeof upsertSentenceDiagnostic>[2],
    ) => {
      const next = upsertSentenceDiagnostic(sentenceDiagnosticsRef.current, segmentId, patch)
      if (next === sentenceDiagnosticsRef.current) return
      sentenceDiagnosticsRef.current = next
      setSentenceDiagnostics(next)
    }
    const nextEngineLatency = { ...engineLatencyRef.current }
    let engineLatencyChanged = false
    if (
      typeof event.engineFirstModelSubmitUnixUs === 'number'
      && Number.isFinite(event.engineFirstModelSubmitUnixUs)
      && event.engineFirstModelSubmitUnixUs > 0
    ) {
      firstModelSubmitUnixUsRef.current = event.engineFirstModelSubmitUnixUs
    }
    if (
      typeof event.engineFirstTTSReadyUnixUs === 'number'
      && Number.isFinite(event.engineFirstTTSReadyUnixUs)
      && event.engineFirstTTSReadyUnixUs > 0
    ) {
      firstTTSReadyUnixUsRef.current = event.engineFirstTTSReadyUnixUs
    }
    for (const [field, value] of [
      ['firstModelTokenMs', event.engineFirstModelTokenMs],
      ['firstTextMs', event.engineFirstTextMs],
      ['firstTTSReadyMs', event.engineFirstTTSReadyMs],
      ['audioToModelFeedMs', event.engineAudioToModelFeedMs],
      ['modelFeedToFirstOutputMs', event.engineModelFeedToFirstOutputMs],
      ['modelFeedToStableTextMs', event.engineModelFeedToStableTextMs],
      ['modelFeedToTTSReadyMs', event.engineModelFeedToTTSReadyMs],
    ] as const) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && nextEngineLatency[field] !== value) {
        nextEngineLatency[field] = value
        engineLatencyChanged = true
      }
    }
    if (engineLatencyChanged) {
      engineLatencyRef.current = nextEngineLatency
      setEngineLatency(nextEngineLatency)
    }
    updateCrossDomainLatency()
    if (typeof event.ttsError === 'string' && event.ttsError.trim()) {
      ttsWarningRef.current = event.ttsError.trim()
      setTTSWarning(ttsWarningRef.current)
    }
    if (typeof event.providerLagMs === 'number' && Number.isFinite(event.providerLagMs) && event.providerLagMs >= 0) {
      const samples = upsertNativeMetricSample(providerLagSamplesRef.current, event.segmentId, event.providerLagMs)
      providerLagSamplesRef.current = samples
      if (!usesExperimentalWorkspaceUI(sessionMetaRef.current.provider)) setProviderLagSamples(samples)
      recordSentenceDiagnostic(event.segmentId, { providerLagMs: event.providerLagMs })
    }
    if (typeof event.synthesisDurationMs === 'number' && Number.isFinite(event.synthesisDurationMs) && event.synthesisDurationMs >= 0) {
      const samples = upsertNativeMetricSample(synthesisDurationSamplesRef.current, event.segmentId, event.synthesisDurationMs)
      synthesisDurationSamplesRef.current = samples
      if (!usesExperimentalWorkspaceUI(sessionMetaRef.current.provider)) setSynthesisDurationSamples(samples)
      recordSentenceDiagnostic(event.segmentId, { synthesisDurationMs: event.synthesisDurationMs })
    }
    if ((event.type === 'source_delta' || event.type === 'source_update' || event.type === 'source_done') && event.text) {
      markOutputActivity()
      markTraceOnce('firstSource')
      if (isFixedCloneProvider(sessionMetaRef.current.provider)) {
        const snapshot = event.type === 'source_delta'
          ? cumulativeSourceRef.current.snapshot + event.text
          : event.text
        const nextSource = reconcileCumulativeTranscript(cumulativeSourceRef.current, {
          text: snapshot,
          done: event.type === 'source_done',
          segmentId: event.segmentId,
          segmentText: event.type === 'source_done' ? event.segmentText : undefined,
          startMs: event.startMs,
          endMs: event.endMs,
          receivedAtMs,
          inputAudioStartMs: sourceVadStartMs,
        }, `generation-${generation}:source`)
        cumulativeSourceRef.current = nextSource
        sourceTextRef.current = nextSource.snapshot
        setSourceText(nextSource.snapshot)
        const nextSegments = cumulativeTranscriptSegments(nextSource)
        sourceSegmentsRef.current = nextSegments
        setSourceSegments(nextSegments)
      } else {
        sourceTextRef.current = event.type === 'source_delta' ? sourceTextRef.current + event.text : event.text
        setSourceText(sourceTextRef.current)
        const nextSegments = upsertTimedSegment(
          sourceSegmentsRef.current,
          event,
          receivedAtMs,
          sessionMetaRef.current.provider,
          sourceVadStartMs,
        )
        if (nextSegments !== sourceSegmentsRef.current) {
          sourceSegmentsRef.current = nextSegments
          setSourceSegments(nextSegments)
        }
      }
    }
    if (event.type === 'model_output' && event.text) {
      markOutputActivity()
      modelOutputTranslationRef.current = event.text
      setModelOutputTranslation(event.text)
      if (event.modelOutputAuthoritative) {
        translationRef.current = event.text
        setTranslation(event.text)
        const segments = applyOutputAudioStarts(reconcileStreamingTranslationSegments(
          translationSegmentsRef.current, event.text, receivedAtMs,
          `generation-${generation}:translation-sentence`,
        ), outputAudioStartBySegmentRef.current)
        translationSegmentsRef.current = segments
        setTranslationSegments(segments)
      }
      if (event.modelOutputStable && !firstTextSeenRef.current && startedAtRef.current > 0) {
        firstTextSeenRef.current = true
        const latency = Math.max(0, eventReceivedAt - startedAtRef.current)
        firstTextLatencyRef.current = latency
        setFirstTextLatency(latency)
        recordBrowserLatency('captureToFirstTextMs', latency)
        markTraceOnce('firstTranslation')
      }
    }
    if ((event.type === 'translation_delta' || event.type === 'translation_update' || event.type === 'translation_done') && event.text) {
      recordSentenceDiagnostic(event.segmentId, {
        textReceivedAtMs: sessionElapsedMs,
        textStableAtMs: event.type === 'translation_done' ? sessionElapsedMs : undefined,
        providerAudioStartMs: event.startMs,
        providerAudioEndMs: event.endMs,
        engineFirstModelTokenMs: event.engineFirstModelTokenMs,
        engineModelFeedToStableTextMs: event.engineModelFeedToStableTextMs,
        engineModelFeedToTTSReadyMs: event.engineModelFeedToTTSReadyMs,
      })
      markOutputActivity()
      if (
        !firstTextSeenRef.current
        && startedAtRef.current > 0
        && (!isVUILabsOmniProvider(sessionMetaRef.current.provider) || event.type === 'translation_done')
      ) {
        firstTextSeenRef.current = true
        const latency = Math.max(0, eventReceivedAt - startedAtRef.current)
        firstTextLatencyRef.current = latency
        setFirstTextLatency(latency)
        recordBrowserLatency('captureToFirstTextMs', latency)
        markTraceOnce('firstTranslation')
      }
      if (
        event.type === 'translation_done'
        && startedAtRef.current > 0
        && browserLatencyRef.current.captureToFirstStableSentenceMs === null
      ) {
        recordBrowserLatency(
          'captureToFirstStableSentenceMs',
          Math.max(0, eventReceivedAt - startedAtRef.current),
        )
        markTraceAt('firstStableTranslation', eventReceivedAt)
      }
      translationRef.current = nextTranslationSnapshot(
        translationRef.current,
        event,
        isVUILabsOmniProvider(sessionMetaRef.current.provider),
      )
      setTranslation(translationRef.current)
      const displayUnits = upsertTranslationDisplayUnit(translationDisplayUnitsRef.current, event)
      if (displayUnits !== translationDisplayUnitsRef.current) {
        translationDisplayUnitsRef.current = displayUnits
        setTranslationDisplayUnits(displayUnits)
      }
      const nextSegments = isVUILabsOmniProvider(sessionMetaRef.current.provider)
        ? reconcileStreamingTranslationSegments(
          translationSegmentsRef.current,
          translationRef.current,
          receivedAtMs,
          `generation-${generation}:translation-sentence`,
          event.segmentId,
          event.segmentText,
          event.startMs,
          event.endMs,
        )
        : upsertTimedSegment(
          translationSegmentsRef.current,
          event,
          receivedAtMs,
          sessionMetaRef.current.provider,
        )
      const positionedSegments = applyOutputAudioStarts(nextSegments, outputAudioStartBySegmentRef.current)
      if (positionedSegments !== translationSegmentsRef.current) {
        translationSegmentsRef.current = positionedSegments
        setTranslationSegments(positionedSegments)
      }
    }
    if (event.type === 'audio' && event.audio) {
      const chunk = decodeBase64(event.audio)
      const chunkSampleRate = outputSampleRateRef.current
      const playbackSegmentId = event.segmentId?.trim() || null
      if (playbackSegmentId && !outputAudioStartBySegmentRef.current.has(playbackSegmentId)) {
        const outputStartMs = outputAudioBytesRef.current / 2 / chunkSampleRate * 1000
        outputAudioStartBySegmentRef.current.set(playbackSegmentId, outputStartMs)
        const positionedSegments = applyOutputAudioStarts(translationSegmentsRef.current, outputAudioStartBySegmentRef.current)
        if (positionedSegments !== translationSegmentsRef.current) {
          translationSegmentsRef.current = positionedSegments
          setTranslationSegments(positionedSegments)
        }
      }
      const audioDurationMs = playbackSegmentId
        ? accumulatePCM16SegmentDurationMs(
          derivedAudioBytesBySegmentRef.current,
          playbackSegmentId,
          chunk.byteLength,
          chunkSampleRate,
        ) ?? undefined
        : undefined
      recordSentenceDiagnostic(event.segmentId, {
        audioReceivedAtMs: sessionElapsedMs,
        providerAudioStartMs: event.startMs,
        providerAudioEndMs: event.endMs,
        audioDurationMs,
      })
      markOutputActivity()
      if (typeof receivedAtMs === 'number') {
        const segments = upsertTimedAudioSegment(audioSegmentsRef.current, event, receivedAtMs)
        if (segments !== audioSegmentsRef.current) {
          audioSegmentsRef.current = segments
          if (!usesExperimentalWorkspaceUI(sessionMetaRef.current.provider)) setAudioSegments(segments)
        }
      }
      const chunkHasSignal = pcm16HasSignal(chunk)
      if (chunkHasSignal) {
        applyWebSocketProcessingEventEvidence(event, generation, processingActions, true)
      }
      if (chunkHasSignal && !firstAudioByteSeenRef.current && startedAtRef.current > 0) {
        firstAudioByteSeenRef.current = true
        firstAudioReceivedAtRef.current = eventReceivedAt
        const latency = Math.max(0, eventReceivedAt - startedAtRef.current)
        firstAudioByteLatencyRef.current = latency
        recordBrowserLatency('captureToFirstAudioMs', latency)
        markTraceOnce('firstAudioByte')
      }
      if (
        outputAudioSampleRateRef.current !== null
        && outputAudioSampleRateRef.current !== chunkSampleRate
      ) {
        fail(
          `翻译音频采样率在会话中从 ${outputAudioSampleRateRef.current} Hz 切换为 ${chunkSampleRate} Hz，已停止以避免错误播放或归档。`,
          'audio_output',
          generation,
          socket,
          player,
        )
        return
      }
      observeSharePCMBytes(sessionMetaRef.current.id, 'output', chunk, chunkSampleRate)
      outputAudioSampleRateRef.current = chunkSampleRate
      const archived = appendPCMArchiveChunk(outputAudioRef.current, outputAudioBytesRef.current, chunk)
      if (!archived.truncated) queueHistoryPCMChunk(sessionMetaRef.current.id, 'output', chunk, chunkSampleRate)
      outputAudioBytesRef.current = archived.receivedBytes
      if (archived.truncated && !audioArchiveSkippedRef.current) {
        audioArchiveSkippedRef.current = true
        setAudioArchiveSkipped(true)
      }
      const playbackGeneration = playbackGenerationRef.current
      const playbackToken = ++playbackTokenRef.current
      const trackSentencePlayback = Boolean(
        playbackSegmentId && isOmniS2STProvider(sessionMetaRef.current.provider),
      )
      if (playbackSegmentId && trackSentencePlayback) {
        queuePlaybackChunk(playbackSegmentsRef.current, playbackSegmentId)
      }
      let scheduledAt: number | null
      try {
        scheduledAt = player.push(chunk, chunkSampleRate, {
          onStart: (playbackStartedAt) => {
            if (playbackGeneration !== playbackGenerationRef.current) return
            if (!chunkHasSignal) return
            activePlaybackRef.current = { token: playbackToken, segmentId: playbackSegmentId }
            setPlayingTranslationSegmentId(playbackSegmentId)
            recordSentenceDiagnostic(playbackSegmentId || undefined, {
              playbackStartedAtMs: startedAtRef.current > 0
                ? Math.max(0, playbackStartedAt - startedAtRef.current)
                : undefined,
              playbackTimingSource: 'browser_observed',
            })
            if (
              !firstAudioPlaybackSeenRef.current
              && startedAtRef.current > 0
            ) {
              firstAudioPlaybackSeenRef.current = true
              firstAudioPlaybackAtRef.current = playbackStartedAt
              const captureToPlayback = Math.max(0, playbackStartedAt - startedAtRef.current)
              firstAudioPlaybackLatencyRef.current = captureToPlayback
              recordBrowserLatency('captureToFirstPlaybackMs', captureToPlayback)
              if (firstAudioReceivedAtRef.current > 0) {
                recordBrowserLatency(
                  'firstAudioReceiveToPlaybackMs',
                  Math.max(0, playbackStartedAt - firstAudioReceivedAtRef.current),
                )
              }
              markTraceAt('firstAudioPlayback', playbackStartedAt)
              updateCrossDomainLatency()
            }
          },
          onEnded: () => {
            if (playbackGeneration !== playbackGenerationRef.current) return
            const segmentFinished = playbackSegmentId && trackSentencePlayback
              ? finishPlaybackChunk(playbackSegmentsRef.current, playbackSegmentId)
              : false
            if (segmentFinished && activePlaybackRef.current?.segmentId === playbackSegmentId) {
              activePlaybackRef.current = null
              setPlayingTranslationSegmentId(null)
            }
            if (activePlaybackRef.current?.token !== playbackToken) return
            if (playbackSegmentId && trackSentencePlayback && !segmentFinished) {
              const segment = playbackSegmentsRef.current.get(playbackSegmentId)
              if (segment && (!segment.inputDone || segment.pendingChunks > 0)) {
                return
              }
            }
            activePlaybackRef.current = null
            setPlayingTranslationSegmentId(null)
          },
        })
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : '未知错误'
        fail(`浏览器无法播放翻译音频：${detail}`, 'audio_output', generation, socket, player)
        return
      }
      if (
        typeof scheduledAt === 'number'
        && Number.isFinite(scheduledAt)
        && chunkHasSignal
        && browserLatencyRef.current.captureToFirstPlaybackScheduledMs === null
        && startedAtRef.current > 0
      ) {
        const captureToPlayback = Math.max(0, scheduledAt - startedAtRef.current)
        recordBrowserLatency('captureToFirstPlaybackScheduledMs', captureToPlayback)
        if (firstAudioReceivedAtRef.current > 0) {
          recordBrowserLatency(
            'firstAudioReceiveToPlaybackScheduledMs',
            Math.max(0, scheduledAt - firstAudioReceivedAtRef.current),
          )
        }
      }
      if (chunkHasSignal) setStreamingAudio(true)
    }
    if (event.type === 'audio_done') {
      const playbackSegmentId = event.segmentId?.trim() || null
      if (playbackSegmentId) {
        if (finishPlaybackInput(playbackSegmentsRef.current, playbackSegmentId)) {
          if (activePlaybackRef.current?.segmentId === playbackSegmentId) {
            activePlaybackRef.current = null
            setPlayingTranslationSegmentId(null)
          }
        }
      }
    }
    if (event.type === 'audio_config' && event.sampleRate) {
      if (
        outputAudioSampleRateRef.current !== null
        && outputAudioSampleRateRef.current !== event.sampleRate
      ) {
        fail(
          `翻译音频采样率在会话中从 ${outputAudioSampleRateRef.current} Hz 切换为 ${event.sampleRate} Hz，已停止以避免错误播放或归档。`,
          'audio_output',
          generation,
          socket,
          player,
        )
        return
      }
      outputSampleRateRef.current = event.sampleRate
    }
    if (event.type === 'asr_error') {
      setCompletionWarning(`原文识别不可用：${event.error || 'ASR 服务返回错误。'}`)
      return
    }
    if (event.type === 'error') fail(event.error || '模型服务返回错误。', 'service_error', generation, socket, player)
    if (event.type === 'state' && event.state === 'connected') markTraceOnce('providerConnected')
    if (event.type === 'state' && event.state === 'ready') markTraceOnce('providerReady')
    if (event.type === 'state' && event.state === 'finished') {
      markTraceAt('providerFinished', eventReceivedAt)
      void finishAudio(generation, socket, player)
    }
  }

  useEffect(() => {
    if (status !== 'finished' && status !== 'error') return
    setAudioPlaybackBlocked(false)
    resumeAudioPlaybackRef.current = null
  }, [status])

  const resumeAudioPlayback = async () => {
    const resume = resumeAudioPlaybackRef.current
    if (!resume || (statusRef.current !== 'recording' && statusRef.current !== 'processing')) return
    try {
      await resume()
      setAudioPlaybackBlocked(false)
    } catch (caught) {
      setAudioPlaybackBlocked(true)
      setError(caught instanceof Error
        ? `浏览器无法播放火山 RTC 翻译音频：${caught.message}`
        : '浏览器无法播放火山 RTC 翻译音频。')
    }
  }

  return {
    status, error, completionWarning, setError, sourceText, translation, modelOutputTranslation, sourceSegments, translationSegments,
    translationDisplayUnits, vadTranscriptPairs, playingTranslationSegmentId,
    audioSegments, providerLagSamples, synthesisDurationSamples, sentenceDiagnostics, diagnosticEvents, observability, trace, stability,
    engineLatency, browserLatency, ttsWarning, audioProcessingDiagnostics,
    firstTextLatency, elapsed, inputAudioURL, audioURL, streamingAudio, playbackIncomplete,
    audioArchiveSkipped, audioPlaybackBlocked, outputAudioRef, start, stop,
    resumeAudioPlayback,
  }
}

export function useRealtimeSession(options: RealtimeSessionOptions): RealtimeSession {
  const websocket = useWebSocketRealtimeSession(options)
  const webRTC = useLiveKitRealtimeSession(options)
  return realtimeServiceForSession(options) === 'livekit' ? webRTC : websocket
}
