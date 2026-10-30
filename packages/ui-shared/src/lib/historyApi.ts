import { deleteHistoryAudio, loadHistoryAudio, type HistoryAudioArchive } from '../historyAudio'
import { isFixedCloneProvider } from '../languageCapabilities'
import { historyTimelineStats } from './stats'
import { compareTimedSegments } from './transcript'
import { historyFetch } from './historyFetch'
import { clientTZOffset } from './historyDates'
import type {
  HistoryAudioKind,
  DiagnosticEvent,
  HistoryEntry,
  HistorySyncResult,
  TimedTranscriptSegment,
  TranslationEvaluation,
} from '../types/history'
import type { RTCStatsArchive } from '../webrtcStats'

const HISTORY_STORAGE_KEY = 'simultrans.history.v1'
// localStorage quotas are shared with the rest of the origin and are commonly
// measured in UTF-16 code units. Keep enough headroom for login/preferences and
// compact old diagnostics before a new transcript can be rejected.
const HISTORY_LOCAL_MAX_CODE_UNITS = 1_800_000
const HISTORY_LOCAL_MAX_ENTRIES = 100
const HISTORY_MAX_ENTRY_BYTES = 5 * 1024 * 1024
const HISTORY_MAX_SENTENCE_DIAGNOSTICS = 1_000
const HISTORY_MAX_DIAGNOSTIC_EVENTS = 1_000

export function loadHistory(): HistoryEntry[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(HISTORY_STORAGE_KEY) || '[]')
    return normalizeHistory(value)
  } catch {
    return []
  }
}

export function normalizeHistory(value: unknown, limit?: number): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  const entries = value
    .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object' && typeof entry.createdAt === 'string' && !Number.isNaN(Date.parse(entry.createdAt)))
    .map((entry) => ({
      ...entry,
      uploaderEmail: stringField(entry.uploaderEmail).trim() || undefined,
      recordType: entry.recordType === 'batch' ? 'batch' : 'realtime',
      sessionMode: entry.sessionMode === 'multilingual' ? 'multilingual' : 'realtime',
      multilingualSessionId: entry.sessionMode === 'multilingual'
        ? stringField(entry.multilingualSessionId).trim() || undefined
        : undefined,
      multilingualTargetLanguages: entry.sessionMode === 'multilingual'
        ? normalizeLanguageList(entry.multilingualTargetLanguages)
        : undefined,
      multilingualOutputs: entry.sessionMode === 'multilingual'
        ? normalizeMultilingualOutputs(entry.multilingualOutputs)
        : undefined,
      evaluationMode: entry.evaluationMode === 'uploaded' ? 'uploaded' : 'realtime',
      sourceText: typeof entry.sourceText === 'string' ? entry.sourceText : '',
      translationText: typeof entry.translationText === 'string' ? entry.translationText : '',
      sourceSegments: normalizeTimedSegments(entry.sourceSegments),
      translationSegments: normalizeTimedSegments(entry.translationSegments),
      translationEvaluations: normalizeTranslationEvaluations(entry.translationEvaluations),
      sentenceDiagnostics: normalizeSentenceDiagnostics(entry.sentenceDiagnostics),
      diagnosticEvents: normalizeDiagnosticEvents(entry.diagnosticEvents),
      diagnosticEventsTruncated: entry.diagnosticEventsTruncated === true || diagnosticEventsWereTruncated(entry.diagnosticEvents),
      diagnosticEventCount: numericValue(entry.diagnosticEventCount),
      diagnosticEventsArchived: entry.diagnosticEventsArchived === true,
      observability: normalizeObservability(entry.observability),
      latencyAnalysisTruncated: entry.latencyAnalysisTruncated === true || sentenceDiagnosticsWereTruncated(entry.sentenceDiagnostics),
      averageTimelineLatencyMs: latencyValue(entry.averageTimelineLatencyMs),
      tailTimelineLatencyP95Ms: latencyValue(entry.tailTimelineLatencyP95Ms),
      timelineSampleCount: numericValue(entry.timelineSampleCount),
      averageAudioTimelineLatencyMs: latencyValue(entry.averageAudioTimelineLatencyMs),
      tailAudioTimelineLatencyP95Ms: latencyValue(entry.tailAudioTimelineLatencyP95Ms),
      audioTimelineSampleCount: numericValue(entry.audioTimelineSampleCount),
      providerLagAverageMs: latencyValue(entry.providerLagAverageMs),
      providerLagP95Ms: latencyValue(entry.providerLagP95Ms),
      providerLagSampleCount: numericValue(entry.providerLagSampleCount),
      synthesisDurationAverageMs: latencyValue(entry.synthesisDurationAverageMs),
      synthesisDurationP95Ms: latencyValue(entry.synthesisDurationP95Ms),
      synthesisDurationSampleCount: numericValue(entry.synthesisDurationSampleCount),
      audioReceiveToPlaybackAverageMs: latencyValue(entry.audioReceiveToPlaybackAverageMs),
      audioReceiveToPlaybackP95Ms: latencyValue(entry.audioReceiveToPlaybackP95Ms),
      audioReceiveToPlaybackSampleCount: numericValue(entry.audioReceiveToPlaybackSampleCount),
      ttsRTFAverage: latencyValue(entry.ttsRTFAverage),
      ttsRTFP95: latencyValue(entry.ttsRTFP95),
      ttsRTFSampleCount: numericValue(entry.ttsRTFSampleCount),
      inputSendIntervalP95Ms: latencyValue(entry.inputSendIntervalP95Ms),
      maxInputSendGapMs: latencyValue(entry.maxInputSendGapMs),
      inputSendIntervalSampleCount: numericValue(entry.inputSendIntervalSampleCount),
      engineFirstModelTokenMs: latencyValue(entry.engineFirstModelTokenMs),
      engineFirstTextMs: latencyValue(entry.engineFirstTextMs),
      engineFirstTTSReadyMs: latencyValue(entry.engineFirstTTSReadyMs),
      engineAudioToModelFeedMs: latencyValue(entry.engineAudioToModelFeedMs),
      engineModelFeedToFirstOutputMs: latencyValue(entry.engineModelFeedToFirstOutputMs),
      engineModelFeedToStableTextMs: latencyValue(entry.engineModelFeedToStableTextMs),
      engineModelFeedToTTSReadyMs: latencyValue(entry.engineModelFeedToTTSReadyMs),
      recordingToModelSubmitMs: latencyValue(entry.recordingToModelSubmitMs),
      ttsReadyToFirstPlaybackMs: latencyValue(entry.ttsReadyToFirstPlaybackMs),
      clockSyncUncertaintyMs: latencyValue(entry.clockSyncUncertaintyMs),
      browserCaptureToWSSendMs: latencyValue(entry.browserCaptureToWSSendMs),
      browserCaptureToFirstTextMs: latencyValue(entry.browserCaptureToFirstTextMs),
      browserCaptureToFirstStableSentenceMs: latencyValue(entry.browserCaptureToFirstStableSentenceMs),
      browserCaptureToFirstAudioMs: latencyValue(entry.browserCaptureToFirstAudioMs),
      browserFirstAudioReceiveToPlaybackScheduledMs: latencyValue(entry.browserFirstAudioReceiveToPlaybackScheduledMs),
      browserCaptureToFirstPlaybackScheduledMs: latencyValue(entry.browserCaptureToFirstPlaybackScheduledMs),
      browserFirstAudioReceiveToPlaybackMs: latencyValue(entry.browserFirstAudioReceiveToPlaybackMs),
      browserCaptureToFirstPlaybackMs: latencyValue(entry.browserCaptureToFirstPlaybackMs),
      ttsError: typeof entry.ttsError === 'string' && entry.ttsError.trim() ? entry.ttsError.trim() : undefined,
      inputAudioAvailable: entry.inputAudioAvailable === true,
      outputAudioAvailable: entry.outputAudioAvailable === true,
      firstTextLatency: latencyValue(entry.firstTextLatency),
      firstAudioByteLatency: latencyValue(entry.firstAudioByteLatency ?? entry.firstAudioLatency),
      firstAudioPlaybackLatency: latencyValue(entry.firstAudioPlaybackLatency),
      disconnectCount: numericValue(entry.disconnectCount),
      reconnectAttempts: numericValue(entry.reconnectAttempts),
      maxOutputGapMs: latencyValue(entry.maxOutputGapMs),
      noOutputTimeouts: numericValue(entry.noOutputTimeouts),
      sessionDurationMs: latencyValue(entry.sessionDurationMs),
      trace: entry.trace && typeof entry.trace === 'object' ? entry.trace : {},
      synced: entry.synced === true,
    }) as HistoryEntry)
  return limit === undefined ? entries : entries.slice(0, limit)
}

