import type { TimedTranscriptSegment, TranslationDisplayUnit } from '../types/history'
import { joinTranscriptFragment, translationUnitSeparator } from './transcript'
import type { VadTranscriptPair } from './vadTranscriptPairs'
import {
  splitTranscriptPair as splitShowcasePair, stableTranslationSentences,
  unsplitPairPart, segmentIdsForText, type TranscriptPairPart as ShowcasePairPart,
} from '@simultrans/core/transcriptSegmentation'
import { indexedPlaybackText } from './playbackText'

export type ShowcaseTranscriptRow = {
  id: string
  source: string
  translation: string
  atomicLiveRow?: boolean
  /** Presentation boundary released after the row's TTS finishes. */
  playbackCommitted?: boolean
  translationPlaybackFragments?: ShowcaseTranslationPlaybackFragment[]
  startMs: number
  playing: boolean
  /**
   * 译文整体的播放状态（Figma 565:6727「多段」：未读黑 / 阅读中绿 / 已读或跳过灰）。
   * 没有 TTS 段落 id 时为 undefined，UI 退回按行位置着色。
   */
  playbackStatus?: ShowcasePlaybackStatus
}

/**
 * pending：文字已到、TTS 还没念到；playing：正在念；played：念完；
 * skipped：暂停期间被丢弃、不会再念。
 */
export type ShowcasePlaybackStatus = 'pending' | 'playing' | 'played' | 'skipped'
export type ShowcaseSettledPlaybackStatus = Extract<ShowcasePlaybackStatus, 'played' | 'skipped'>

export type ShowcaseTranslationPlaybackFragment = {
  text: string
  segmentId?: string
  playing: boolean
  status?: ShowcasePlaybackStatus
}

export type SemanticAlignmentPair = {
  id: string
  source: string
  translation: string
  sourceStart: number | null
  sourceEnd: number | null
  targetStart: number
  targetEnd: number
  emittedAtMs: number
  sourceAudioMs: number
  status: 'tentative' | 'frozen' | 'approximate' | 'unmatched'
  kind: 'match' | 'source_only' | 'target_only'
  similarity: number | null
  confidence: number | null
}

export type ShowcaseSemanticAlignment = {
  key: string
  pendingTranslation: string
  pairs: SemanticAlignmentPair[]
  liveSource: string
  liveTranslation: string
  atomicLiveRow?: boolean
}

export type ShowcaseRowMergeState = {
  owners: Map<string, string>
  ids: Map<string, string>
  committedIds?: Set<string>
  committedRows?: Map<string, ShowcaseTranscriptRow[]>
  playbackRevisions?: Map<string, number>
  sourceScopes?: Set<string>
  liveRows?: Map<string, ShowcaseTranscriptRow>
}

export type ShowcaseRowsInput = {
  sourceText: string
  translation: string
  modelOutputTranslation: string
  sourceSegments: TimedTranscriptSegment[]
  translationDisplayUnits: TranslationDisplayUnit[]
  vadTranscriptPairs: VadTranscriptPair[]
  playingTranslationSegmentId: string | ReadonlySet<string> | null
  /** 已经念完 / 被跳过的 TTS 段落；不传则所有片段只区分「播放中」与否。 */
  settledTranslationSegments?: ReadonlyMap<string, ShowcaseSettledPlaybackStatus>
  /** Includes queued audio, so text-only omissions cannot be confused with unread audio. */
  receivedTranslationAudioSegments?: ReadonlySet<string>
  semanticAlignments?: Record<string, ShowcaseSemanticAlignment>
  terminal?: boolean
  rowMergeState?: ShowcaseRowMergeState
}

type PlaybackStatusInput = Pick<ShowcaseRowsInput, 'playingTranslationSegmentId' | 'settledTranslationSegments' | 'receivedTranslationAudioSegments'>

function isPlayingTranslationSegment(
  playingTranslationSegmentId: ShowcaseRowsInput['playingTranslationSegmentId'],
  segmentId: string,
) {
  return typeof playingTranslationSegmentId === 'string'
    ? playingTranslationSegmentId === segmentId
    : Boolean(playingTranslationSegmentId?.has(segmentId))
}

function translationSegmentStatus(
  { playingTranslationSegmentId, settledTranslationSegments }: PlaybackStatusInput,
  segmentId: string,
): ShowcasePlaybackStatus | undefined {
  if (isPlayingTranslationSegment(playingTranslationSegmentId, segmentId)) return 'playing'
  if (!settledTranslationSegments) return undefined
  return settledTranslationSegments.get(segmentId) ?? 'pending'
}

/**
 * 多个段落合成一个状态：有一个在念就是 playing；有一个还没念就是 pending
 * （整行还会继续被念）；否则全部念完或跳过，只有全被跳过才算 skipped。
 */
export function combinePlaybackStatuses(
  statuses: ReadonlyArray<ShowcasePlaybackStatus | undefined>,
): ShowcasePlaybackStatus | undefined {
  const known = statuses.filter((status): status is ShowcasePlaybackStatus => status !== undefined)
  if (known.length === 0) return undefined
  if (known.includes('playing')) return 'playing'
  if (known.includes('pending')) return 'pending'
  return known.every((status) => status === 'skipped') ? 'skipped' : 'played'
}

function rowPlaybackStatus(input: PlaybackStatusInput, segmentIds: readonly string[]) {
  return combinePlaybackStatuses(segmentIds.map((segmentId) => translationSegmentStatus(input, segmentId)))
}

type ShowcasePairingInput = Omit<ShowcaseRowsInput, 'playingTranslationSegmentId' | 'settledTranslationSegments'>

