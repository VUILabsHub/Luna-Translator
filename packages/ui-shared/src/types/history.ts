// Change record (2026-08-05): represent cumulative model output independently
// from stable sentence/TTS events and retain its stability classification.
export type ServerEvent = {
  type: string
  reason?: string
  code?: string
  targetLanguage?: string
  text?: string
  epochText?: string
  modelOutputStable?: boolean
  modelOutputAuthoritative?: boolean
  segmentId?: string
  segmentText?: string
  utteranceId?: string
  speechEpoch?: number
  replaceSegmentIds?: string[]
  startMs?: number
  endMs?: number
  providerLagMs?: number
  synthesisDurationMs?: number
  audioDurationMs?: number
  engineFirstModelTokenMs?: number
  engineFirstTextMs?: number
  engineFirstTTSReadyMs?: number
  engineAudioToModelFeedMs?: number
  engineModelFeedToFirstOutputMs?: number
  engineModelFeedToStableTextMs?: number
  engineModelFeedToTTSReadyMs?: number
  engineFirstModelSubmitUnixUs?: number
  engineFirstTTSReadyUnixUs?: number
  ttsError?: string
  tts_error?: string
  message?: string
  audio?: string
  sampleRate?: number
  state?: string
  /** state:ready 回报的实际音色模式（'clone' | 'default'）。 */
  voiceMode?: string
  /** session_started：本场硬时限（ms），等于后端 maxSessionDuration。 */
  timeLimitMs?: number
  /** session_started：服务端的会话起点（Unix ms）。 */
  startedAtMs?: number
  error?: string
}

export type EngineLatencyMetrics = {
  firstModelTokenMs: number | null
  firstTextMs: number | null
  firstTTSReadyMs: number | null
  audioToModelFeedMs: number | null
  modelFeedToFirstOutputMs: number | null
  modelFeedToStableTextMs: number | null
  modelFeedToTTSReadyMs: number | null
  recordingToModelSubmitMs: number | null
  ttsReadyToFirstPlaybackMs: number | null
  clockSyncUncertaintyMs: number | null
}

export type BrowserLatencyMetrics = {
  captureToWSSendMs: number | null
  inputSendIntervalP95Ms: number | null
  maxInputSendGapMs: number | null
  inputSendIntervalSampleCount: number
  captureToFirstTextMs: number | null
  captureToFirstStableSentenceMs: number | null
  captureToFirstAudioMs: number | null
  firstAudioReceiveToPlaybackScheduledMs: number | null
  captureToFirstPlaybackScheduledMs: number | null
  firstAudioReceiveToPlaybackMs: number | null
  captureToFirstPlaybackMs: number | null
}

export type TraceKey = 'requestStarted' | 'socketOpen' | 'providerConnected' | 'providerReady' | 'captureStarted' | 'inputStopped' | 'firstSource' | 'firstTranslation' | 'firstStableTranslation' | 'firstAudioByte' | 'firstAudioPlayback' | 'firstAudio' | 'disconnected' | 'providerFinished' | 'agentPlayoutDrained' | 'playbackDrained' | 'finished' | 'failed'
export type SessionTrace = Partial<Record<TraceKey, number>>
export type StabilityMetrics = {
  disconnectCount: number
  reconnectAttempts: number
  maxOutputGapMs: number | null
  noOutputTimeouts: number
}

export type TimedTranscriptSegment = {
  id: string
  /** Provider/audio segment ids represented by this visible sentence row. */
  memberIds?: string[]
  text: string
  startMs: number
  endMs: number
  receivedAtMs?: number
  timingSource?: 'provider' | 'client_estimated'
  /** VAD speech start offset in the archived input WAV. */
  inputAudioStartMs?: number
  /** Offset of this segment's first PCM frame in the archived output WAV. */
  outputAudioStartMs?: number
  /** Exclusive end of the segment's PCM in the archived output WAV. */
  outputAudioEndMs?: number
}

export type { TranslationDisplayUnit } from '@simultrans/core/types'

export type TimelineLatencyStats = {
  averageMs: number | null
  p95Ms: number | null
  sampleCount: number
}

export type TimedAudioSegment = {
  id: string
  startMs: number
  endMs: number
  receivedAtMs: number
}

export type NativeMetricSample = {
  id: string
  valueMs: number
}

export type SentenceDiagnostic = {
  segmentId: string
  textReceivedAtMs?: number
  textStableAtMs?: number
  providerAudioStartMs?: number
  providerAudioEndMs?: number
  providerLagMs?: number
  synthesisDurationMs?: number
  engineFirstModelTokenMs?: number
  engineModelFeedToStableTextMs?: number
  engineModelFeedToTTSReadyMs?: number
  audioReceivedAtMs?: number
  agentPlayoutStartedAtMs?: number
  agentQueueWaitMs?: number
  agentMediaStartSample?: number
  agentMediaEndSample?: number
  agentMediaSampleRateHz?: number
  agentFirstFrameSequence?: number
  playbackStartedAtMs?: number
  audioDurationMs?: number
  playbackSequence?: number
  playbackTimingSource?: 'browser_observed' | 'browser_scheduled' | 'agent_reported'
}

export type DiagnosticEvent = {
  sequence: number
  producer: 'backend' | 'provider' | 'agent' | 'browser'
  eventType: string
  receivedAtMs?: number
  segmentId?: string
  payload?: Record<string, string | number | boolean | null>
}

export type ObservabilityContext = {
  traceId?: string
  requestId?: string
  sessionId?: string
}