function normalizeTranslationEvaluations(value: unknown): TranslationEvaluation[] | undefined {
  if (!Array.isArray(value)) return undefined
  const evaluations = value.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    const dimensions = raw.dimensions && typeof raw.dimensions === 'object'
      ? raw.dimensions as Record<string, unknown> : {}
    const dimension = (name: string) => {
      const item = dimensions[name] && typeof dimensions[name] === 'object'
        ? dimensions[name] as Record<string, unknown> : {}
      return { score: numericValue(item.score), comment: stringField(item.comment) }
    }
    const rating = ['excellent', 'good', 'fair', 'poor'].includes(stringField(raw.rating))
      ? stringField(raw.rating) as TranslationEvaluation['rating'] : 'poor'
    const targetLanguage = stringField(raw.targetLanguage).trim()
    const chineseTranslation = stringField(raw.chineseTranslation).trim()
    if (!targetLanguage || !chineseTranslation) return []
    return [{
      targetLanguage,
      chineseTranslation,
      overallScore: numericValue(raw.overallScore),
      rating,
      summary: stringField(raw.summary),
      dimensions: {
        accuracy: dimension('accuracy'), completeness: dimension('completeness'),
        fluency: dimension('fluency'), terminology: dimension('terminology'),
      },
      issues: Array.isArray(raw.issues) ? raw.issues.slice(0, 12).flatMap((issue) => {
        if (issue === null || typeof issue !== 'object') return []
        const item = issue as Record<string, unknown>
        const severity = ['high', 'medium', 'low'].includes(stringField(item.severity))
          ? stringField(item.severity) as 'high' | 'medium' | 'low' : 'low'
        return [{
          category: stringField(item.category), severity,
          sourceEvidence: stringField(item.sourceEvidence) || undefined,
          translationEvidence: stringField(item.translationEvidence) || undefined,
          explanation: stringField(item.explanation), suggestion: stringField(item.suggestion) || undefined,
        }]
      }) : [],
      asrUncertainty: stringField(raw.asrUncertainty) || undefined,
      model: stringField(raw.model), inputFingerprint: stringField(raw.inputFingerprint),
      evaluatedAt: stringField(raw.evaluatedAt),
    }]
  })
  return evaluations.length > 0 ? evaluations : undefined
}