type ShowcasePlaceholderStatus = 'idle' | 'connecting' | 'recording' | 'processing' | 'finished' | 'error'

const normalized = (value: string | undefined) => value?.trim() || ''

const validPairStartMs = (value: number | undefined): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
)

const pairStartMs = (pair: VadTranscriptPair) => (
  validPairStartMs(pair.sourceVadStartMs)
    ? pair.sourceVadStartMs
    : validPairStartMs(pair.startMs) ? pair.startMs : undefined
)

function stableTranslationText(pair: VadTranscriptPair, final: boolean) {
  const units = pair.translationUnits.reduce(
    (value, unit) => value + translationUnitSeparator(value, unit.text) + unit.text,
    '',
  )
  return normalized(
    pair.translationStableEpochText
    || units
    || (final ? pair.translation : ''),
  )
}

export function semanticAlignmentRequestForPair(pair: VadTranscriptPair, final: boolean) {
  const source = normalized(pair.source)
  const translation = normalized(pair.translation)
  const confirmedSource = normalized(pair.sourceStableText || (final ? source : ''))
  const stableTranslation = stableTranslationText(pair, final)
  const sentences = stableTranslationSentences(stableTranslation, final)
  const pendingTranslation = stableTranslation && translation.startsWith(stableTranslation)
    ? translation.slice(stableTranslation.length).trim()
    : translation
  const payload = {
    source,
    targets: sentences.map((sentence) => ({
      text: sentence.text,
      emittedAtMs: pair.endMs ?? pair.startMs,
      sourceAudioMs: pairStartMs(pair) ?? pair.startMs,
      soft: sentence.soft,
    })),
    final,
  }
  return {
    pairId: pair.id,
    key: JSON.stringify(payload),
    payload,
    stableSource: source,
    confirmedSourceEnd: [...confirmedSource].length,
    stableTranslation,
    targetEnds: sentences.map((sentence) => sentence.end),
    pendingTranslation,
  }
}

function playbackFragment(
  text: string,
  segmentId: string | undefined,
  status: ShowcasePlaybackStatus | undefined,
): ShowcaseTranslationPlaybackFragment {
  return {
    text,
    segmentId,
    playing: status === 'playing',
    ...(status ? { status } : {}),
  }
}

/**
 * 不属于任何 TTS 段落的夹缝文字（标点、空格）跟随后一个段落的状态，
 * 没有后一个就跟随前一个，避免灰色行中间冒出黑色标点。
 */
function fillGapFragmentStatuses(fragments: ShowcaseTranslationPlaybackFragment[]) {
  let previous: ShowcasePlaybackStatus | undefined
  for (let index = 0; index < fragments.length; index += 1) {
    const fragment = fragments[index]
    if (fragment.segmentId) {
      previous = fragment.status
      continue
    }
    const next = fragments.slice(index + 1).find((candidate) => candidate.segmentId)?.status
    const status = next ?? previous
    if (status) fragment.status = status
  }
  return fragments
}

function translationPlaybackFragments(
  pair: Pick<VadTranscriptPair, 'translation' | 'translationUnits'>,
  text: string,
  playback: PlaybackStatusInput,
  translationStart: number,
) {
  const units = pair.translationUnits.filter((unit) => unit.text.trim() && unit.providerSegmentId)
  if (!text || units.length === 0) return undefined

  const indexed = indexedPlaybackText(text)
  const containingUnits = translationStart < 0
    ? units.filter(unit => indexedPlaybackText(unit.text.trim()).text.includes(indexed.text)) : []
  // Repeated phrases alone cannot identify an earlier or later audio unit.
  if (containingUnits.length > 1) return undefined
  const containingUnit = containingUnits[0]
  if (containingUnit) {
    return [playbackFragment(
      text,
      containingUnit.providerSegmentId,
      translationSegmentStatus(playback, containingUnit.providerSegmentId),
    )]
  }
  // Without a position in the cumulative text, searching all units in this
  // row would bind a later repeated word to unrelated earlier audio.
  if (translationStart < 0) return undefined

  const fragments: ShowcaseTranslationPlaybackFragment[] = []
  const fullText = translationStart >= 0 ? indexedPlaybackText(pair.translation).text : indexed.text
  const rowStart = Math.max(0, translationStart)
  let unitCursor = 0
  let cursor = 0
  let matched = false
  const append = (fragmentText: string, segmentId?: string) => {
    if (!fragmentText) return
    fragments.push(playbackFragment(
      fragmentText,
      segmentId,
      segmentId ? translationSegmentStatus(playback, segmentId) : undefined,
    ))
  }
  for (const unit of units) {
    const unitText = indexedPlaybackText(unit.text.trim()).text
    if (!unitText) continue
    const start = fullText.indexOf(unitText, unitCursor)
    if (start < 0) continue
    unitCursor = start + unitText.length
    // TTS and semantic sentences can cross each other's boundaries (e.g.
    // "15," + "999. From ..."). Map their overlap in the complete translation.
    const overlapStart = Math.max(0, start - rowStart)
    const overlapEnd = Math.min(indexed.text.length, unitCursor - rowStart)
    if (overlapEnd <= overlapStart) continue
    const displayStart = indexed.starts[overlapStart]
    const displayEnd = (indexed.starts[overlapEnd] ?? text.length)
      - (text.slice(indexed.ends[overlapEnd - 1], indexed.starts[overlapEnd] ?? text.length).match(/\s+$/u)?.[0].length || 0)
    append(text.slice(cursor, displayStart))
    append(text.slice(displayStart, displayEnd), unit.providerSegmentId)
    cursor = displayEnd
    matched = true
  }
  if (!matched) return undefined
  append(text.slice(cursor))
  return fillGapFragmentStatuses(fragments)
}

