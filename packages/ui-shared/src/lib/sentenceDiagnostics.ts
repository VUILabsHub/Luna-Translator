import type { SentenceDiagnostic, TimedTranscriptSegment } from '../types/history'

export type SentenceDiagnosticPatch = Omit<SentenceDiagnostic, 'segmentId'>

export type SentenceMetricAvailabilityCode =
  | 'protocol_absent'
  | 'session_only'
  | 'webrtc_unobservable'
  | 'dependency_missing'
  | 'pending'

export type SentenceMetricMissingState = {
  code: SentenceMetricAvailabilityCode
  label: string
  reason: string
}

const sentenceMetricAvailabilityLabels: Record<SentenceMetricAvailabilityCode, string> = {
  protocol_absent: '协议未返回',
  session_only: '仅会话级',
  webrtc_unobservable: 'WebRTC 无逐句观测',
  dependency_missing: '依赖项缺失',
  pending: '等待回传',
}

export function sentenceMetricMissingState(
  code: SentenceMetricAvailabilityCode,
  detail: string,
  referenceValue?: string | null,
): SentenceMetricMissingState {
  const label = sentenceMetricAvailabilityLabels[code]
  return {
    code,
    label: referenceValue ? `${label} · ${referenceValue}` : label,
    reason: `${label}（${code}）：${detail}`,
  }
}

export function hasPerSentenceModelLog(diagnostics: SentenceDiagnostic[]) {
  return diagnostics.some((item) => [
    item.engineFirstModelTokenMs,
    item.engineModelFeedToStableTextMs,
    item.engineModelFeedToTTSReadyMs,
  ].some((value) => typeof value === 'number' && Number.isFinite(value)))
}

const firstObservationFields = [
  'textReceivedAtMs',
  'textStableAtMs',
  'audioReceivedAtMs',
  'agentPlayoutStartedAtMs',
  'playbackStartedAtMs',
] as const satisfies ReadonlyArray<keyof SentenceDiagnosticPatch>

export function upsertSentenceDiagnostic(
  current: SentenceDiagnostic[],
  segmentId: string | undefined,
  patch: SentenceDiagnosticPatch,
) {
  const id = segmentId?.trim() || ''
  if (!id) return current
  const cleanPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as SentenceDiagnosticPatch
  if (Object.keys(cleanPatch).length === 0) return current
  const existingIndex = current.findIndex((item) => item.segmentId === id)
  if (existingIndex < 0) return [...current, { segmentId: id, ...cleanPatch }]
  const existing = current[existingIndex]
  const nextItem = { ...existing, ...cleanPatch }
  const mutableNext = nextItem as Record<keyof SentenceDiagnostic, unknown>
  for (const field of firstObservationFields) {
    const previous = existing[field]
    const incoming = cleanPatch[field]
    if (typeof previous === 'number' && typeof incoming === 'number') {
      mutableNext[field] = Math.min(previous, incoming)
    }
  }
  if (
    existing.playbackTimingSource === 'browser_observed' &&
    cleanPatch.playbackTimingSource !== 'browser_observed'
  ) {
    nextItem.playbackTimingSource = 'browser_observed'
    nextItem.playbackStartedAtMs = existing.playbackStartedAtMs
  } else if (
    cleanPatch.playbackTimingSource === 'browser_observed' &&
    existing.playbackTimingSource !== 'browser_observed'
  ) {
    nextItem.playbackStartedAtMs = cleanPatch.playbackStartedAtMs
  }
  if (Object.entries(nextItem).every(([key, value]) => existing[key as keyof SentenceDiagnostic] === value)) {
    return current
  }
  return current.map((item, index) => index === existingIndex ? nextItem : item)
}

export function diagnosticsForSentence(
  segment: Pick<TimedTranscriptSegment, 'id' | 'memberIds'>,
  diagnostics: SentenceDiagnostic[],
) {
  const memberIds = new Set([segment.id, ...(segment.memberIds || [])])
  return diagnostics.filter((diagnostic) => memberIds.has(diagnostic.segmentId))
}

export function firstDiagnosticValue(
  diagnostics: SentenceDiagnostic[],
  field: keyof SentenceDiagnostic,
) {
  const values = diagnostics
    .map((diagnostic) => diagnostic[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? Math.min(...values) : null
}

export function lastDiagnosticValue(
  diagnostics: SentenceDiagnostic[],
  field: keyof SentenceDiagnostic,
) {
  const values = diagnostics
    .map((diagnostic) => diagnostic[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? Math.max(...values) : null
}

export function summedDiagnosticValue(
  diagnostics: SentenceDiagnostic[],
  field: keyof SentenceDiagnostic,
) {
  const values = diagnostics
    .map((diagnostic) => diagnostic[field])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null
}