export function normalizeBatchHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value.reduce<HistoryEntry[]>((entries, candidate) => {
    if (candidate === null || typeof candidate !== 'object') return entries
    const trial = candidate as Record<string, unknown>
    const id = stringField(trial.id)
    const createdAt = stringField(trial.createdAt)
    const provider = stringField(trial.provider)
    const model = stringField(trial.model)
    if (!id || !provider || !model || !createdAt || Number.isNaN(Date.parse(createdAt))) return entries
    const sampleMediaId = stringField(trial.sampleMediaId)
    const sampleMediaCreatedAt = stringField(trial.sampleMediaCreatedAt)
    const providerConnectLatency = latencyValue(trial.providerConnectMs)
    const sourceSegments = normalizeTimedSegments(trial.sourceSegments)
    const translationSegments = normalizeTimedSegments(trial.translationSegments)
    entries.push({
      schemaVersion: numericValue(trial.schemaVersion),
      recordType: 'batch',
      id,
      createdAt,
      provider,
      model,
      sourceLanguage: stringField(trial.sourceLanguage),
      targetLanguage: stringField(trial.targetLanguage),
      sourceText: stringField(trial.sourceText),
      translationText: stringField(trial.translationText),
      sourceSegments,
      translationSegments,
      ...historyTimelineStats(translationSegments),
      inputAudioAvailable: Boolean(sampleMediaId && sampleMediaCreatedAt),
      outputAudioAvailable: trial.outputAudioAvailable === true,
      firstTextLatency: latencyValue(trial.firstTextMs),
      firstAudioByteLatency: latencyValue(trial.firstAudioMs),
      firstAudioPlaybackLatency: null,
      outcome: trial.outcome === 'completed' ? 'completed' : 'error',
      errorCategory: trial.outcome === 'completed' ? '' : stringField(trial.outcome) || 'error',
      errorReason: stringField(trial.error),
      disconnectCount: numericValue(trial.disconnectCount),
      reconnectAttempts: numericValue(trial.reconnectAttempts),
      maxOutputGapMs: latencyValue(trial.maxOutputGapMs),
      noOutputTimeouts: numericValue(trial.noOutputTimeouts),
      sessionDurationMs: latencyValue(trial.completedMs),
      trace: providerConnectLatency === null ? {} : { providerConnected: providerConnectLatency },
      sampleName: stringField(trial.sample) || '未命名批测样本',
      sampleMediaId,
      sampleMediaCreatedAt,
      inputDurationMs: latencyValue(trial.inputDurationMs),
      speechOnsetMs: latencyValue(trial.speechOnsetMs),
      runId: stringField(trial.runId) || 'legacy',
      repeatIndex: Math.max(1, numericValue(trial.repeatIndex)),
      voiceMode: trial.voiceMode === 'clone' ? 'clone' : 'preset',
      evaluationMode: trial.evaluationMode === 'realtime' ? 'realtime' : 'uploaded',
    })
    return entries
  }, [])
}