function semanticShowcasePairParts(
  pair: VadTranscriptPair,
  alignment: ShowcaseSemanticAlignment,
): ShowcasePairPart[] {
  const parts: ShowcasePairPart[] = alignment.pairs.map((part) => {
    const source = normalized(part.source)
    const translation = normalized(part.translation)
    return {
      id: `${pair.id}:${part.id}`,
      source,
      translation,
      sourceOffset: part.sourceStart ?? 0,
      translationSegmentIds: segmentIdsForText(pair, part.translation),
    }
  })
  const consumedSourceEnd = alignment.pairs.reduce(
    (maximum, part) => Math.max(maximum, part.sourceEnd ?? maximum),
    0,
  )
  const liveSource = normalized(alignment.liveSource)
  const serviceLiveTranslation = normalized(alignment.liveTranslation)
  const pendingTranslation = normalized(alignment.pendingTranslation)
  const liveTranslation = pendingTranslation
    ? serviceLiveTranslation
      + translationUnitSeparator(serviceLiveTranslation, pendingTranslation)
      + pendingTranslation
    : serviceLiveTranslation
  if (liveSource || liveTranslation) {
    const livePair = {
      ...pair,
      id: `${pair.id}:semantic-live`,
      source: liveSource,
      translation: liveTranslation,
    }
    const livePairParts = alignment.atomicLiveRow
      ? [{ ...unsplitPairPart(livePair, liveSource, liveTranslation), atomicLiveRow: true }]
      : splitShowcasePair(livePair)
    parts.push(...livePairParts.map((part) => ({
      ...part,
      sourceOffset: consumedSourceEnd + part.sourceOffset,
    })))
  }
  return parts
}

type ShowcaseDisplayRow = ShowcaseTranscriptRow & {
  mergeKey: string
  forceCommit: boolean
  displayOrder: number
}

function completePlaybackFragments(row: ShowcaseTranscriptRow) {
  if (!row.translation) return []
  const fragments = row.translationPlaybackFragments
  return fragments?.map(({ text }) => text).join('') === row.translation
    ? fragments
    : [playbackFragment(row.translation, undefined, row.playbackStatus ?? (row.playing ? 'playing' : undefined))]
}

function showcaseRowScope(id: string) {
  const separator = id.indexOf('\u001f')
  return separator < 0 ? '' : id.slice(0, separator + 1)
}

export const hasShowcaseContent = (text: string) => /[\p{L}\p{N}]/u.test(text)

function isOneSidedShowcaseRow(row: ShowcaseTranscriptRow) {
  return hasShowcaseContent(row.source) !== hasShowcaseContent(row.translation)
}

function hasTranslationBoundary(row: ShowcaseTranscriptRow) {
  return completePlaybackFragments(row).some(fragment => fragment.segmentId && hasShowcaseContent(fragment.text))
}

function mergeShowcaseRows(
  earlier: ShowcaseDisplayRow,
  later: ShowcaseDisplayRow,
): ShowcaseDisplayRow {
  const separator = translationUnitSeparator(earlier.translation, later.translation)
  const hasPlaybackFragments = Boolean(
    earlier.translationPlaybackFragments || later.translationPlaybackFragments,
  )
  const playbackStatus = combinePlaybackStatuses([earlier.playbackStatus, later.playbackStatus])
  const {
    atomicLiveRow: _baseAtomicLiveRow,
    ...baseRow
  } = earlier
  return {
    ...baseRow,
    forceCommit: later.forceCommit,
    source: joinTranscriptFragment(earlier.source, later.source),
    translation: earlier.translation + separator + later.translation,
    translationPlaybackFragments: hasPlaybackFragments
      ? fillGapFragmentStatuses([
          ...completePlaybackFragments(earlier),
          ...(separator ? [playbackFragment(separator, undefined, undefined)] : []),
          ...completePlaybackFragments(later),
        ])
      : undefined,
    startMs: Math.min(earlier.startMs, later.startMs),
    playing: earlier.playing || later.playing,
    ...(playbackStatus ? { playbackStatus } : {}),
    displayOrder: Math.min(earlier.displayOrder, later.displayOrder),
    ...(later.atomicLiveRow ? { atomicLiveRow: true } : {}),
  }
}

