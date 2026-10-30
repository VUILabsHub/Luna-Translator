// Change record (2026-08-05): reconcile stable TTS units with the live
// cumulative model snapshot so unfinished output can render immediately.
import { isFixedCloneProvider } from '../languageCapabilities'
import {
  joinTranscriptFragment,
  splitCompletedSentences,
  translationUnitSeparator,
} from '@simultrans/core/textJoin'

export { joinTranscriptFragment, splitCompletedSentences, translationUnitSeparator }
import type {
  DiagnosticEvent,
  NativeMetricSample,
  ServerEvent,
  TimedAudioSegment,
  TimedTranscriptSegment,
  TranslationDisplayUnit,
} from '../types/history'

export function splitTranscriptLines(value: string) {
  // A period between two digits is a decimal point, not a sentence boundary.
  return value.split(/\r\n?|\n/u)
    .flatMap((line) => line.match(/(?:[^。！？!?；;.]|(?<=\d)\.(?=\d))+(?:[。！？!?；;.]|$)[”"’'）)\]】》」』]*/gu) || [])
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Builds the live VUILabs sentence timeline directly from the cumulative
 * browser snapshot. A sentence keeps one stable row while its text grows;
 * punctuation starts the next row. Every visible row therefore has a client
 * arrival timestamp without waiting for a provider-final event.
 */
export function reconcileStreamingTranslationSegments(
  current: TimedTranscriptSegment[],
  snapshot: string,
  receivedAtMs: number | undefined,
  idPrefix: string,
  providerSegmentId?: string,
  providerSegmentText?: string,
  providerStartMs?: number,
  providerEndMs?: number,
) {
  const lines = splitTranscriptLines(snapshot)
  const arrivalMs = validNonNegativeNumber(receivedAtMs)
    ? receivedAtMs
    : current.at(-1)?.receivedAtMs ?? 0
  const segmentId = providerSegmentId?.trim() || ''
  const segmentText = providerSegmentText?.trim() || ''
  const hasProviderTimeline = validNonNegativeNumber(providerStartMs)
    && validNonNegativeNumber(providerEndMs)
    && providerEndMs >= providerStartMs
  let providerOrdinals: number[] = []
  if (segmentId && lines.length > 0) {
    providerOrdinals = matchingProviderSentenceOrdinals(lines, segmentText)
  }
  const providerOrdinalSet = new Set(providerOrdinals)

  let previousOutputEndMs = 0
  return lines.map((text, ordinal): TimedTranscriptSegment => {
    const id = `${idPrefix}-${ordinal}`
    const previous = current.find((segment) => segment.id === id)
    const changed = previous?.text !== text
    // Transfer a reused provider id only after its destination is unambiguous.
    // Otherwise a shared-prefix preview could erase a previously verified
    // association and attach its audio timeline to the wrong sentence.
    const transfersProviderSegment = providerOrdinals.length > 0
    const memberIds = new Set(
      transfersProviderSegment
        ? (previous?.memberIds || []).filter((memberId) => memberId !== segmentId)
        : previous?.memberIds || [],
    )
    if (providerOrdinalSet.has(ordinal)) memberIds.add(segmentId)
    const usesProviderTimeline = providerOrdinalSet.has(ordinal) && hasProviderTimeline
    const continuesSameRow = Boolean(
      previous
      && (text.startsWith(previous.text) || previous.text.startsWith(text)),
    )
    const timingSource = usesProviderTimeline
      ? 'provider'
      : changed ? 'client_estimated' : previous?.timingSource ?? 'client_estimated'
    let startMs = usesProviderTimeline
      ? providerStartMs
      : continuesSameRow ? previous?.startMs ?? arrivalMs : arrivalMs
    if (timingSource === 'client_estimated' && previous?.timingSource !== 'provider') {
      startMs = Math.max(startMs, previousOutputEndMs)
    }
    const endMs = usesProviderTimeline
      ? providerEndMs
      : changed ? Math.max(startMs, arrivalMs) : Math.max(startMs, previous?.endMs ?? arrivalMs)
    previousOutputEndMs = endMs
    return {
      id,
      memberIds: [...memberIds],
      text,
      startMs,
      endMs,
      receivedAtMs: changed || usesProviderTimeline ? arrivalMs : previous?.receivedAtMs ?? arrivalMs,
      timingSource,
    }
  })
}

function matchingProviderSentenceOrdinals(lines: string[], segmentText: string) {
  if (!segmentText) return lines.length > 0 ? [lines.length - 1] : []

  const exactOrdinal = lastIndexMatching(lines, (line) => line === segmentText)
  if (exactOrdinal >= 0) return [exactOrdinal]

  const target = canonicalTranscriptText(segmentText)
  const contiguousMatches: number[][] = []
  for (let start = 0; start < lines.length; start += 1) {
    let combined = ''
    for (let end = start; end < lines.length; end += 1) {
      combined += lines[end]
      if (canonicalTranscriptText(combined) === target) {
        contiguousMatches.push(Array.from({ length: end - start + 1 }, (_, offset) => start + offset))
      }
    }
  }
  if (contiguousMatches.length === 1) return contiguousMatches[0]

  const compatibleOrdinals = lines.flatMap((line, ordinal) => (
    line.includes(segmentText) || segmentText.includes(line) ? [ordinal] : []
  ))
  return compatibleOrdinals.length === 1 ? compatibleOrdinals : []
}

/** Restores provider ranges for older history rows from archived translation_done events. */
export function restoreTranslationProviderTimelines(
  segments: TimedTranscriptSegment[],
  snapshot: string,
  events: DiagnosticEvent[],
) {
  if (segments.length === 0 || events.length === 0) return segments
  const lines = splitTranscriptLines(snapshot)
  const unused = new Set(segments.map((_, index) => index))
  const semanticSegments = lines.flatMap((line) => {
    const index = segments.findIndex((segment, candidate) => (
      unused.has(candidate) && canonicalTranscriptText(segment.text) === canonicalTranscriptText(line)
    ))
    if (index < 0) return []
    unused.delete(index)
    return [segments[index]]
  })
  if (semanticSegments.length !== lines.length) return segments
  let repaired = [...semanticSegments, ...segments.filter((_, index) => unused.has(index))]
  let changed = false

  for (const event of events) {
    if (event.eventType !== 'translation_done') continue
    const payload = event.payload || {}
    const segmentId = (event.segmentId || (typeof payload.segmentId === 'string' ? payload.segmentId : '')).trim()
    const segmentText = typeof payload.segmentText === 'string' ? payload.segmentText.trim() : ''
    const startMs = typeof payload.startMs === 'number' ? payload.startMs : NaN
    const endMs = typeof payload.endMs === 'number' ? payload.endMs : NaN
    if (!segmentId || !segmentText || !validNonNegativeNumber(startMs) || !validNonNegativeNumber(endMs) || endMs < startMs) continue
    const ordinals = matchingProviderSentenceOrdinals(lines, segmentText)
    if (ordinals.length === 0) continue
    const ordinalSet = new Set(ordinals)
    const needsRepair = ordinals.some((ordinal) => {
      const segment = repaired[ordinal]
      return segment.timingSource !== 'provider'
        || segment.startMs !== startMs
        || segment.endMs !== endMs
        || !segment.memberIds?.includes(segmentId)
    })
    if (!needsRepair) continue
    repaired = repaired.map((segment, ordinal) => {
      const memberIds = (segment.memberIds || []).filter((memberId) => memberId !== segmentId)
      if (!ordinalSet.has(ordinal)) {
        if (memberIds.length === (segment.memberIds || []).length) return segment
        changed = true
        return { ...segment, memberIds }
      }
      changed = true
      return {
        ...segment,
        memberIds: [...new Set([...memberIds, segmentId])],
        startMs,
        endMs,
        receivedAtMs: event.receivedAtMs ?? segment.receivedAtMs,
        timingSource: 'provider' as const,
      }
    })
  }
  return changed ? repaired : segments
}

export function transcriptRemainderAfterConfirmedUnits(
  value: string,
  confirmedUnits: Array<Pick<TranslationDisplayUnit, 'text'>>,
) {
  const snapshot = value.trim()
  const { cursor } = matchingTranscriptPrefix(snapshot, confirmedUnits)
  return snapshot.slice(cursor).trim()
}

export function splitStreamingModelOutput(
  value: string,
  confirmedUnits: TranslationDisplayUnit[],
) {
  const snapshot = value.trim()
  const { cursor, matchedUnitCount } = matchingTranscriptPrefix(snapshot, confirmedUnits)
  return {
    stableUnits: confirmedUnits.slice(0, matchedUnitCount),
    preview: snapshot.slice(cursor).trim(),
  }
}

export function selectStreamingTranslationSnapshot(
  modelOutputSnapshot: string,
  committedTranslation: string,
) {
  return modelOutputSnapshot || committedTranslation
}

export type GroupedTranscriptSentence = TimedTranscriptSegment & {
  /** Original segment ids merged into this synthetic sentence, for playback highlight matching. */
  memberIds: string[]
}

export function reconcileTimedTranscriptPreview(
  value: string,
  timedLines: GroupedTranscriptSentence[],
  confirmedUnits: TranslationDisplayUnit[],
  sentenceOnly = false,
) {
  const confirmedIDs = new Set(
    confirmedUnits.map((unit) => unit.id.trim()).filter(Boolean),
  )
  const eligibleTimedLines = timedLines.filter((line) => {
    const completeSentence = !sentenceOnly || splitCompletedSentences(line.text).remainder === ''
    return completeSentence
      && line.memberIds.length > 0
      && line.memberIds.every((id) => confirmedIDs.has(id))
  })
  const snapshot = value.trim()
  const { cursor, matchedUnitCount } = matchingTranscriptPrefix(snapshot, eligibleTimedLines)
  return {
    timedLines: eligibleTimedLines.slice(0, matchedUnitCount),
    remainder: snapshot.slice(cursor).trim(),
  }
}

export function nextTranslationSnapshot(
  current: string,
  event: Pick<ServerEvent, 'type' | 'text' | 'segmentText'>,
  preserveLongerCumulativeSnapshot = false,
) {
  const eventText = event.text || ''
  if (event.type === 'translation_delta') return current + eventText
  const segmentText = event.segmentText?.trim() || ''
  const doneContainsOnlyCurrentUnit = Boolean(segmentText) && eventText.trim() === segmentText
  if (
    preserveLongerCumulativeSnapshot
    && event.type === 'translation_done'
    && doneContainsOnlyCurrentUnit
    && current.trim().length > eventText.trim().length
  ) {
    return current
  }
  return eventText
}

function matchingTranscriptPrefix(
  value: string,
  units: Array<{ text: string }>,
) {
  let cursor = 0
  let matchedUnitCount = 0
  for (const unit of units) {
    const text = unit.text.trim()
    if (!text) continue
    const unitStart = skipTranscriptWhitespace(value, cursor)
    if (!value.startsWith(text, unitStart)) break
    cursor = unitStart + text.length
    matchedUnitCount += 1
  }
  return { cursor, matchedUnitCount }
}

function skipTranscriptWhitespace(value: string, cursor: number) {
  while (cursor < value.length && /\s/u.test(value[cursor])) cursor += 1
  return cursor
}

export type CumulativeTranscriptUnit = {
  final: boolean
  providerSegmentId?: string
  segment: TimedTranscriptSegment
}

export type CumulativeTranscriptState = {
  snapshot: string
  units: CumulativeTranscriptUnit[]
}

export type CumulativeTranscriptEvent = {
  text: string
  done?: boolean
  segmentId?: string
  segmentText?: string
  startMs?: number
  endMs?: number
  receivedAtMs?: number
  inputAudioStartMs?: number
}

export function emptyCumulativeTranscriptState(): CumulativeTranscriptState {
  return { snapshot: '', units: [] }
}

/**
 * Reconciles an ASR running snapshot. `source_update.text` is authoritative and
 * revisable, so older hypotheses are replaced by sentence ordinal instead of
 * being appended as new transcript rows.
 */
export function reconcileCumulativeTranscript(
  current: CumulativeTranscriptState,
  event: CumulativeTranscriptEvent,
  idPrefix: string,
): CumulativeTranscriptState {
  const snapshot = event.text.trim()
  if (!snapshot) return emptyCumulativeTranscriptState()

  const stablePrefixUnits = current.units.filter((unit) => unit.final)
  const stablePrefix = stablePrefixUnits.reduce(
    (value, unit) => joinTranscriptFragment(value, unit.segment.text),
    '',
  )
  const keepsStablePrefix = Boolean(stablePrefix) && snapshot.startsWith(stablePrefix)
  const prefixUnits = keepsStablePrefix ? stablePrefixUnits : []
  const remainderSnapshot = keepsStablePrefix
    ? snapshot.slice(stablePrefix.length).trimStart()
    : snapshot
  const providerText = event.segmentText?.trim() || ''
  const { completed, remainder } = splitCompletedSentences(remainderSnapshot)
  let pieces = [
    ...completed.map((text) => ({ text, final: true })),
    ...(remainder ? [{ text: remainder, final: Boolean(event.done) }] : []),
  ]

  // A provider timestamp covers the complete finalized ASR item. If that item
  // contains several punctuated sentences, retaining it as one unit preserves
  // the real audio range instead of inventing one browser-arrival range per
  // sentence. Sentence-level display can still split the text later.
  if (
    event.done
    && providerText
    && pieces.length > 1
    && canonicalTranscriptText(remainderSnapshot) === canonicalTranscriptText(providerText)
  ) {
    pieces = [{ text: remainderSnapshot, final: true }]
  }
  if (event.done && providerText && pieces.length > 0) {
    const matchingIndex = lastIndexMatching(
      pieces,
      (piece) => canonicalTranscriptText(piece.text) === canonicalTranscriptText(providerText),
    )
    if (matchingIndex >= 0) pieces[matchingIndex].final = true
  }
  if (event.done && !providerText) {
    for (const piece of pieces) piece.final = true
  }

  const nextDescriptions = [
    ...prefixUnits.map((unit) => ({ text: unit.segment.text, final: true })),
    ...pieces,
  ]
  const receivedAtMs = validNonNegativeNumber(event.receivedAtMs) ? event.receivedAtMs : 0
  const hasProviderTimeline = (
    validNonNegativeNumber(event.startMs)
    && validNonNegativeNumber(event.endMs)
    && event.endMs! >= event.startMs!
  )
  const providerOrdinal = providerText
    ? lastIndexMatching(
      nextDescriptions,
      (description) => canonicalTranscriptText(description.text) === canonicalTranscriptText(providerText),
    )
    : event.done && nextDescriptions.length > 0 ? nextDescriptions.length - 1 : -1

  const units = nextDescriptions.map((description, ordinal): CumulativeTranscriptUnit => {
    const previous = current.units[ordinal]
    const usesProviderTimeline = ordinal === providerOrdinal && hasProviderTimeline
    const providerSegmentId = ordinal === providerOrdinal
      ? event.segmentId?.trim() || previous?.providerSegmentId
      : previous?.providerSegmentId
    if (
      previous
      && previous.segment.text === description.text
      && previous.final === description.final
      && !usesProviderTimeline
      && providerSegmentId === previous.providerSegmentId
    ) return previous

    const startMs = usesProviderTimeline
      ? event.startMs!
      : previous?.segment.startMs ?? receivedAtMs
    const endMs = usesProviderTimeline
      ? event.endMs!
      : Math.max(startMs, receivedAtMs)
    return {
      final: description.final,
      providerSegmentId,
      segment: {
        id: `${idPrefix}:${ordinal}`,
        text: description.text,
        startMs,
        endMs,
        receivedAtMs,
        inputAudioStartMs: ordinal === providerOrdinal
          ? event.inputAudioStartMs
          : previous?.segment.inputAudioStartMs,
        timingSource: usesProviderTimeline ? 'provider' : 'client_estimated',
      },
    }
  })
  return { snapshot, units }
}

function canonicalTranscriptText(value: string) {
  return value.replace(/\s+/gu, '')
}

export function cumulativeTranscriptSegments(state: CumulativeTranscriptState) {
  return state.units.map((unit) => unit.segment)
}

export function groupTimedTranscriptSentences(segments: TimedTranscriptSegment[]) {
  const grouped: GroupedTranscriptSentence[] = []
  let pendingText = ''
  let pendingSegments: TimedTranscriptSegment[] = []

  const flushPending = () => {
    const text = pendingText.trim()
    if (text && pendingSegments.length > 0) {
      grouped.push(mergeTimedSentence(pendingSegments, text, grouped.length))
    }
    pendingText = ''
    pendingSegments = []
  }

  // Older cumulative snapshots may contain a later sentence with an earlier
  // client-estimated start: the sentence already existed as a preview while a
  // preceding ordinal was completely rewritten. Preserve the stored semantic
  // order by making only those unverified client timestamps monotonic. Native
  // provider timelines remain untouched.
  let previousSemanticEndMs = 0
  const orderedSegments = segments.map((segment) => {
    if (segment.timingSource === 'provider') {
      previousSemanticEndMs = Math.max(previousSemanticEndMs, segment.endMs)
      return segment
    }
    const startMs = Math.max(segment.startMs, previousSemanticEndMs)
    const endMs = Math.max(segment.endMs, startMs)
    previousSemanticEndMs = endMs
    return startMs === segment.startMs && endMs === segment.endMs
      ? segment
      : { ...segment, startMs, endMs }
  })

  for (const segment of orderedSegments.sort(compareTimedSegments)) {
    if (
      pendingSegments.length > 0
      && (
        pendingSegments[0].timingSource !== segment.timingSource
        || (
          validNonNegativeNumber(pendingSegments[0].inputAudioStartMs)
          && validNonNegativeNumber(segment.inputAudioStartMs)
          && pendingSegments[0].inputAudioStartMs !== segment.inputAudioStartMs
        )
      )
    ) {
      flushPending()
    }

    pendingText = joinTranscriptFragment(pendingText, segment.text.trim())
    pendingSegments.push(segment)
    const { completed, remainder } = splitCompletedSentences(pendingText)

    for (const sentence of completed) {
      grouped.push(mergeTimedSentence(pendingSegments, sentence, grouped.length))
      pendingSegments = [segment]
    }

    pendingText = remainder
    if (!pendingText) pendingSegments = []
  }

  flushPending()
  return grouped
}

export type TimedUtteranceGroupingOptions = {
  /** Start a new row when the gap to the previous sentence reaches this. */
  maxGapMs?: number
  /** Start a new row once the merged row already holds this many characters. */
  maxChars?: number
}

/**
 * Coarser display grouping for the 原文 timeline: sentence rows from
 * groupTimedTranscriptSentences are merged into utterance/paragraph rows so a
 * short filler like "嗯。" does not occupy its own line. A new row starts only
 * on a timing-source switch, a long gap, or once the row is long enough.
 */
export function groupTimedTranscriptUtterances(
  segments: TimedTranscriptSegment[],
  options?: TimedUtteranceGroupingOptions,
) {
  const maxGapMs = options?.maxGapMs ?? 5000
  const maxChars = options?.maxChars ?? 80
  const utterances: GroupedTranscriptSentence[] = []
  let pending: GroupedTranscriptSentence[] = []
  let pendingChars = 0

  const flush = () => {
    if (pending.length > 0) utterances.push(mergeGroupedUtterance(pending, utterances.length))
    pending = []
    pendingChars = 0
  }

  for (const sentence of groupTimedTranscriptSentences(segments)) {
    const previous = pending[pending.length - 1]
    if (
      previous
      && (
        previous.timingSource !== sentence.timingSource
        || (
          validNonNegativeNumber(previous.inputAudioStartMs)
          && validNonNegativeNumber(sentence.inputAudioStartMs)
          && previous.inputAudioStartMs !== sentence.inputAudioStartMs
        )
        || sentence.startMs - previous.endMs >= maxGapMs
        || pendingChars >= maxChars
      )
    ) flush()
    pending.push(sentence)
    pendingChars += sentence.text.length
  }
  flush()
  return utterances
}

function mergeGroupedUtterance(
  sentences: GroupedTranscriptSentence[],
  utteranceIndex: number,
): GroupedTranscriptSentence {
  if (sentences.length === 1) return sentences[0]
  const first = sentences[0]
  const last = sentences[sentences.length - 1]
  const receivedTimes = sentences
    .map((sentence) => sentence.receivedAtMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const inputAudioStarts = sentences
    .map((sentence) => sentence.inputAudioStartMs)
    .filter((value): value is number => validNonNegativeNumber(value))
  return {
    id: `utterance:${first.id}:${last.id}:${utteranceIndex}`,
    memberIds: [...new Set(sentences.flatMap((sentence) => [sentence.id, ...sentence.memberIds]))],
    text: sentences.reduce((value, sentence) => joinTranscriptFragment(value, sentence.text), ''),
    startMs: first.startMs,
    endMs: Math.max(...sentences.map((sentence) => sentence.endMs)),
    receivedAtMs: receivedTimes.length > 0 ? Math.max(...receivedTimes) : undefined,
    inputAudioStartMs: inputAudioStarts.length > 0 ? Math.min(...inputAudioStarts) : undefined,
    timingSource: sentences.some((sentence) => sentence.timingSource === 'client_estimated')
      ? 'client_estimated'
      : 'provider',
  }
}

function validNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function lastIndexMatching<T>(values: T[], predicate: (value: T) => boolean) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index])) return index
  }
  return -1
}