export function mergeSharedHistory(realtime: HistoryEntry[], batch: HistoryEntry[]) {
  const entries = new Map<string, HistoryEntry>()
  for (const entry of [...realtime, ...batch]) {
    entries.set(`${historyRecordType(entry)}:${entry.id}`, entry)
  }
  return [...entries.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export function historyRecordType(entry: HistoryEntry): 'realtime' | 'batch' {
  return entry.recordType === 'batch' ? 'batch' : 'realtime'
}

function stringField(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function normalizeLanguageList(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const languages = [...new Set(value.flatMap((candidate) => {
    const language = stringField(candidate).trim()
    return language && language.length <= 32 ? [language] : []
  }))].slice(0, 4)
  return languages.length > 0 ? languages : undefined
}

function normalizeMultilingualOutputs(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const seen = new Set<string>()
  const outputs = value.slice(0, 4).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return []
    const raw = candidate as Record<string, unknown>
    const targetLanguage = stringField(raw.targetLanguage).trim()
    if (!targetLanguage || targetLanguage.length > 32 || seen.has(targetLanguage)) return []
    seen.add(targetLanguage)
    return [{
      targetLanguage,
      translationText: stringField(raw.translationText),
      translationSegments: normalizeTimedSegments(raw.translationSegments),
      firstTextLatency: latencyValue(raw.firstTextLatency),
      browserCaptureToFirstStableSentenceMs: latencyValue(raw.browserCaptureToFirstStableSentenceMs),
      firstAudioByteLatency: latencyValue(raw.firstAudioByteLatency),
      firstAudioPlaybackLatency: latencyValue(raw.firstAudioPlaybackLatency),
      engineModelFeedToFirstOutputMs: latencyValue(raw.engineModelFeedToFirstOutputMs),
      engineModelFeedToStableTextMs: latencyValue(raw.engineModelFeedToStableTextMs),
      engineModelFeedToTTSReadyMs: latencyValue(raw.engineModelFeedToTTSReadyMs),
      recordingToModelSubmitMs: latencyValue(raw.recordingToModelSubmitMs),
      ttsReadyToFirstPlaybackMs: latencyValue(raw.ttsReadyToFirstPlaybackMs),
      clockSyncUncertaintyMs: latencyValue(raw.clockSyncUncertaintyMs),
      outputAudioAvailable: raw.outputAudioAvailable === true,
      ttsError: stringField(raw.ttsError).trim() || undefined,
      outcome: raw.outcome === 'error' ? 'error' as const : 'completed' as const,
      errorCategory: stringField(raw.errorCategory).trim() || undefined,
      errorReason: stringField(raw.errorReason).trim() || undefined,
    }]
  })
  return outputs.length > 0 ? outputs : undefined
}

function normalizeTimedSegments(value: unknown): TimedTranscriptSegment[] {
  if (!Array.isArray(value)) return []
  return value.reduce<TimedTranscriptSegment[]>((segments, candidate) => {
    if (candidate === null || typeof candidate !== 'object') return segments
    const raw = candidate as Record<string, unknown>
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    const startMs = latencyValue(raw.startMs)
    const endMs = latencyValue(raw.endMs)
    if (text === '' || startMs === null || endMs === null || endMs < startMs) return segments
    const memberIds = normalizeMemberIds(raw.memberIds)
    segments.push({
      id: typeof raw.id === 'string' && raw.id.trim() && raw.id.length <= 128 ? raw.id.trim() : `${startMs}-${endMs}`,
      ...(memberIds === undefined ? {} : { memberIds }),
      text,
      startMs,
      endMs,
      receivedAtMs: latencyValue(raw.receivedAtMs) ?? undefined,
      inputAudioStartMs: latencyValue(raw.inputAudioStartMs) ?? undefined,
      outputAudioStartMs: latencyValue(raw.outputAudioStartMs) ?? undefined,
      outputAudioEndMs: latencyValue(raw.outputAudioEndMs) ?? undefined,
      // Missing provenance in legacy records must not be promoted to a
      // provider-native audio timeline. Only an explicit provider marker is
      // strong enough evidence for provider timing.
      timingSource: raw.timingSource === 'provider' ? 'provider' : 'client_estimated',
    })
    return segments
  }, []).sort(compareTimedSegments)
}

function normalizeMemberIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const memberIds = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const memberId = candidate.trim()
    if (!memberId || memberId.length > 128) continue
    memberIds.add(memberId)
  }
  return [...memberIds]
}

function numericValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function latencyValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function withoutDiagnosticEvents(entry: HistoryEntry): HistoryEntry {
  const eventCount = entry.diagnosticEventCount ?? entry.diagnosticEvents?.length ?? 0
  return {
    ...entry,
    diagnosticEvents: undefined,
    diagnosticEventsTruncated: entry.diagnosticEventsTruncated === true || eventCount > 0,
    diagnosticEventCount: eventCount || undefined,
  }
}

function withoutSentenceDiagnostics(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    sentenceDiagnostics: undefined,
    latencyAnalysisTruncated: entry.latencyAnalysisTruncated === true || Boolean(entry.sentenceDiagnostics?.length),
  }
}

function nextSmallerLocalHistory(history: HistoryEntry[]): HistoryEntry[] | null {
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].diagnosticEvents?.length) {
      const next = [...history]
      next[index] = withoutDiagnosticEvents(next[index])
      return next
    }
  }
  for (let index = history.length - 1; index >= 0; index--) {
    if (history[index].sentenceDiagnostics?.length) {
      const next = [...history]
      next[index] = withoutSentenceDiagnostics(next[index])
      return next
    }
  }
  if (history.length > 1) return history.slice(0, -1)
  const [entry] = history
  if (entry?.sourceSegments?.length || entry?.translationSegments?.length) {
    return [{
      ...entry,
      sourceSegments: undefined,
      translationSegments: undefined,
      latencyAnalysisTruncated: true,
    }]
  }
  if (entry?.multilingualOutputs?.some((output) => output.translationSegments?.length)) {
    return [{
      ...entry,
      multilingualOutputs: entry.multilingualOutputs.map((output) => ({ ...output, translationSegments: undefined })),
      latencyAnalysisTruncated: true,
    }]
  }
  return null
}

// Returns the exact records that reached storage. Callers keep their in-memory
// list in sync with any quota-driven compaction instead of showing entries that
// will disappear on the next navigation.
export function saveHistory(history: HistoryEntry[]): HistoryEntry[] {
  let candidate = history.slice(0, HISTORY_LOCAL_MAX_ENTRIES)
  while (candidate.length > 0) {
    const body = JSON.stringify(candidate)
    if (body.length > HISTORY_LOCAL_MAX_CODE_UNITS) {
      const smaller = nextSmallerLocalHistory(candidate)
      if (!smaller) break
      candidate = smaller
      continue
    }
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, body)
      return candidate
    } catch {
      const smaller = nextSmallerLocalHistory(candidate)
      if (!smaller) break
      candidate = smaller
    }
  }
  if (history.length === 0) {
    window.localStorage.removeItem(HISTORY_STORAGE_KEY)
    return []
  }
  throw new Error('浏览器本地存储空间不足，本次历史文本未能保存。')
}