function compactShowcaseRowScope(rows: ShowcaseDisplayRow[], state: ShowcaseRowMergeState) {
  const compacted: ShowcaseDisplayRow[] = []
  const sourceScopes = state.sourceScopes ??= new Set<string>()
  const scope = showcaseRowScope(rows[0].id)
  if (rows.some(row => hasShowcaseContent(row.source))) sourceScopes.add(scope)
  const sourceMissing = !sourceScopes.has(scope)
  const retainTranslation = (row: ShowcaseDisplayRow) => sourceMissing && hasTranslationBoundary(row)
  const committed = (row: ShowcaseDisplayRow) => state.committedIds?.has(row.id)
  const ownerOf = (key: string): string => {
    const owner = state.owners.get(key)
    return owner && owner !== key ? ownerOf(owner) : key
  }
  const appendTo = (index: number, row: ShowcaseDisplayRow) => {
    const earlier = compacted[index]
    state.owners.set(row.mergeKey, earlier.mergeKey)
    compacted[index] = mergeShowcaseRows(earlier, row)
  }

  for (const row of rows) {
    // A semantic live tail can later acquire a finalized ID. Use its original
    // source offset to keep the display group and late TTS in the same row.
    const owner = ownerOf(row.mergeKey)
    const existing = compacted.findIndex(candidate => candidate.mergeKey === owner)
    if (existing >= 0) {
      // Late semantic splits can insert rows inside a previously merged group.
      // Keep all intervening text in order instead of moving it past this row.
      while (compacted.length > existing + 1 && !compacted.slice(existing).some(committed)) {
        const [inside] = compacted.splice(existing + 1, 1)
        appendTo(existing, inside)
      }
      appendTo(existing, row)
    } else {
      if (!state.ids.has(row.mergeKey)) {
        // A live tail and a newly frozen prefix may otherwise share the same
        // presentation ID after the tail moves to a later source offset.
        const id = [...state.ids.values()].includes(row.id) ? row.mergeKey : row.id
        state.ids.set(row.mergeKey, id)
      }
      row.id = state.ids.get(row.mergeKey) as string
      const previous = compacted.at(-1)
      if (previous && !committed(previous) && isOneSidedShowcaseRow(previous) && !retainTranslation(previous)) {
        // Ordinary pauses keep the unmatched tail attached to what follows.
        appendTo(compacted.length - 1, row)
      } else {
        compacted.push(row)
      }
    }
    const tail = compacted.at(-1) as ShowcaseDisplayRow
    if (tail.forceCommit && isOneSidedShowcaseRow(tail) && !retainTranslation(tail) && compacted.length > 1
      && !committed(tail) && !committed(compacted[compacted.length - 2])) {
      // Strong VAD (or session completion) closes the remaining tail upward.
      compacted.pop()
      appendTo(compacted.length - 1, tail)
    }
  }

  return compacted.map((row, index) => {
    if (index === compacted.length - 1 || !row.atomicLiveRow) return row
    const { atomicLiveRow: _atomicLiveRow, ...settledRow } = row
    return settledRow
  })
}

function mergeUnmatchedShowcaseRows(rows: ShowcaseDisplayRow[], state: ShowcaseRowMergeState): ShowcaseTranscriptRow[] {
  const scopes = new Map<string, ShowcaseDisplayRow[]>()
  rows.forEach((row) => {
    const scope = showcaseRowScope(row.id)
    scopes.set(scope, [...(scopes.get(scope) || []), row])
  })
  return [...scopes.values()]
    .flatMap(rows => compactShowcaseRowScope(rows, state))
    .sort((left, right) => left.displayOrder - right.displayOrder)
    .map(({ mergeKey: _mergeKey, forceCommit: _forceCommit, displayOrder: _displayOrder, ...row }) => row)
}

const playbackContent = (text: string) => text.replace(/[^\p{L}\p{N}\p{M}]/gu, '')

function playbackPrefixEnd(text: string, count: number) {
  if (!count) return 0
  let end = 0
  for (const character of text) {
    if (playbackContent(character)) {
      if (!count) break
      count -= 1
    }
    end += character.length
  }
  return end
}

function slicePlaybackFragments(row: ShowcaseTranscriptRow, start: number, end = row.translation.length) {
  let offset = 0
  return completePlaybackFragments(row).flatMap(fragment => {
    const from = Math.max(0, start - offset)
    const to = Math.min(fragment.text.length, end - offset)
    offset += fragment.text.length
    return to > from ? [{ ...fragment, text: fragment.text.slice(from, to) }] : []
  })
}

/** Retained semantic rows keep their text, but must acquire newly arrived audio IDs. */
export function refreshShowcasePlaybackRows(rows: ShowcaseTranscriptRow[], input: ShowcaseRowsInput) {
  const contexts = new Map<string, Pick<VadTranscriptPair, 'translation' | 'translationUnits'>>()
  for (const pair of orderedShowcasePairs(input.vadTranscriptPairs)) {
    const scope = showcaseRowScope(pair.id)
    const context = contexts.get(scope) || { translation: '', translationUnits: [] }
    context.translationUnits.push(...pair.translationUnits)
    contexts.set(scope, context)
  }
  for (const context of contexts.values()) {
    context.translationUnits = [...new Map(context.translationUnits.map(unit => [unit.providerSegmentId, unit])).values()]
  }
  for (const row of rows) {
    const context = contexts.get(showcaseRowScope(row.id))
    if (context) context.translation += indexedPlaybackText(row.translation).text
  }
  const cursors = new Map<string, number>()
  return rows.map(row => {
    const scope = showcaseRowScope(row.id), context = contexts.get(scope)
    if (!context || !row.translation) return row
    const content = indexedPlaybackText(row.translation).text
    const start = content ? context.translation.indexOf(content, cursors.get(scope) || 0) : -1
    if (start < 0) return row
    cursors.set(scope, start + content.length)
    const fragments = translationPlaybackFragments(context, row.translation, input, start)
    if (!fragments) return row
    return { ...row, translationPlaybackFragments: fragments,
      playing: fragments.some(fragment => fragment.playing),
      playbackStatus: combinePlaybackStatuses(fragments.map(fragment => fragment.status)) }
  })
}

// Translation is append-only here. Locate each old boundary by its cumulative
// translated content, never by a source offset from before an ASR correction.
// A boundary inside an unmatched tail or a larger new pair is not reliable.
function correctedHistorySources(history: ShowcaseTranscriptRow[], incoming: ShowcaseTranscriptRow[]) {
  const sources: string[] = []
  let cursor = 0, expectedEnd = 0, actualEnd = 0
  for (const previous of history) {
    const targetLength = [...playbackContent(previous.translation)].length
    if (!targetLength) return undefined
    expectedEnd += targetLength
    let source = ''
    while (actualEnd < expectedEnd && cursor < incoming.length) {
      const row = incoming[cursor++]
      if (row.atomicLiveRow) return undefined
      actualEnd += [...playbackContent(row.translation)].length
      source = joinTranscriptFragment(source, row.source)
    }
    if (actualEnd !== expectedEnd || (hasShowcaseContent(previous.source) && !hasShowcaseContent(source))) return undefined
    sources.push(source)
  }
  return sources
}