export type MultilingualHistoryOutput = {
  targetLanguage: string
  translationText: string
  translationSegments?: TimedTranscriptSegment[]
  firstTextLatency: number | null
  browserCaptureToFirstStableSentenceMs?: number | null
  firstAudioByteLatency: number | null
  firstAudioPlaybackLatency: number | null
  engineModelFeedToFirstOutputMs?: number | null
  engineModelFeedToStableTextMs?: number | null
  engineModelFeedToTTSReadyMs?: number | null
  recordingToModelSubmitMs?: number | null
  ttsReadyToFirstPlaybackMs?: number | null
  clockSyncUncertaintyMs?: number | null
  outputAudioAvailable?: boolean
  ttsError?: string
  outcome: 'completed' | 'error'
  errorCategory?: string
  errorReason?: string
}

export type HistoryEntry = {
  schemaVersion?: number
  recordType?: 'realtime' | 'batch'
  sessionMode?: 'realtime' | 'multilingual'
  multilingualSessionId?: string
  multilingualTargetLanguages?: string[]
  multilingualOutputs?: MultilingualHistoryOutput[]
  id: string
  createdAt: string
  uploaderEmail?: string
  provider: string
  transport?: 'websocket' | 'webrtc'
  model: string
  sourceLanguage: string
  targetLanguage: string
  sourceText: string
  translationText: string
  sourceSegments?: TimedTranscriptSegment[]
  translationSegments?: TimedTranscriptSegment[]
  translationEvaluations?: TranslationEvaluation[]
  sentenceDiagnostics?: SentenceDiagnostic[]
  diagnosticEvents?: DiagnosticEvent[]
  diagnosticEventsTruncated?: boolean
  diagnosticEventCount?: number
  diagnosticEventsArchived?: boolean
  observability?: ObservabilityContext
  latencyAnalysisTruncated?: boolean
  averageTimelineLatencyMs?: number | null
  tailTimelineLatencyP95Ms?: number | null
  timelineSampleCount?: number
  averageAudioTimelineLatencyMs?: number | null
  tailAudioTimelineLatencyP95Ms?: number | null
  audioTimelineSampleCount?: number
  providerLagAverageMs?: number | null
  providerLagP95Ms?: number | null
  providerLagSampleCount?: number
  synthesisDurationAverageMs?: number | null
  synthesisDurationP95Ms?: number | null
  synthesisDurationSampleCount?: number
  audioReceiveToPlaybackAverageMs?: number | null
  audioReceiveToPlaybackP95Ms?: number | null
  audioReceiveToPlaybackSampleCount?: number
  ttsRTFAverage?: number | null
  ttsRTFP95?: number | null
  ttsRTFSampleCount?: number
  inputSendIntervalP95Ms?: number | null
  maxInputSendGapMs?: number | null
  inputSendIntervalSampleCount?: number
  engineFirstModelTokenMs?: number | null
  engineFirstTextMs?: number | null
  engineFirstTTSReadyMs?: number | null
  engineAudioToModelFeedMs?: number | null
  engineModelFeedToFirstOutputMs?: number | null
  engineModelFeedToStableTextMs?: number | null
  engineModelFeedToTTSReadyMs?: number | null
  recordingToModelSubmitMs?: number | null
  ttsReadyToFirstPlaybackMs?: number | null
  clockSyncUncertaintyMs?: number | null
  browserCaptureToWSSendMs?: number | null
  browserCaptureToFirstTextMs?: number | null
  browserCaptureToFirstStableSentenceMs?: number | null
  browserCaptureToFirstAudioMs?: number | null
  browserFirstAudioReceiveToPlaybackScheduledMs?: number | null
  browserCaptureToFirstPlaybackScheduledMs?: number | null
  browserFirstAudioReceiveToPlaybackMs?: number | null
  browserCaptureToFirstPlaybackMs?: number | null
  ttsError?: string
  inputAudioAvailable?: boolean
  outputAudioAvailable?: boolean
  firstTextLatency: number | null
  firstAudioByteLatency: number | null
  firstAudioPlaybackLatency: number | null
  firstAudioLatency?: number | null
  outcome: 'completed' | 'error'
  errorCategory?: string
  errorReason?: string
  disconnectCount: number
  reconnectAttempts: number
  maxOutputGapMs: number | null
  noOutputTimeouts: number
  sessionDurationMs: number | null
  trace: SessionTrace
  sampleName?: string
  sampleMediaId?: string
  sampleMediaCreatedAt?: string
  inputDurationMs?: number | null
  speechOnsetMs?: number | null
  runId?: string
  repeatIndex?: number
  voiceMode?: 'clone' | 'preset'
  evaluationMode?: 'uploaded' | 'realtime'
  synced?: boolean
}

export type TranslationEvaluation = {
  targetLanguage: string
  chineseTranslation: string
  overallScore: number
  rating: 'excellent' | 'good' | 'fair' | 'poor'
  summary: string
  dimensions: {
    accuracy: TranslationEvaluationDimension
    completeness: TranslationEvaluationDimension
    fluency: TranslationEvaluationDimension
    terminology: TranslationEvaluationDimension
  }
  issues?: TranslationEvaluationIssue[]
  asrUncertainty?: string
  model: string
  inputFingerprint: string
  evaluatedAt: string
}

export type TranslationEvaluationDimension = {
  score: number
  comment: string
}

export type TranslationEvaluationIssue = {
  category: string
  severity: 'high' | 'medium' | 'low'
  sourceEvidence?: string
  translationEvidence?: string
  explanation: string
  suggestion?: string
}

export type HistoryAudioKind = 'input' | 'output' | `output-${string}`
export type HistorySyncResult = {
  entry: HistoryEntry
  failedKinds: HistoryAudioKind[]
}