export async function uploadHistoryEntry(entry: HistoryEntry, providedAudio?: HistoryAudioArchive): Promise<HistorySyncResult> {
  const audio: HistoryAudioArchive = providedAudio || await loadHistoryAudio(entry.id).catch(() => ({}))
  const uploads: { kind: HistoryAudioKind; blob: Blob }[] = []
  if (audio.input) uploads.push({ kind: 'input', blob: audio.input })
  if (audio.output) uploads.push({ kind: 'output', blob: audio.output })
  for (const [language, blob] of Object.entries(audio.outputs || {})) {
    if (blob instanceof Blob) uploads.push({ kind: `output-${language}`, blob })
  }
  const uploadKinds = new Set(uploads.map((upload) => upload.kind))
  const missingKinds: HistoryAudioKind[] = []
  let pendingEntry = uploads.reduce((current, upload) => withHistoryAudioAvailability(current, upload.kind, false), entry)
  for (const kind of expectedHistoryAudioKinds(entry)) {
    if (uploadKinds.has(kind)) continue
    const exists = await historyAudioExists(entry, kind).catch(() => false)
    pendingEntry = withHistoryAudioAvailability(pendingEntry, kind, exists)
    if (!exists) missingKinds.push(kind)
  }
  await postHistoryEntry(pendingEntry)
  if (audio.rtcStats) {
    // Best-effort, one-shot: failures are logged, never retried or surfaced.
    void uploadHistoryRTCStats(entry, audio.rtcStats).catch((error) => {
      console.warn('[history] rtcstats upload failed', error)
    })
  }
  if (uploads.length === 0) {
    if (missingKinds.length === 0) await deleteHistoryAudio([entry.id]).catch(() => undefined)
    return { entry: pendingEntry, failedKinds: missingKinds }
  }

  const results = await Promise.allSettled(uploads.map((upload) => uploadHistoryAudio(entry, upload.kind, upload.blob)))
  const syncedEntry = uploads.reduce(
    (current, upload, index) => withHistoryAudioAvailability(current, upload.kind, results[index].status === 'fulfilled'),
    pendingEntry,
  )
  await postHistoryEntry(syncedEntry)
  const failedKinds = [
    ...missingKinds,
    ...uploads.flatMap((upload, index) => results[index].status === 'rejected' ? [upload.kind] : []),
  ]
  // Local blobs are an upload retry cache. Clear them only after every
  // required track and the final OSS JSON update have succeeded.
  if (failedKinds.length === 0) await deleteHistoryAudio([entry.id]).catch(() => undefined)
  return { entry: syncedEntry, failedKinds }
}

function expectedHistoryAudioKinds(entry: HistoryEntry): HistoryAudioKind[] {
  const kinds: HistoryAudioKind[] = []
  if (entry.inputAudioAvailable) kinds.push('input')
  if (entry.outputAudioAvailable) kinds.push('output')
  for (const output of entry.multilingualOutputs || []) {
    if (output.outputAudioAvailable) kinds.push(`output-${output.targetLanguage}`)
  }
  return kinds
}

function withHistoryAudioAvailability(entry: HistoryEntry, kind: HistoryAudioKind, available: boolean): HistoryEntry {
  if (kind === 'input') return { ...entry, inputAudioAvailable: available }
  if (kind === 'output') return { ...entry, outputAudioAvailable: available }
  const language = kind.slice('output-'.length)
  return {
    ...entry,
    multilingualOutputs: entry.multilingualOutputs?.map((output) => output.targetLanguage === language
      ? { ...output, outputAudioAvailable: available }
      : output),
  }
}