/** Keep semantic boundaries intact while presenting unplayed rows as one live tail. */
export function commitPlayedShowcaseRows(
  rows: ShowcaseTranscriptRow[],
  state: ShowcaseRowMergeState,
  terminal: boolean,
  playback?: PlaybackStatusInput & Partial<Pick<ShowcaseRowsInput, 'vadTranscriptPairs'>>,
): ShowcaseTranscriptRow[] {
  const committedIds = state.committedIds ??= new Set<string>()
  const committedRows = state.committedRows ??= new Map<string, ShowcaseTranscriptRow[]>()
  const sourceScopes = state.sourceScopes ??= new Set<string>()
  const liveRows = state.liveRows ??= new Map<string, ShowcaseTranscriptRow>()
  const scopes = new Map<string, ShowcaseDisplayRow[]>()
  rows.forEach((row, displayOrder) => {
    // A pending alignment can retain an older text snapshot. Playback must
    // still use current events, or that snapshot could wait forever.
    if (playback && row.translationPlaybackFragments) {
      const fragments = fillGapFragmentStatuses(row.translationPlaybackFragments.map(fragment => (
        fragment.segmentId
          ? playbackFragment(fragment.text, fragment.segmentId, translationSegmentStatus(playback, fragment.segmentId))
          : { ...fragment }
      )))
      row = { ...row, translationPlaybackFragments: fragments,
        playing: fragments.some(fragment => fragment.playing),
        playbackStatus: combinePlaybackStatuses(fragments.map(fragment => fragment.status)) }
    }
    const scope = showcaseRowScope(row.id)
    const group = scopes.get(scope) || []
    group.push({ ...row, mergeKey: row.id, forceCommit: false, displayOrder })
    scopes.set(scope, group)
  })
  return [...scopes.entries()].flatMap(([scope, incoming]) => {
    if (incoming.some(row => hasShowcaseContent(row.source))) sourceScopes.add(scope)
    const audioIds = [...new Set(playback?.vadTranscriptPairs
      ?.filter(pair => showcaseRowScope(pair.id) === scope)
      .flatMap(pair => pair.translationUnits.map(unit => unit.providerSegmentId).filter(Boolean)) || [])]
    const active = typeof playback?.playingTranslationSegmentId === 'string'
      ? [playback.playingTranslationSegmentId] : [...(playback?.playingTranslationSegmentId || [])]
    // Translation can arrive without any TTS or skip event. Once a later unit
    // has really played, an earlier text-only omission must not block the tail.
    // Received (including queued) audio and active audio remain protected.
    const omittedAudio = new Set<string>()
    if (playback?.receivedTranslationAudioSegments) {
      let laterPlayed = false
      for (const id of [...audioIds].reverse()) {
        if (translationSegmentStatus(playback, id) === 'played') laterPlayed = true
        else if (laterPlayed && !active.includes(id) && !playback.receivedTranslationAudioSegments.has(id)) omittedAudio.add(id)
      }
    }
    const audioDrained = Boolean(playback && audioIds.length
      && !active.some(id => showcaseRowScope(id) === scope)
      && audioIds.every(id => omittedAudio.has(id) || ['played', 'skipped'].includes(translationSegmentStatus(playback, id) || '')))
    const history = committedRows.get(scope) || []
    let sourcePrefix = playbackContent(history.map(row => row.source).join(''))
    const translationPrefix = playbackContent(history.map(row => row.translation).join(''))
    // Freeze content, not merely row IDs: a late semantic regroup can reuse an
    // old ID while adding new TTS. Only consume the already committed prefix.
    const translationCompatible = playbackContent(incoming.map(row => row.translation).join('')).startsWith(translationPrefix)
    const compatible = playbackContent(incoming.map(row => row.source).join('')).startsWith(sourcePrefix) && translationCompatible
    const sourceRepair = !compatible && translationCompatible && history.length > 0
    const correctedSources = sourceRepair ? correctedHistorySources(history, incoming) : undefined
    const awaitingSourceBoundary = sourceRepair && !correctedSources
    if (correctedSources) sourcePrefix = playbackContent(correctedSources.join(''))
    // Authoritative ASR/translation rewrites invalidate the old prefix. Give
    // the replacement its own identity instead of reusing a committed row ID.
    const revisions = state.playbackRevisions ??= new Map<string, number>()
    if (!compatible && !sourceRepair && history.length) revisions.set(scope, (revisions.get(scope) || 0) + 1)
    const revision = revisions.get(scope) || 0
    const current = revision ? incoming.map(row => ({ ...row, id: `${row.id}:revision:${revision}` })) : incoming
    let sourceLeft = [...sourcePrefix].length
    let translationLeft = [...translationPrefix].length
    let group = compatible || sourceRepair ? current.flatMap(row => {
      const sourceEnd = awaitingSourceBoundary ? row.source.length : playbackPrefixEnd(row.source, sourceLeft)
      const translationEnd = playbackPrefixEnd(row.translation, translationLeft)
      sourceLeft -= [...playbackContent(row.source.slice(0, sourceEnd))].length
      translationLeft -= [...playbackContent(row.translation.slice(0, translationEnd))].length
      const source = row.source.slice(sourceEnd).trim()
      const translation = row.translation.slice(translationEnd)
      if (!hasShowcaseContent(source) && !hasShowcaseContent(translation)) return []
      const fragments = slicePlaybackFragments(row, translationEnd)
      return [{ ...row, source, translation, translationPlaybackFragments: fragments,
        playing: fragments.some(fragment => fragment.playing),
        id: committedIds.has(row.id) ? `${row.id}:after:${sourcePrefix.length}:${translationPrefix.length}` : row.id }]
    }) : current
    // Prefix clipping can create one-sided remainders after ordinary compaction.
    // Attach them to the editable following row, without rewriting old history.
    // A language with no source at all retains its translation boundaries.
    // Keep a shared TTS together only until playback settles. Preserve the
    // semantic boundary so completed audio cannot permanently join long rows.
    const groupedRowIds = new Map<string, string[]>()
    {
      const compacted: ShowcaseDisplayRow[] = []
      const hasSource = sourceScopes.has(scope)
      for (const row of group) {
        const previous = compacted.at(-1)
        const previousAudio = previous && completePlaybackFragments(previous)
          .filter(fragment => fragment.segmentId && hasShowcaseContent(fragment.text)).at(-1)
        const nextAudio = completePlaybackFragments(row)
          .find(fragment => fragment.segmentId && hasShowcaseContent(fragment.text))
        const sharedAudioPending = previousAudio && nextAudio
          && previousAudio.segmentId === nextAudio.segmentId
          && [previousAudio, nextAudio].some(fragment => fragment.playing
            || (fragment.status !== 'played' && fragment.status !== 'skipped'))
        if (previous && (sharedAudioPending
          || (!terminal && isOneSidedShowcaseRow(previous)
            && (hasSource || !hasShowcaseContent(previous.translation))))) {
          groupedRowIds.set(previous.id, [...(groupedRowIds.get(previous.id) || [previous.id]), row.id])
          compacted[compacted.length - 1] = mergeShowcaseRows(previous, row)
        } else compacted.push(row)
      }
      group = compacted
    }
    const result: ShowcaseDisplayRow[] = []
    const retained = compatible || sourceRepair ? history : []
    const nextHistory = [...retained]
    // History playback can still be highlighted without moving its text back
    // into the live tail. Reuse current fragment states by TTS ID.
    const currentFragments = new Map(incoming.flatMap(row => completePlaybackFragments(row))
      .filter(fragment => fragment.segmentId).map(fragment => [fragment.segmentId, fragment]))
    retained.forEach((row, index) => {
      const fragments = completePlaybackFragments(row).map(fragment => {
        const current = currentFragments.get(fragment.segmentId)
        return current ? { ...fragment, playing: current.playing, status: current.status } : fragment
      })
      result.push({ ...row, translationPlaybackFragments: fragments, playing: fragments.some(f => f.playing),
        mergeKey: row.id, forceCommit: false, displayOrder: incoming[0].displayOrder - retained.length + index })
    })
    let tail: ShowcaseDisplayRow | undefined
    let batch: ShowcaseDisplayRow | undefined
    let batchAudioIds = new Set<string>()
    let batchUnmappedRows = 0
    group.forEach((row, index) => {
      const fragments = completePlaybackFragments(row).filter(fragment => hasShowcaseContent(fragment.text))
      // A revised/unspoken word has no audio ID. Once this language's known
      // audio is drained AND a later mapped boundary has been read, it must
      // not pin every following paragraph forever. Never invent a highlight ID.
      const passedUnmappedText = audioDrained && group.slice(index + 1).some(next => (
        completePlaybackFragments(next).some(fragment => fragment.segmentId
          && (fragment.status === 'played' || fragment.status === 'skipped'))
      ))
      const played = !row.playing && fragments.length > 0
        && fragments.every(fragment => fragment.segmentId
          ? fragment.status === 'played' || fragment.status === 'skipped' || omittedAudio.has(fragment.segmentId)
          : passedUnmappedText)
      const remaining = group.slice(index + 1)
      const hasLiveTail = remaining.some(next => hasShowcaseContent(next.translation))
        && (!sourceScopes.has(scope) || remaining.some(next => hasShowcaseContent(next.source)))
      const ready = !awaitingSourceBoundary && (terminal
        || (!tail && hasLiveTail && (!isOneSidedShowcaseRow(row) || row.id.includes(':after:') || hasTranslationBoundary(row)) && played))
      if (ready) {
        if (tail) {
          result.push(tail)
          tail = undefined
        }
        for (const id of groupedRowIds.get(row.id) || [row.id]) committedIds.add(id)
        const audioIds = new Set(fragments.flatMap(fragment => fragment.segmentId ? [fragment.segmentId] : []))
        const combinedIds = new Set([...batchAudioIds, ...audioIds])
        const unmappedRows = batchUnmappedRows + (audioIds.size ? 0 : 1)
        // Group only this promotion's ready prefix, using the existing semantic
        // display limits. Keep every child audio ID; never merge into old history
        // or collect the terminal flush into one large paragraph.
        const merged = !terminal && batch ? mergeShowcaseRows(batch, row) : undefined
        if (merged && [...merged.source].length <= 60 && [...merged.translation].length <= 320
          && combinedIds.size + unmappedRows <= 3) {
          batch = { ...merged, playbackCommitted: true }
          result[result.length - 1] = batch
          nextHistory[nextHistory.length - 1] = batch
          batchAudioIds = combinedIds
          batchUnmappedRows = unmappedRows
        } else {
          batch = { ...row, playbackCommitted: true }
          result.push(batch)
          nextHistory.push(batch)
          batchAudioIds = audioIds
          batchUnmappedRows = audioIds.size ? 0 : 1
        }
      } else {
        // This temporary display merge must never enter state.owners: when TTS
        // ends the original semantic rows must be available for committing.
        tail = tail ? mergeShowcaseRows(tail, row) : row
        tail.playbackCommitted = false
      }
    })
    const previousLive = liveRows.get(scope)
    if (awaitingSourceBoundary) {
      // Keep only the last known live source until matching locates its start.
      // New translation and its real playback fragments remain visible now.
      tail = { ...(tail || current[0]), id: previousLive?.id || current[0].id,
        source: previousLive?.source || '', translation: tail?.translation || '',
        translationPlaybackFragments: tail?.translationPlaybackFragments || [],
        playing: tail?.playing || false, atomicLiveRow: true, playbackCommitted: false }
    }
    if (correctedSources && (terminal || nextHistory.length > retained.length)) {
      correctedSources.forEach((source, index) => {
        result[index] = { ...result[index], source }
        nextHistory[index] = { ...nextHistory[index], source }
      })
    }
    if (!tail && !terminal && compatible && previousLive) {
      // ASR/translation can both retract briefly. Keep the live slot's identity
      // so its height does not vanish and history never becomes the live row.
      tail = { ...previousLive, source: '', translation: '', translationPlaybackFragments: [],
        playing: false, playbackStatus: undefined, playbackCommitted: false,
        mergeKey: previousLive.id, forceCommit: false, displayOrder: incoming.length }
    }
    if (tail) result.push(tail)
    if (!terminal && tail) liveRows.set(scope, tail)
    else liveRows.delete(scope)
    committedRows.set(scope, nextHistory)
    return result
  }).sort((left, right) => left.displayOrder - right.displayOrder)
    .map(({ mergeKey: _mergeKey, forceCommit: _forceCommit, displayOrder: _displayOrder, ...row }) => row)
}