export function mergeTimedSentence(
  segments: TimedTranscriptSegment[],
  text: string,
  sentenceIndex: number,
): GroupedTranscriptSentence {
  const first = segments[0]
  const last = segments[segments.length - 1]
  const receivedTimes = segments
    .map((segment) => segment.receivedAtMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const outputAudioStarts = segments
    .map((segment) => segment.outputAudioStartMs)
    .filter((value): value is number => validNonNegativeNumber(value))
  const inputAudioStarts = segments
    .map((segment) => segment.inputAudioStartMs)
    .filter((value): value is number => validNonNegativeNumber(value))
  return {
    id: `sentence:${first.id}:${last.id}:${sentenceIndex}`,
    memberIds: [...new Set(segments.flatMap((segment) => [segment.id, ...(segment.memberIds || [])]))],
    text,
    startMs: first.startMs,
    endMs: Math.max(...segments.map((segment) => segment.endMs)),
    receivedAtMs: receivedTimes.length > 0 ? Math.max(...receivedTimes) : undefined,
    inputAudioStartMs: inputAudioStarts.length > 0 ? Math.min(...inputAudioStarts) : undefined,
    outputAudioStartMs: outputAudioStarts.length > 0 ? Math.min(...outputAudioStarts) : undefined,
    timingSource: segments.some((segment) => segment.timingSource === 'client_estimated')
      ? 'client_estimated'
      : 'provider',
  }
}

export function applyOutputAudioStarts(
  segments: TimedTranscriptSegment[],
  starts: ReadonlyMap<string, number>,
  ends: ReadonlyMap<string, number> = new Map(),
): TimedTranscriptSegment[] {
  let changed = false
  const next = segments.map((segment) => {
    const ids = [segment.id, ...(segment.memberIds || [])]
    const candidates = ids.flatMap((id) => {
      const value = starts.get(id)
      return value === undefined ? [] : [value]
    })
    if (candidates.length === 0) return segment
    const outputAudioStartMs = Math.min(...candidates)
    const endCandidates = ids.flatMap((id) => ends.has(id) ? [ends.get(id)!] : [])
    const outputAudioEndMs = endCandidates.length > 0 ? Math.max(...endCandidates) : segment.outputAudioEndMs
    if (segment.outputAudioStartMs === outputAudioStartMs && segment.outputAudioEndMs === outputAudioEndMs) return segment
    changed = true
    return { ...segment, outputAudioStartMs, outputAudioEndMs }
  })
  return changed ? next : segments
}

export function upsertTranslationDisplayUnit(
  current: TranslationDisplayUnit[],
  event: ServerEvent,
): TranslationDisplayUnit[] {
  if (event.type !== 'translation_done') return current
  const id = event.segmentId?.trim()
  const text = event.segmentText?.trim()
  if (!id || !text) return current

  const replacedIDs = new Set(
    Array.isArray(event.replaceSegmentIds)
      ? event.replaceSegmentIds
        .filter((candidate): candidate is string => typeof candidate === 'string')
        .map((candidate) => candidate.trim())
        .filter((candidate) => candidate !== '' && candidate !== id)
      : [],
  )
  const retained = replacedIDs.size > 0
    ? current.filter((unit) => !replacedIDs.has(unit.id))
    : current
  const existingIndex = retained.findIndex((unit) => unit.id === id)
  if (existingIndex < 0) return [...retained, { id, text }]
  if (retained[existingIndex].text === text) {
    return retained.length === current.length ? current : retained
  }
  const next = [...retained]
  next[existingIndex] = { id, text }
  return next
}

export function upsertTimedSegment(
  current: TimedTranscriptSegment[],
  event: ServerEvent,
  receivedAtMs?: number,
  provider?: string,
  inputAudioStartMs?: number,
): TimedTranscriptSegment[] {
  const replacedIDs = new Set(
    Array.isArray(event.replaceSegmentIds)
      ? event.replaceSegmentIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [],
  )
  const retained = replacedIDs.size > 0
    ? current.filter((segment) => !replacedIDs.has(segment.id))
    : current
  const text = event.segmentText?.trim()
  const hasProviderTimeline = (
    typeof event.startMs === 'number'
    && typeof event.endMs === 'number'
    && Number.isFinite(event.startMs)
    && Number.isFinite(event.endMs)
    && event.startMs >= 0
    && event.endMs >= event.startMs
  )
  const hasClientEstimate = (
    (provider === 'aliyun' || isFixedCloneProvider(provider || ''))
    && (event.type === 'source_done' || event.type === 'translation_done')
    && Boolean(text)
    && typeof receivedAtMs === 'number'
    && Number.isFinite(receivedAtMs)
    && receivedAtMs >= 0
  )
  if (
    !text ||
    (!hasProviderTimeline && !hasClientEstimate)
  ) {
    return retained.length === current.length ? current : retained
  }
  const startMs = hasProviderTimeline ? event.startMs! : receivedAtMs!
  const endMs = hasProviderTimeline ? event.endMs! : receivedAtMs!
  const timingSource = hasProviderTimeline ? 'provider' as const : 'client_estimated' as const
  const id = event.segmentId?.trim() || `${timingSource}:${event.type}:${Math.round(endMs)}`
  const nextSegment: TimedTranscriptSegment = {
    id, text, startMs, endMs, receivedAtMs, timingSource,
    ...(validNonNegativeNumber(inputAudioStartMs) ? { inputAudioStartMs } : {}),
  }
  const existingIndex = retained.findIndex((segment) => segment.id === id)
  if (existingIndex < 0) return [...retained, nextSegment].sort(compareTimedSegments)
  const existing = retained[existingIndex]
  if (nextSegment.inputAudioStartMs === undefined) nextSegment.inputAudioStartMs = existing.inputAudioStartMs
  if (
    existing.text === nextSegment.text &&
    existing.startMs === nextSegment.startMs &&
    existing.endMs === nextSegment.endMs &&
    existing.receivedAtMs === nextSegment.receivedAtMs &&
    existing.inputAudioStartMs === nextSegment.inputAudioStartMs &&
    existing.timingSource === nextSegment.timingSource
  ) {
    return retained.length === current.length ? current : retained
  }
  const next = [...retained]
  next[existingIndex] = nextSegment
  return next.sort(compareTimedSegments)
}

export function compareTimedSegments(
  left: Pick<TimedTranscriptSegment, 'id' | 'startMs' | 'endMs'>,
  right: Pick<TimedTranscriptSegment, 'id' | 'startMs' | 'endMs'>,
) {
  return left.startMs - right.startMs || left.endMs - right.endMs || left.id.localeCompare(right.id)
}

export function upsertTimedAudioSegment(current: TimedAudioSegment[], event: ServerEvent, receivedAtMs: number): TimedAudioSegment[] {
  if (
    typeof event.startMs !== 'number' ||
    typeof event.endMs !== 'number' ||
    !Number.isFinite(event.startMs) ||
    !Number.isFinite(event.endMs) ||
    event.startMs < 0 ||
    event.endMs <= event.startMs
  ) {
    return current
  }
  const id = event.segmentId?.trim() || `${event.startMs}-${event.endMs}`
  const segment = { id, startMs: event.startMs, endMs: event.endMs, receivedAtMs }
  const existingIndex = current.findIndex((candidate) => candidate.id === id)
  if (existingIndex < 0) return [...current, segment].sort(compareTimedSegments)
  const existing = current[existingIndex]
  if (existing.startMs === segment.startMs && existing.endMs === segment.endMs && existing.receivedAtMs === receivedAtMs) return current
  const next = [...current]
  next[existingIndex] = segment
  return next.sort(compareTimedSegments)
}

export function upsertNativeMetricSample(current: NativeMetricSample[], segmentID: string | undefined, valueMs: number) {
  const id = segmentID?.trim() || `sample-${current.length}`
  const sample = { id, valueMs }
  const existingIndex = current.findIndex((candidate) => candidate.id === id)
  if (existingIndex < 0) return [...current, sample]
  if (current[existingIndex].valueMs === valueMs) return current
  const next = [...current]
  next[existingIndex] = sample
  return next
}