async function postHistoryEntry(entry: HistoryEntry) {
  const sentenceDiagnostics = normalizeSentenceDiagnostics(entry.sentenceDiagnostics)
  const latencyAnalysisTruncated = entry.latencyAnalysisTruncated === true || sentenceDiagnosticsWereTruncated(entry.sentenceDiagnostics)
  const diagnosticEvents = normalizeDiagnosticEvents(entry.diagnosticEvents)
  const diagnosticEventsTruncated = entry.diagnosticEventsTruncated === true || diagnosticEventsWereTruncated(entry.diagnosticEvents)
  const payload = {
      schemaVersion: entry.schemaVersion,
      sessionMode: entry.sessionMode,
      multilingualSessionId: entry.multilingualSessionId,
      multilingualTargetLanguages: entry.multilingualTargetLanguages,
      multilingualOutputs: normalizeMultilingualOutputs(entry.multilingualOutputs),
      id: entry.id,
      createdAt: entry.createdAt,
      provider: entry.provider,
      transport: entry.transport,
      model: entry.model,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
      sourceText: entry.sourceText,
      translationText: entry.translationText,
      sourceSegments: normalizeTimedSegments(entry.sourceSegments),
      translationSegments: normalizeTimedSegments(entry.translationSegments),
      sentenceDiagnostics,
      latencyAnalysisTruncated,
      diagnosticEvents,
      diagnosticEventsTruncated,
      observability: normalizeObservability(entry.observability),
      averageTimelineLatencyMs: entry.averageTimelineLatencyMs,
      tailTimelineLatencyP95Ms: entry.tailTimelineLatencyP95Ms,
      timelineSampleCount: entry.timelineSampleCount,
      averageAudioTimelineLatencyMs: entry.averageAudioTimelineLatencyMs,
      tailAudioTimelineLatencyP95Ms: entry.tailAudioTimelineLatencyP95Ms,
      audioTimelineSampleCount: entry.audioTimelineSampleCount,
      providerLagAverageMs: entry.providerLagAverageMs,
      providerLagP95Ms: entry.providerLagP95Ms,
      providerLagSampleCount: entry.providerLagSampleCount,
      synthesisDurationAverageMs: entry.synthesisDurationAverageMs,
      synthesisDurationP95Ms: entry.synthesisDurationP95Ms,
      synthesisDurationSampleCount: entry.synthesisDurationSampleCount,
      audioReceiveToPlaybackAverageMs: entry.audioReceiveToPlaybackAverageMs,
      audioReceiveToPlaybackP95Ms: entry.audioReceiveToPlaybackP95Ms,
      audioReceiveToPlaybackSampleCount: entry.audioReceiveToPlaybackSampleCount,
      ttsRTFAverage: entry.ttsRTFAverage,
      ttsRTFP95: entry.ttsRTFP95,
      ttsRTFSampleCount: entry.ttsRTFSampleCount,
      inputSendIntervalP95Ms: entry.inputSendIntervalP95Ms,
      maxInputSendGapMs: entry.maxInputSendGapMs,
      inputSendIntervalSampleCount: entry.inputSendIntervalSampleCount,
      engineFirstModelTokenMs: entry.engineFirstModelTokenMs,
      engineFirstTextMs: entry.engineFirstTextMs,
      engineFirstTTSReadyMs: entry.engineFirstTTSReadyMs,
      engineAudioToModelFeedMs: entry.engineAudioToModelFeedMs,
      engineModelFeedToFirstOutputMs: entry.engineModelFeedToFirstOutputMs,
      engineModelFeedToStableTextMs: entry.engineModelFeedToStableTextMs,
      engineModelFeedToTTSReadyMs: entry.engineModelFeedToTTSReadyMs,
      recordingToModelSubmitMs: entry.recordingToModelSubmitMs,
      ttsReadyToFirstPlaybackMs: entry.ttsReadyToFirstPlaybackMs,
      clockSyncUncertaintyMs: entry.clockSyncUncertaintyMs,
      browserCaptureToWSSendMs: entry.browserCaptureToWSSendMs,
      browserCaptureToFirstTextMs: entry.browserCaptureToFirstTextMs,
      browserCaptureToFirstStableSentenceMs: entry.browserCaptureToFirstStableSentenceMs,
      browserCaptureToFirstAudioMs: entry.browserCaptureToFirstAudioMs,
      browserFirstAudioReceiveToPlaybackScheduledMs: entry.browserFirstAudioReceiveToPlaybackScheduledMs,
      browserCaptureToFirstPlaybackScheduledMs: entry.browserCaptureToFirstPlaybackScheduledMs,
      browserFirstAudioReceiveToPlaybackMs: entry.browserFirstAudioReceiveToPlaybackMs,
      browserCaptureToFirstPlaybackMs: entry.browserCaptureToFirstPlaybackMs,
      ttsError: entry.ttsError,
      inputAudioAvailable: entry.inputAudioAvailable,
      outputAudioAvailable: entry.outputAudioAvailable,
      firstTextLatency: entry.firstTextLatency,
      firstAudioByteLatency: entry.firstAudioByteLatency,
      firstAudioPlaybackLatency: entry.firstAudioPlaybackLatency,
      outcome: entry.outcome,
      errorCategory: entry.errorCategory,
      errorReason: entry.errorReason,
      disconnectCount: entry.disconnectCount,
      reconnectAttempts: entry.reconnectAttempts,
      maxOutputGapMs: entry.maxOutputGapMs,
      noOutputTimeouts: entry.noOutputTimeouts,
      sessionDurationMs: entry.sessionDurationMs,
      trace: entry.trace,
  }
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).byteLength > HISTORY_MAX_ENTRY_BYTES) {
    throw new Error('共享历史记录与诊断事件合计超过 5 MiB，未上传。')
  }
  const response = await historyFetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  if (!response.ok) throw new Error(await historyResponseError(response))
}