function childStartMs(pair: VadTranscriptPair, sourceOffset: number) {
  const startMs = pairStartMs(pair) ?? pair.startMs
  if (!pair.source.length || pair.endMs === undefined || pair.endMs <= startMs) return startMs
  return startMs + ((pair.endMs - startMs) * sourceOffset) / pair.source.length
}

export const orderedShowcasePairs = (pairs: VadTranscriptPair[]) => pairs
  .map((pair, originalIndex) => ({ pair, originalIndex }))
  .sort((left, right) => {
    const leftStartMs = pairStartMs(left.pair)
    const rightStartMs = pairStartMs(right.pair)
    if (leftStartMs !== undefined && rightStartMs !== undefined && leftStartMs !== rightStartMs) {
      return leftStartMs - rightStartMs
    }
    if (leftStartMs !== undefined && rightStartMs === undefined) return -1
    if (leftStartMs === undefined && rightStartMs !== undefined) return 1
    if (left.pair.speechEpoch > 0 && right.pair.speechEpoch > 0 && left.pair.speechEpoch !== right.pair.speechEpoch) {
      return left.pair.speechEpoch - right.pair.speechEpoch
    }
    if (left.pair.speechEpoch > 0 && right.pair.speechEpoch <= 0) return -1
    if (left.pair.speechEpoch <= 0 && right.pair.speechEpoch > 0) return 1
    return left.originalIndex - right.originalIndex || left.pair.id.localeCompare(right.pair.id)
  })
  .map(({ pair }) => pair)

export function pendingShowcaseRowKey({
  sourceText,
  translation,
  modelOutputTranslation,
  sourceSegments,
  translationDisplayUnits,
  vadTranscriptPairs,
}: ShowcasePairingInput) {
  if (vadTranscriptPairs.length > 0) {
    for (const pair of orderedShowcasePairs(vadTranscriptPairs)) {
      for (const part of splitShowcasePair(pair)) {
        const hasSource = hasShowcaseContent(part.source)
        const hasTranslation = hasShowcaseContent(part.translation)
        if (hasSource !== hasTranslation) {
          return `${part.id}:${hasSource ? 'translation' : 'source'}`
        }
      }
    }
    return ''
  }
  const hasLiveSource = Boolean(
    normalized(sourceText)
    || sourceSegments.some((segment) => normalized(segment.text)),
  )
  const hasLiveTranslation = Boolean(
    normalized(modelOutputTranslation)
    || normalized(translation)
    || translationDisplayUnits.some((unit) => normalized(unit.text)),
  )
  if (hasLiveSource === hasLiveTranslation) return ''
  return `fallback:live:${hasLiveSource ? 'translation' : 'source'}`
}

export function hasPendingShowcaseRow(input: ShowcasePairingInput) {
  return pendingShowcaseRowKey(input) !== ''
}

export function showcasePairingStatusMessage(pendingKey: string, terminal: boolean) {
  if (terminal) return '部分内容未完成配对。'
  return pendingKey.endsWith(':source') ? '原文识别中…' : '译文生成中…'
}

export function showcaseEmptyPlaceholder(status: ShowcasePlaceholderStatus, pendingKey: string) {
  if (status === 'connecting') return '正在连接翻译服务…'
  const terminal = status === 'finished' || status === 'error'
  if (pendingKey) return showcasePairingStatusMessage(pendingKey, terminal)
  if (status === 'finished') return '本次未识别到有效语音。'
  if (status === 'error') return '本次未生成可展示内容。'
  if (status === 'processing') return '正在结束同传…'
  return '请开始讲话…'
}