function normalizeSentenceDiagnostics(value: unknown) {
  if (!Array.isArray(value)) return []
  const fields = [
    'textReceivedAtMs', 'textStableAtMs', 'providerAudioStartMs', 'providerAudioEndMs', 'providerLagMs',
    'synthesisDurationMs', 'engineFirstModelTokenMs', 'engineModelFeedToStableTextMs',
    'engineModelFeedToTTSReadyMs', 'audioReceivedAtMs', 'agentPlayoutStartedAtMs', 'agentQueueWaitMs',
    'playbackStartedAtMs', 'audioDurationMs', 'playbackSequence',
  ] as const
  return value.slice(0, HISTORY_MAX_SENTENCE_DIAGNOSTICS).flatMap((candidate) => {
    if (candidate === null || typeof candidate !== 'object') return []
    const record = candidate as Record<string, unknown>
    const segmentId = stringField(record.segmentId)
    if (!segmentId || segmentId.length > 128) return []
    const normalized: Record<string, unknown> = { segmentId }
    for (const field of fields) {
      const number = latencyValue(record[field])
      if (number !== null) normalized[field] = number
    }
    const agentMediaStartSample = record.agentMediaStartSample
    const agentMediaEndSample = record.agentMediaEndSample
    const agentMediaSampleRateHz = record.agentMediaSampleRateHz
    const agentFirstFrameSequence = record.agentFirstFrameSequence
    if (
      Number.isInteger(agentMediaStartSample) && (agentMediaStartSample as number) >= 0 &&
      Number.isInteger(agentMediaEndSample) && (agentMediaEndSample as number) > (agentMediaStartSample as number) &&
      Number.isInteger(agentMediaSampleRateHz) && (agentMediaSampleRateHz as number) > 0 &&
      Number.isInteger(agentFirstFrameSequence) && (agentFirstFrameSequence as number) > 0
    ) {
      normalized.agentMediaStartSample = agentMediaStartSample
      normalized.agentMediaEndSample = agentMediaEndSample
      normalized.agentMediaSampleRateHz = agentMediaSampleRateHz
      normalized.agentFirstFrameSequence = agentFirstFrameSequence
    }
    if (record.playbackTimingSource === 'browser_observed' || record.playbackTimingSource === 'browser_scheduled' || record.playbackTimingSource === 'agent_reported') {
      normalized.playbackTimingSource = record.playbackTimingSource
    }
    return [normalized]
  })
}

function sentenceDiagnosticsWereTruncated(value: unknown) {
  return Array.isArray(value) && value.length > HISTORY_MAX_SENTENCE_DIAGNOSTICS
}

function normalizeDiagnosticEvents(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return []
  const producers = new Set<DiagnosticEvent['producer']>(['backend', 'provider', 'agent', 'browser'])
  return value.slice(0, HISTORY_MAX_DIAGNOSTIC_EVENTS).flatMap((candidate, index) => {
    if (candidate === null || typeof candidate !== 'object') return []
    const record = candidate as Record<string, unknown>
    const producer = record.producer
    const eventType = stringField(record.eventType).trim()
    if (!producers.has(producer as DiagnosticEvent['producer']) || !eventType || eventType.length > 128) return []
    const sequence = Number.isInteger(record.sequence) && (record.sequence as number) > 0
      ? record.sequence as number
      : index + 1
    const receivedAtMs = latencyValue(record.receivedAtMs)
    const segmentId = stringField(record.segmentId).trim()
    const payload = normalizeDiagnosticPayload(record.payload)
    return [{
      sequence,
      producer: producer as DiagnosticEvent['producer'],
      eventType,
      ...(receivedAtMs === null ? {} : { receivedAtMs }),
      ...(segmentId && segmentId.length <= 128 ? { segmentId } : {}),
      ...(Object.keys(payload).length > 0 ? { payload } : {}),
    }]
  }).sort((left, right) => left.sequence - right.sequence)
}

function normalizeDiagnosticPayload(value: unknown): NonNullable<DiagnosticEvent['payload']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const payload: NonNullable<DiagnosticEvent['payload']> = {}
  for (const [rawKey, candidate] of Object.entries(value)) {
    const key = rawKey.slice(0, 128)
    const lowered = key.toLowerCase()
    const normalizedKey = lowered.replace(/[^a-z0-9]/g, '')
    const credentialToken = normalizedKey === 'token' || ['accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken'].some((marker) => normalizedKey.includes(marker))
    if (!key || key === 'audio' || lowered.endsWith('audio') || credentialToken || ['secret', 'authorization', 'password', 'cookie', 'credential', 'apikey', 'accesskey', 'signature'].some((marker) => normalizedKey.includes(marker))) continue
    if (candidate === null || typeof candidate === 'boolean') payload[key] = candidate
    else if (typeof candidate === 'number' && Number.isFinite(candidate)) payload[key] = candidate
    else if (typeof candidate === 'string') payload[key] = candidate.slice(0, 4_000)
  }
  return payload
}

function diagnosticEventsWereTruncated(value: unknown) {
  return Array.isArray(value) && value.length > HISTORY_MAX_DIAGNOSTIC_EVENTS
}

function normalizeObservability(value: unknown) {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const traceId = stringField(record.traceId)
  const requestId = stringField(record.requestId)
  const sessionId = stringField(record.sessionId)
  const safeTraceId = /^[0-9a-f]{32}$/i.test(traceId) && !/^0{32}$/.test(traceId) ? traceId.toLowerCase() : undefined
  const safeRequestId = /^[A-Za-z0-9._-]{1,128}$/.test(requestId) ? requestId : undefined
  const safeSessionId = /^[A-Za-z0-9._-]{1,128}$/.test(sessionId) ? sessionId : undefined
  if (!safeTraceId && !safeRequestId && !safeSessionId) return undefined
  return { traceId: safeTraceId, requestId: safeRequestId, sessionId: safeSessionId }
}

async function historyResponseError(response: Response) {
  try {
    const value = await response.json() as { error?: unknown }
    if (typeof value.error === 'string' && value.error.trim()) return value.error.trim()
    if (value.error && typeof value.error === 'object' && 'message' in value.error && typeof value.error.message === 'string' && value.error.message.trim()) {
      return value.error.message.trim()
    }
  } catch {
    // Fall through to a stable status-aware message when the response is not JSON.
  }
  return `共享历史同步失败（HTTP ${response.status}）`
}

async function uploadHistoryAudio(entry: HistoryEntry, kind: HistoryAudioKind, audio: Blob) {
  const response = await historyFetch(historyAudioURL(entry, kind), {
    method: 'PUT',
    headers: { 'Content-Type': 'audio/wav' },
    body: audio,
  })
  if (!response.ok) throw new Error(`${kind === 'input' ? '输入' : '翻译'}音频同步失败（HTTP ${response.status}）`)
}

export function historyRTCStatsURL(entry: HistoryEntry) {
  return `/api/history/${encodeURIComponent(entry.id)}/rtcstats?createdAt=${encodeURIComponent(entry.createdAt)}`
}

async function uploadHistoryRTCStats(entry: HistoryEntry, rtcStats: RTCStatsArchive) {
  const response = await historyFetch(historyRTCStatsURL(entry), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rtcStats),
  })
  if (!response.ok) throw new Error(`rtcstats upload failed: ${response.status}`)
}

export function historyAudioURL(entry: HistoryEntry, kind: HistoryAudioKind) {
  if (historyRecordType(entry) === 'batch') {
    if (kind === 'input') {
      if (!entry.sampleMediaId || !entry.sampleMediaCreatedAt) return ''
      return `/api/benchmark/media/${encodeURIComponent(entry.sampleMediaId)}/normalized?createdAt=${encodeURIComponent(entry.sampleMediaCreatedAt)}`
    }
    return `/api/benchmark/results/${encodeURIComponent(entry.id)}/audio/output?createdAt=${encodeURIComponent(entry.createdAt)}`
  }
  return `/api/history/${encodeURIComponent(entry.id)}/audio/${kind}?createdAt=${encodeURIComponent(entry.createdAt)}`
}

// Availability flags are metadata and can outlive an OSS object after a
// partial migration or cleanup. Probe only the WAV header via byte range so
// history cards can fall back cleanly instead of rendering a broken player.
export async function historyAudioExists(entry: HistoryEntry, kind: HistoryAudioKind) {
  const response = await historyFetch(historyAudioURL(entry, kind), {
    headers: { Range: 'bytes=0-11' },
  })
  if (response.body) await response.body.cancel().catch(() => undefined)
  return response.ok
}

export function historyExportURL(entry: HistoryEntry) {
  if (historyRecordType(entry) !== 'realtime') return ''
  return `/api/history/${encodeURIComponent(entry.id)}/export?createdAt=${encodeURIComponent(entry.createdAt)}`
}

export async function deleteSharedHistoryEntry(entry: HistoryEntry): Promise<void> {
  if (historyRecordType(entry) !== 'realtime') throw new Error('仅支持删除实时同传历史')
  const response = await historyFetch(
    `/api/history/${encodeURIComponent(entry.id)}?createdAt=${encodeURIComponent(entry.createdAt)}`,
    { method: 'DELETE' },
  )
  if (!response.ok) throw new Error(await historyResponseError(response))
}

export function historyTranscriptFallback(entry: HistoryEntry, kind: 'source' | 'translation') {
  const value = kind === 'source' ? entry.sourceText : entry.translationText
  if (value.trim()) return value
  if (kind === 'source' && isFixedCloneProvider(entry.provider)) {
    return '本次 S2ST 会话未收到原文转写，请播放下方“输入语音”查看本次内容。'
  }
  const label = kind === 'source' ? '原文' : '译文'
  if (entry.outcome === 'error') {
    return `会话在收到${label}文本前失败${entry.errorReason ? `：${entry.errorReason}` : '。'}`
  }
  return `本次会话未收到${label}文本。`
}

export function normalizeHistorySearch(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export async function fetchSharedHistoryByTraceID(traceID: string): Promise<HistoryEntry[]> {
  const value = traceID.trim().toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(value) || /^0{32}$/.test(value)) {
    throw new Error('Trace ID 必须是 32 位十六进制字符串')
  }
  const response = await historyFetch(`/api/history?traceId=${encodeURIComponent(value)}`)
  if (!response.ok) throw new Error(await historyResponseError(response))
  const payload = await response.json() as { items?: unknown }
  return normalizeHistory(payload.items)
}

export type UploaderSummary = {
  email: string
  trialCount: number
  totalDurationMs: number
  badCaseCount: number
  lastActiveAt: string
}

// UploaderDailySummary is one client-timezone day's per-uploader rollup, newest
// day first as returned by the backend.
export type UploaderDailySummary = {
  date: string
  uploaders: UploaderSummary[]
}

export type UploaderSummaryPayload = {
  uploaders: UploaderSummary[]
  daily: UploaderDailySummary[]
}

// fetchHistoryUploaders returns the 全站 per-uploader rollup (email / total
// session duration / bad-case count / trial count / last active) backing the
// shared history summary table, plus the same rollup regrouped per client-day
// so the table can show 每日工作量. An empty email marks guest uploads.
export async function fetchHistoryUploaders(): Promise<UploaderSummaryPayload> {
  const response = await historyFetch(`/api/history/uploaders?tz=${clientTZOffset()}`)
  if (!response.ok) throw new Error(await historyResponseError(response))
  const payload = await response.json() as { uploaders?: UploaderSummary[]; daily?: UploaderDailySummary[] }
  return {
    uploaders: Array.isArray(payload.uploaders) ? payload.uploaders : [],
    daily: Array.isArray(payload.daily) ? payload.daily : [],
  }
}