/**
 * A Gateway VAD pair is already an explicit alignment unit, so its available
 * side can be rendered immediately while the other side is still streaming.
 * Unidentified fallback text stays aggregated and requires both languages,
 * because it has no backend-proven sentence boundary.
 */
export function buildShowcaseRows({
  sourceText,
  translation,
  modelOutputTranslation,
  sourceSegments,
  translationDisplayUnits,
  vadTranscriptPairs,
  playingTranslationSegmentId,
  settledTranslationSegments,
  semanticAlignments,
  terminal = false,
  rowMergeState = { owners: new Map(), ids: new Map() },
}: ShowcaseRowsInput): ShowcaseTranscriptRow[] {
  const playback: PlaybackStatusInput = { playingTranslationSegmentId, settledTranslationSegments }
  if (vadTranscriptPairs.length > 0) {
    let displayOrder = 0
    const orderedPairs = orderedShowcasePairs(vadTranscriptPairs)
    const partsByPair = new Map(orderedPairs.map(pair => [pair, semanticAlignments?.[pair.id]
      ? semanticShowcasePairParts(pair, semanticAlignments[pair.id]) : splitShowcasePair(pair)]))
    // A model preview can leave words in an earlier VAD while their eventual
    // TTS belongs to the next VAD. Match by occurrence across the same language,
    // without moving display text or treating an unidentified word as played.
    const playbackScopes = new Map<string, Pick<VadTranscriptPair, 'translation' | 'translationUnits'>>()
    const playbackOffsets = new Map<VadTranscriptPair, number>()
    for (const pair of orderedPairs) {
      const scope = showcaseRowScope(pair.id)
      const context = playbackScopes.get(scope) || { translation: '', translationUnits: [] }
      // Hidden preview text can also occur in the next VAD. Only displayed
      // content should consume an audio occurrence in the shared timeline.
      const text = partsByPair.get(pair)!.map(part => indexedPlaybackText(part.translation).text).join('')
      playbackOffsets.set(pair, context.translation.length)
      context.translation += text
      context.translationUnits.push(...pair.translationUnits)
      playbackScopes.set(scope, context)
    }
    for (const context of playbackScopes.values()) {
      context.translationUnits = [...new Map(context.translationUnits.map(unit => [unit.providerSegmentId, unit])).values()]
    }
    const rows = orderedPairs.flatMap((pair) => {
      const parts = partsByPair.get(pair)!
      let translationCursor = 0
      const playbackText = parts.map(part => indexedPlaybackText(part.translation).text).join('')
      return parts.flatMap((part) => {
        if (!hasShowcaseContent(part.source) && !hasShowcaseContent(part.translation)) return []
        const partText = indexedPlaybackText(part.translation).text
        const translationStart = playbackText.indexOf(partText, translationCursor)
        if (translationStart >= 0) translationCursor = translationStart + partText.length
        const fragments = translationPlaybackFragments(
          playbackScopes.get(showcaseRowScope(pair.id))!, part.translation, playback,
          translationStart < 0 ? -1 : playbackOffsets.get(pair)! + translationStart,
        )
        const segmentIds = fragments?.flatMap(fragment => fragment.segmentId ? [fragment.segmentId] : [])
          ?? (pair.translationUnits.length ? [] : part.translationSegmentIds)
        const playbackStatus = rowPlaybackStatus(playback, segmentIds)
        return [{
          id: part.id,
          source: part.source,
          translation: part.translation,
          mergeKey: hasShowcaseContent(part.source) || part.id === pair.id || part.id === `${pair.id}:semantic-live`
            ? `${pair.id}:source:${part.sourceOffset}` : part.id,
          forceCommit: terminal || pair.committed,
          ...(part.atomicLiveRow ? { atomicLiveRow: true } : {}),
          translationPlaybackFragments: fragments,
          startMs: childStartMs(pair, part.sourceOffset),
          playing: Boolean(
            playingTranslationSegmentId
            && segmentIds.some((segmentId) => (
              isPlayingTranslationSegment(playingTranslationSegmentId, segmentId)
            )),
          ),
          ...(playbackStatus ? { playbackStatus } : {}),
          displayOrder: displayOrder++,
        }]
      })
    })
    return mergeUnmatchedShowcaseRows(rows, rowMergeState)
  }

  const sources = [...sourceSegments].sort((left, right) => left.startMs - right.startMs)
  const sourceAggregate = sources.reduce(
    (value, segment) => joinTranscriptFragment(value, normalized(segment.text)),
    '',
  )
  const translationAggregate = translationDisplayUnits.reduce((value, unit) => {
    const text = normalized(unit.text)
    return text ? value + translationUnitSeparator(value, text) + text : value
  }, '')
  const liveSource = normalized(sourceText) || sourceAggregate
  const liveTranslation = normalized(modelOutputTranslation) || normalized(translation) || translationAggregate
  if (!liveSource || !liveTranslation) return []
  const matchingDisplayUnit = translationDisplayUnits.find((unit) => (
    isPlayingTranslationSegment(playingTranslationSegmentId, unit.id)
    || unit.memberIds?.some((segmentId) => isPlayingTranslationSegment(playingTranslationSegmentId, segmentId))
  ))
  const playbackStatus = rowPlaybackStatus(
    playback,
    translationDisplayUnits.flatMap((unit) => [unit.id, ...(unit.memberIds || [])]),
  )
  return [{
    id: 'live',
    source: liveSource,
    translation: liveTranslation,
    startMs: sources[0]?.startMs || 0,
    playing: Boolean(playingTranslationSegmentId && matchingDisplayUnit),
    ...(playbackStatus ? { playbackStatus } : {}),
  }]
}
