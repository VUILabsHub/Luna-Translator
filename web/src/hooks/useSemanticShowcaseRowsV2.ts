import { consumerFetch as apiFetch } from '@simultrans/ui-shared/src/lib/consumerSession'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  buildShowcaseRows,
  commitPlayedShowcaseRows,
  orderedShowcasePairs,
  refreshShowcasePlaybackRows,
  semanticAlignmentRequestForPair,
  type SemanticAlignmentPair,
  type ShowcaseRowsInput,
  type ShowcaseRowMergeState,
  type ShowcaseSemanticAlignment,
} from '@simultrans/ui-shared/src/lib/showcaseRows'
import type { VadTranscriptPair } from '@simultrans/ui-shared/src/lib/vadTranscriptPairs'
import { numericBoundaryUnsafe } from '@simultrans/ui-shared/src/lib/numericBoundary'

type Input = Omit<ShowcaseRowsInput, 'semanticAlignments'> & {
  terminal: boolean
  atomicFrameCommits?: boolean
}

type ServiceTarget = {
  text?: string
  complete?: boolean
}

type AlignmentResponse = {
  pairs: Array<SemanticAlignmentPair & { attachToPrevious?: boolean }>
  targets?: ServiceTarget[]
  targetEnds?: number[]
  liveSource?: string
}

type AlignmentPayload = {
  source: string
  targets: Array<{
    text: string
    emittedAtMs: number
    sourceAudioMs: number
    soft: boolean
  }>
  translation: string
  targetOffset: number
  translationEmittedAtMs: number
  sourceAudioMs: number
  final: boolean
}

export type SemanticAlignmentRequestV2 = {
  pairId: string
  key: string
  payload: AlignmentPayload
  stableSource: string
  confirmedSourceEnd: number
  stableTranslation: string
  fullTranslation: string
  pendingTranslation: string
  sourceFinal: boolean
  final: boolean
}

export type FrozenSemanticAlignmentStateV2 = {
  pairs: SemanticAlignmentPair[]
  sourceEnd: number
  targetEnd: number
  translationEnd: number
  sourcePrefix: string
  translationPrefix: string
}

export type SemanticAlignmentCandidateV2 = SemanticAlignmentPair & {
  attachToPrevious?: boolean
  translationEnd: number
  targetComplete: boolean
  readySinceMs?: number
}

type CacheEntry = {
  key: string
  request: SemanticAlignmentRequestV2
  response: AlignmentResponse
  frozen: FrozenSemanticAlignmentStateV2
}

type DeferredCommit = {
  current: FrozenSemanticAlignmentStateV2
  nextFrozen: FrozenSemanticAlignmentStateV2
}

type Attempt = {
  key: string
  failures: number
  retryAt: number
  permanent: boolean
}

type InFlight = {
  key: string
  controller: AbortController
}

type AlignmentTransitionMode = 'normal' | 'suspended' | 'rebase'

const emptyFrozenSemanticAlignment = (): FrozenSemanticAlignmentStateV2 => ({
  pairs: [],
  sourceEnd: 0,
  targetEnd: 0,
  translationEnd: 0,
  sourcePrefix: '',
  translationPrefix: '',
})

const unicodeSlice = (value: string, start: number, end?: number) => (
  [...value].slice(start, end).join('')
)

function joinText(current: string, next: string) {
  if (!current) return next
  if (!next) return current
  if (/\s$/u.test(current) || /^[,.;:!?，。；：！？]/u.test(next)) return current + next
  return `${current} ${next}`
}

const presentationCharacter = /[\s"'“”‘’.,!?，、。！？;；:：()[\]{}【】（）]/u
const hasSemanticContent = (text: string) => /[\p{L}\p{N}]/u.test(text)
const minimumProvisionalSourceLookahead = 4
const minimumProvisionalClauseLookahead = 12
const minimumFrozenSemanticConfidence = 0.65
const targetPresentationWaitMs = 1000

export function semanticVadSettleAt(committed: boolean, lastTextAt: number) {
  return committed ? lastTextAt + 1000 : Number.POSITIVE_INFINITY
}

function normalizedTextMap(value: string) {
  const characters: string[] = []
  const ends: number[] = []
  let offset = 0
  for (const character of value) {
    offset += 1
    if (presentationCharacter.test(character)) continue
    for (const normalized of character.toLocaleLowerCase()) {
      characters.push(normalized)
      ends.push(offset)
    }
  }
  return { key: characters.join(''), ends }
}

export function semanticPrefixEndV2(current: string, frozenPrefix: string) {
  const currentMap = normalizedTextMap(current)
  const frozenMap = normalizedTextMap(frozenPrefix)
  if (!currentMap.key.startsWith(frozenMap.key)) return null
  if (!frozenMap.key) return 0
  let end = currentMap.ends[frozenMap.key.length - 1]
  if (presentationCharacter.test([...frozenPrefix].at(-1) || '')) {
    const characters = [...current]
    while (end < characters.length && presentationCharacter.test(characters[end])) end += 1
  }
  return end
}

export function translationPreviewSuffixV2(
  preview: string,
  stable: string,
  frozenEnd: number,
) {
  const stablePrefix = unicodeSlice(stable, 0, frozenEnd)
  const stableSuffix = unicodeSlice(stable, frozenEnd).trim()
  if (!stablePrefix) return preview.trim()
  const previewMap = normalizedTextMap(preview)
  const stableKey = normalizedTextMap(stablePrefix).key
  if (!stableKey || !previewMap.key.startsWith(stableKey)) return stableSuffix
  let previewEnd = previewMap.ends[stableKey.length - 1]
  const previewCharacters = [...preview]
  const trailingPresentation = presentationCharacter.test([...stablePrefix].at(-1) || '')
  while (
    previewEnd < previewCharacters.length
    && (trailingPresentation
      ? presentationCharacter.test(previewCharacters[previewEnd])
      : /\s/u.test(previewCharacters[previewEnd]))
  ) previewEnd += 1
  return previewCharacters.slice(previewEnd).join('').trim()
}

function semanticRequestForPairV2(
  pair: VadTranscriptPair,
  final: boolean,
  frozen: FrozenSemanticAlignmentStateV2,
): SemanticAlignmentRequestV2 {
  const base = semanticAlignmentRequestForPair(pair, final)
  const sourceAudioMs = pair.sourceVadStartMs ?? pair.startMs
  const translationEmittedAtMs = pair.endMs ?? pair.startMs
  const targets = base.payload.targets.slice(frozen.targetEnd)
  const payload: AlignmentPayload = {
    source: unicodeSlice(base.stableSource, frozen.sourceEnd),
    targets,
    translation: unicodeSlice(base.stableTranslation, frozen.translationEnd),
    targetOffset: 0,
    translationEmittedAtMs,
    sourceAudioMs,
    final,
  }
  return {
    pairId: pair.id,
    key: JSON.stringify({ ...payload, sourceFinal: pair.sourceFinal }),
    payload,
    stableSource: base.stableSource,
    confirmedSourceEnd: base.confirmedSourceEnd,
    stableTranslation: base.stableTranslation,
    fullTranslation: pair.translation.trim(),
    pendingTranslation: base.pendingTranslation,
    sourceFinal: pair.sourceFinal,
    final,
  }
}

function normalizedResponse(
  request: SemanticAlignmentRequestV2,
  response: AlignmentResponse,
): AlignmentResponse {
  if (response.targets?.length && response.targetEnds?.length) return response
  let end = 0
  return {
    ...response,
    targets: request.payload.targets.map(({ text }) => ({ text, complete: true })),
    targetEnds: request.payload.targets.map(({ text }) => {
      end += [...text].length
      return end
    }),
  }
}

export function remapFrozenSemanticAlignmentV2(
  request: SemanticAlignmentRequestV2,
  frozen: FrozenSemanticAlignmentStateV2,
) {
  // Frozen rows have already been presented to the user. A provisional ASR
  // rewrite must not remove them; keep their prior offsets until the frozen
  // prefix can be located in a later snapshot again.
  const sourceEnd = semanticPrefixEndV2(request.stableSource, frozen.sourcePrefix)
    ?? frozen.sourceEnd
  let translationEnd = semanticPrefixEndV2(request.stableTranslation, frozen.translationPrefix)
    ?? frozen.translationEnd
  const translationCompatible = semanticPrefixEndV2(request.stableTranslation, frozen.translationPrefix) !== null
  const translationCharacters = [...request.stableTranslation]
  // Real punctuation may arrive after a hint has already frozen this row.
  // Refresh presentation only: keep row IDs, word boundaries and audio IDs.
  const includeTrailingPunctuation = (end: number) => {
    while (end < translationCharacters.length && /[\s.,!?;:。！？；：，、،؛؟…]/u.test(translationCharacters[end])) {
      if (numericBoundaryUnsafe(request.stableTranslation, translationCharacters.slice(0, end + 1).join('').length, request.final)) break
      end += 1
    }
    return end
  }
  if (translationCompatible && frozen.translationPrefix) translationEnd = includeTrailingPunctuation(translationEnd)
  const translationPrefix = translationCompatible
    ? unicodeSlice(request.stableTranslation, 0, translationEnd).trimEnd()
    : frozen.translationPrefix
  const compatible = semanticPrefixEndV2(request.stableSource, frozen.sourcePrefix) !== null
  const sourcePrefix = compatible ? unicodeSlice(request.stableSource, 0, sourceEnd) : frozen.sourcePrefix
  if (sourceEnd === frozen.sourceEnd && translationEnd === frozen.translationEnd && sourcePrefix === frozen.sourcePrefix && translationPrefix === frozen.translationPrefix) return frozen
  let prefix = ''
  let start = 0
  let pairs = compatible ? frozen.pairs.map((pair) => {
    prefix += pair.source
    const end = semanticPrefixEndV2(request.stableSource, prefix)
    if (end === null) return pair
    const source = unicodeSlice(request.stableSource, start, end)
    const next = { ...pair, source, sourceStart: start, sourceEnd: end }
    start = end
    return next
  }) : frozen.pairs
  if (translationCompatible) {
    let prefix = ''
    let start = 0
    pairs = pairs.map(pair => {
      if (!pair.translation) return pair
      prefix += pair.translation
      const matchedEnd = semanticPrefixEndV2(request.stableTranslation, prefix)
      if (matchedEnd === null) return pair
      const end = includeTrailingPunctuation(matchedEnd)
      const translation = unicodeSlice(request.stableTranslation, start, end).trim()
      start = end
      if (translation === pair.translation) return pair
      return { ...pair, translation, translationEnd: end }
    })
  }
  return { ...frozen, sourceEnd, translationEnd, sourcePrefix, translationPrefix, pairs }
}

export function semanticAlignmentTransitionV2(
  request: SemanticAlignmentRequestV2,
  frozen: FrozenSemanticAlignmentStateV2,
  sourceFinal: boolean,
  terminal: boolean,
): { mode: AlignmentTransitionMode; frozen: FrozenSemanticAlignmentStateV2 } {
  const translationCompatible = semanticPrefixEndV2(request.stableTranslation, frozen.translationPrefix) !== null
  const compatible = semanticPrefixEndV2(request.stableSource, frozen.sourcePrefix) !== null && translationCompatible
  if (compatible) {
    return { mode: 'normal', frozen: remapFrozenSemanticAlignmentV2(request, frozen) }
  }
  // ASR can revise a spoken prefix before VAD ends. Recompute its alignment
  // immediately; the playback commit layer keeps promoted rows stable.
  if (translationCompatible || sourceFinal || terminal) return { mode: 'rebase', frozen: emptyFrozenSemanticAlignment() }
  return { mode: 'suspended', frozen }
}

export function semanticPresentationFrozenV2(
  request: SemanticAlignmentRequestV2,
  current: FrozenSemanticAlignmentStateV2,
  previous: FrozenSemanticAlignmentStateV2 | undefined,
) {
  if (!previous
    || previous.pairs.some((part) => part.kind === 'match'
      && (!hasSemanticContent(part.source) || !hasSemanticContent(part.translation)))
    || semanticPrefixEndV2(request.stableSource, previous.sourcePrefix) === null
    || semanticPrefixEndV2(request.stableTranslation, previous.translationPrefix) === null
    || (semanticPrefixEndV2(current.sourcePrefix, previous.sourcePrefix) !== null
      && semanticPrefixEndV2(current.translationPrefix, previous.translationPrefix) !== null)) return current
  // Reopening a VAD tail is computation, not a request to retract displayed
  // rows. Keep compatible rows until their replacement covers both texts.
  return remapFrozenSemanticAlignmentV2(request, previous)
}

export function semanticTranslationExtensionV2(
  current: FrozenSemanticAlignmentStateV2,
  previous: FrozenSemanticAlignmentStateV2 | undefined,
) {
  return Boolean(previous?.pairs.length
    && current.pairs.length === previous.pairs.length
    && current.pairs.every((part, index) => (
      normalizedTextMap(part.source).key === normalizedTextMap(previous.pairs[index].source).key
      && semanticPrefixEndV2(part.translation, previous.pairs[index].translation) !== null
    )))
}

export function semanticPendingRowsV2(
  current: ReturnType<typeof buildShowcaseRows>,
  previous: ReturnType<typeof buildShowcaseRows>,
  pending: boolean,
) {
  if (!pending || current.length >= previous.length) return current
  const source = normalizedTextMap(current.map((row) => row.source).join('')).key
  const translation = normalizedTextMap(current.map((row) => row.translation).join('')).key
  return source === normalizedTextMap(previous.map((row) => row.source).join('')).key
    && translation === normalizedTextMap(previous.map((row) => row.translation).join('')).key ? previous : current
}

export function semanticAlignmentCandidatesV2(
  request: Pick<SemanticAlignmentRequestV2, 'pairId' | 'final'>,
  response: AlignmentResponse,
  frozen: FrozenSemanticAlignmentStateV2,
) {
  const candidates: SemanticAlignmentCandidateV2[] = []
  let sourceEnd = frozen.sourceEnd
  let targetEnd = frozen.targetEnd
  let pendingSource = ''
  let pendingSourceStart = sourceEnd
  const sourceText = response.pairs.map(part => part.source).join('') + (response.liveSource || '')
  const targetText = response.targets?.map(part => part.text || '').join('') || response.pairs.map(part => part.translation).join('')

  const translationEndAt = (absoluteTargetEnd: number) => {
    if (absoluteTargetEnd <= frozen.targetEnd) return frozen.translationEnd
    const relativeTranslationEnd = response.targetEnds?.[absoluteTargetEnd - frozen.targetEnd - 1]
    return Number.isFinite(relativeTranslationEnd)
      ? frozen.translationEnd + (relativeTranslationEnd as number)
      : null
  }

  const pushPendingSource = () => {
    if (!pendingSource) return true
    const translationEnd = translationEndAt(targetEnd)
    if (!Number.isFinite(translationEnd)) return false
    candidates.push({
      id: `${request.pairId}:unmatched-source:${pendingSourceStart}:${sourceEnd}`,
      source: pendingSource,
      translation: '',
      sourceStart: pendingSourceStart,
      sourceEnd,
      targetStart: targetEnd,
      targetEnd,
      translationEnd: translationEnd as number,
      targetComplete: true,
      emittedAtMs: 0,
      sourceAudioMs: 0,
      confidence: 0,
      similarity: null,
      status: 'unmatched',
      kind: 'source_only',
    })
    pendingSource = ''
    pendingSourceStart = sourceEnd
    return true
  }

  for (const part of response.pairs) {
    // Never freeze a numeric interior, even if an older service marks it complete.
    if ((part.sourceEnd !== null && numericBoundaryUnsafe(sourceText, unicodeSlice(sourceText, 0, part.sourceEnd).length, request.final))
      || numericBoundaryUnsafe(targetText, unicodeSlice(targetText, 0, response.targetEnds?.[part.targetEnd - 1] ?? 0).length, request.final)) break
    const sourceStart = part.sourceStart === null ? sourceEnd : frozen.sourceEnd + part.sourceStart
    const nextSourceEnd = part.sourceEnd === null ? sourceEnd : frozen.sourceEnd + part.sourceEnd
    const targetStart = frozen.targetEnd + part.targetStart
    const nextTargetEnd = frozen.targetEnd + part.targetEnd
    if (
      part.kind === 'target_only'
      && sourceStart === sourceEnd
      && nextSourceEnd === sourceEnd
      && targetStart === targetEnd
      && nextTargetEnd > targetEnd
    ) {
      if (!pushPendingSource()) break
      const translationEnd = translationEndAt(nextTargetEnd)
      if (!Number.isFinite(translationEnd)) break
      candidates.push({
        ...part,
        id: `${request.pairId}:unmatched-target:${targetStart}:${nextTargetEnd}`,
        source: '',
        sourceStart: sourceEnd,
        sourceEnd,
        targetStart,
        targetEnd: nextTargetEnd,
        translationEnd: translationEnd as number,
        targetComplete: response.targets?.[part.targetEnd - 1]?.complete === true,
        confidence: 0,
        status: 'unmatched',
      })
      targetEnd = nextTargetEnd
      continue
    }
    if (
      part.kind === 'source_only'
      && sourceStart === sourceEnd
      && nextSourceEnd > sourceEnd
      && targetStart === targetEnd
      && nextTargetEnd === targetEnd
    ) {
      if (!pendingSource) pendingSourceStart = sourceEnd
      pendingSource += part.source
      sourceEnd = nextSourceEnd
      continue
    }
    if (
      part.kind !== 'match'
      || sourceStart !== sourceEnd
      || nextSourceEnd <= sourceEnd
      || targetStart !== targetEnd
      || nextTargetEnd <= targetEnd
    ) break
    const translationEnd = translationEndAt(nextTargetEnd)
    if (!Number.isFinite(translationEnd)) break
    const sourceStartWithResidual = pendingSource ? pendingSourceStart : sourceStart
    candidates.push({
      ...part,
      id: `${request.pairId}:semantic:${sourceStartWithResidual}`,
      source: pendingSource + part.source,
      sourceStart: sourceStartWithResidual,
      sourceEnd: nextSourceEnd,
      targetStart,
      targetEnd: nextTargetEnd,
      translationEnd: translationEnd as number,
      targetComplete: response.targets?.[part.targetEnd - 1]?.complete === true,
      confidence: pendingSource ? 0 : part.confidence,
      status: pendingSource ? 'approximate' : 'frozen',
    })
    pendingSource = ''
    sourceEnd = nextSourceEnd
    pendingSourceStart = sourceEnd
    targetEnd = nextTargetEnd
  }
  if (request.final) pushPendingSource()
  return candidates
}

export function semanticFreezeGroupsV2(
  candidates: SemanticAlignmentCandidateV2[],
  {
    final = false,
    confirmedSourceEnd = 0,
    stableSourceLength = 0,
    allowTrailingTargetOnly = false,
    liveText,
  }: {
    final?: boolean
    confirmedSourceEnd?: number
    stableSourceLength?: number
    allowTrailingTargetOnly?: boolean
    liveText?: Pick<SemanticAlignmentRequestV2, 'stableSource' | 'stableTranslation' | 'fullTranslation'>
  } = {},
) {
  const groups: SemanticAlignmentCandidateV2[] = []
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.kind === 'match'
      && (!hasSemanticContent(candidate.source) || !hasSemanticContent(candidate.translation))) break
    const joinsPriorMatch = candidate.kind === 'target_only'
      && (allowTrailingTargetOnly || candidate.attachToPrevious === true)
      && groups.at(-1)?.kind === 'match'
    if (candidate.kind === 'target_only' && !final) {
      const laterReadyMatch = candidates.slice(index + 1).some((next) => (
        next.kind === 'match'
        && next.targetComplete
        && (
          (next.sourceEnd ?? 0) <= confirmedSourceEnd
          || (next.sourceEnd ?? 0) + minimumProvisionalSourceLookahead <= stableSourceLength
        )
      ))
      if (!laterReadyMatch && !joinsPriorMatch) break
    }
    const candidateSourceEnd = candidate.sourceEnd ?? 0
    const sourceBoundaryReady = candidateSourceEnd <= confirmedSourceEnd
      || candidateSourceEnd + minimumProvisionalSourceLookahead <= stableSourceLength
    if ((!candidate.targetComplete && !final) || (!sourceBoundaryReady && !joinsPriorMatch && !final)) break
    const approximate = !candidate.targetComplete
      || (candidate.confidence ?? 0) < minimumFrozenSemanticConfidence
    groups.push(candidate.status === 'unmatched'
      ? candidate
      : approximate ? { ...candidate, status: 'approximate' } : candidate)
  }
  // Clause punctuation needs more context than a sentence boundary: ASR
  // can still remove a comma while finishing the same phrase. Never split
  // an unconfirmed enumeration solely at its punctuation.
  while (!final && groups.length) {
    if (liveText) {
      while (groups.at(-1)?.kind === 'target_only' && !groups.at(-1)?.attachToPrevious) groups.pop()
    }
    const lastMatch = groups.map((group) => group.kind).lastIndexOf('match')
    if (lastMatch < 0) { groups.length = 0; break }
    const last = groups[lastMatch]
    const end = groups.at(-1)!
    // Leave actual text on both sides of the live tail, not necessarily a
    // completed match. A known continuation must still stay with its source.
    if (liveText && (
      !hasSemanticContent(unicodeSlice(liveText.stableSource, last.sourceEnd ?? 0))
      || !hasSemanticContent(translationPreviewSuffixV2(liveText.fullTranslation, liveText.stableTranslation, end.translationEnd))
      || candidates.some(candidate => candidate.targetStart === end.targetEnd
        && candidate.kind === 'target_only' && candidate.attachToPrevious)
    )) {
      groups.splice(lastMatch)
      continue
    }
    if (
      (last.sourceEnd ?? 0) <= confirmedSourceEnd
      || /[。！？.!?]["”’')\]】》」』]*$/u.test(last.source)
      || (
        /[，,；;]["”’')\]】》」』]*$/u.test(last.source)
        && (last.sourceEnd ?? 0) + minimumProvisionalClauseLookahead <= stableSourceLength
        && (last.confidence ?? 0) >= minimumFrozenSemanticConfidence
      )
    ) break
    groups.splice(lastMatch)
  }
  return groups
}

export function semanticBatchReadyV2(
  request: Pick<SemanticAlignmentRequestV2, 'final' | 'sourceFinal' | 'pendingTranslation' | 'stableTranslation'>,
  response: Pick<AlignmentResponse, 'targets'>,
  groups: Array<{ translationEnd: number }>,
) {
  if (request.final || request.sourceFinal) return true
  // Completed, source-confirmed prefixes may be committed while a later
  // translation is streaming; requiring the whole stream to stop starves them.
  return groups.length > 0 && Boolean(response.targets?.some((target) => target.complete))
}

export function semanticFrameCommitDelayV2(
  lastCommitAt: number | undefined,
  now: number,
  priority = false,
  intervalMs = 2000,
) {
  if (priority || !Number.isFinite(lastCommitAt)) return 0
  return Math.max(0, (lastCommitAt as number) + intervalMs - now)
}

export function mergeSemanticDisplayBatchV2(groups: SemanticAlignmentCandidateV2[]) {
  const batches: SemanticAlignmentCandidateV2[][] = []
  let batch: SemanticAlignmentCandidateV2[] = []
  for (const group of groups) {
    const sourceLength = [...batch.map(part => part.source).join('') + group.source].length
    const translationLength = [...batch.map(part => part.translation).join(' ') + ' ' + group.translation].length
    const targetCount = group.targetEnd - (batch[0]?.targetStart ?? group.targetStart)
    // Split only between bilingual matches. A continuation without its own
    // source must remain attached, even when one indivisible pair is long.
    if (batch.length && group.kind === 'match' && batch.some(part => part.kind === 'match')
      && (sourceLength > 60 || translationLength > 320 || targetCount > 3)) {
      batches.push(batch)
      batch = []
    }
    batch.push(group)
  }
  if (batch.length) batches.push(batch)
  return batches.map(parts => {
    if (parts.length === 1) return parts[0]
    const first = parts[0]
    const last = parts.at(-1) as SemanticAlignmentCandidateV2
    const status = parts.some(group => group.status === 'unmatched')
      ? 'unmatched'
      : parts.some(group => group.status === 'approximate') ? 'approximate' : 'frozen'
    return {
      ...first,
      source: parts.map(group => group.source).join(''),
      translation: parts.reduce((text, group) => joinText(text, group.translation), ''),
      sourceEnd: last.sourceEnd,
      targetEnd: last.targetEnd,
      translationEnd: last.translationEnd,
      targetComplete: parts.every(group => group.targetComplete),
      confidence: Math.min(...parts.map(group => group.confidence ?? 0)),
      status,
    } satisfies SemanticAlignmentCandidateV2
  })
}

export function semanticTargetPresentationReadyV2(
  candidates: SemanticAlignmentCandidateV2[],
  index: number,
  nowMs = Date.now(),
) {
  const candidate = candidates[index]
  if (candidate?.kind !== 'target_only' || !candidate.targetComplete) return false
  const waitExpired = Number.isFinite(candidate.readySinceMs)
    && nowMs - (candidate.readySinceMs as number) >= targetPresentationWaitMs
  const laterCompleteTarget = candidates.slice(index + 1).some((next) => next.targetComplete)
  return waitExpired || laterCompleteTarget
}

function readinessKey(candidate: SemanticAlignmentCandidateV2) {
  return `${candidate.targetStart}:${candidate.targetEnd}:${candidate.translationEnd}`
}

function candidatesWithReadiness(
  request: SemanticAlignmentRequestV2,
  response: AlignmentResponse,
  frozen: FrozenSemanticAlignmentStateV2,
  readiness: Record<string, number>,
  nowMs: number,
) {
  const candidates = semanticAlignmentCandidatesV2(request, response, frozen)
  for (const candidate of candidates) {
    if (!candidate.targetComplete) continue
    const key = readinessKey(candidate)
    if (!Number.isFinite(readiness[key])) readiness[key] = nowMs
    candidate.readySinceMs = readiness[key]
  }
  return candidates
}

function freezeSemanticPrefix(
  request: SemanticAlignmentRequestV2,
  response: AlignmentResponse,
  frozen: FrozenSemanticAlignmentStateV2,
  readiness: Record<string, number>,
  nowMs: number,
  atomicFrameCommits: boolean,
  preserveBoundaries: boolean,
) {
  const candidates = candidatesWithReadiness(request, response, frozen, readiness, nowMs)
  const completeBatch = !request.pendingTranslation
    && (response.targets?.length || 0) >= 2
    && response.targets?.every((target) => target.complete)
  const ready = semanticFreezeGroupsV2(candidates, {
    final: request.final,
    confirmedSourceEnd: request.confirmedSourceEnd,
    stableSourceLength: [...request.stableSource].length,
    allowTrailingTargetOnly: atomicFrameCommits && completeBatch,
    liveText: atomicFrameCommits ? request : undefined,
  })
  const added = atomicFrameCommits
    ? semanticBatchReadyV2(request, response, ready)
      ? preserveBoundaries ? ready : mergeSemanticDisplayBatchV2(ready)
      : []
    : ready
  if (added.length === 0) return frozen
  const last = added.at(-1) as SemanticAlignmentCandidateV2
  return {
    pairs: [...frozen.pairs, ...added],
    sourceEnd: last.sourceEnd ?? frozen.sourceEnd,
    targetEnd: last.targetEnd,
    translationEnd: last.translationEnd,
    sourcePrefix: unicodeSlice(request.stableSource, 0, last.sourceEnd ?? frozen.sourceEnd),
    translationPrefix: unicodeSlice(request.stableTranslation, 0, last.translationEnd),
  }
}

export function semanticPreviewRowsV2(
  request: SemanticAlignmentRequestV2,
  response: AlignmentResponse,
  frozen: FrozenSemanticAlignmentStateV2,
  nextFrozen: FrozenSemanticAlignmentStateV2,
  readiness: Record<string, number>,
  nowMs: number,
  atomicFrameCommits = false,
) {
  const candidates = candidatesWithReadiness(request, response, frozen, readiness, nowMs)
  let previewTargetLimit = Infinity
  if (atomicFrameCommits) {
    const completeBatch = !request.pendingTranslation
      && (response.targets?.length || 0) >= 2
      && response.targets?.every((target) => target.complete)
    const ready = semanticFreezeGroupsV2(candidates, {
      final: request.final,
      confirmedSourceEnd: request.confirmedSourceEnd,
      stableSourceLength: [...request.stableSource].length,
      allowTrailingTargetOnly: completeBatch,
      liveText: request,
    })
    if (!semanticBatchReadyV2(request, response, ready)) return []
    previewTargetLimit = ready.at(-1)?.targetEnd ?? nextFrozen.targetEnd
  }
  const previews: SemanticAlignmentCandidateV2[] = []
  let previewTargetEnd = nextFrozen.targetEnd
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.targetEnd <= nextFrozen.targetEnd) continue
    if (candidate.targetEnd > previewTargetLimit) break
    if (candidate.targetStart !== previewTargetEnd || !candidate.targetComplete) break
    const matched = candidate.kind === 'match'
    if (!matched && !semanticTargetPresentationReadyV2(candidates, index, nowMs)) break
    previews.push({
      ...candidate,
      id: `${request.pairId}:pending-target:${candidate.targetStart}:${candidate.targetEnd}`,
      status: 'tentative',
    })
    previewTargetEnd = candidate.targetEnd
  }
  return previews
}

function semanticAlignmentFromState(
  pair: VadTranscriptPair,
  request: SemanticAlignmentRequestV2,
  frozen: FrozenSemanticAlignmentStateV2,
  previews: SemanticAlignmentCandidateV2[],
  atomicLiveRow = false,
): ShowcaseSemanticAlignment {
  const visibleSourceEnd = previews.at(-1)?.sourceEnd ?? frozen.sourceEnd
  const visibleTranslationEnd = previews.at(-1)?.translationEnd ?? frozen.translationEnd
  const liveSource = unicodeSlice(pair.source, visibleSourceEnd).trim()
  const liveTranslation = translationPreviewSuffixV2(
    request.fullTranslation,
    request.stableTranslation,
    visibleTranslationEnd,
  )
  const pairs = [...frozen.pairs, ...previews]
  if (request.final && liveSource && !liveTranslation) {
    pairs.push({
      id: `${pair.id}:terminal-unmatched-source`,
      source: liveSource,
      translation: '',
      sourceStart: visibleSourceEnd,
      sourceEnd: [...pair.source].length,
      targetStart: frozen.targetEnd,
      targetEnd: frozen.targetEnd,
      emittedAtMs: pair.endMs ?? pair.startMs,
      sourceAudioMs: pair.sourceVadStartMs ?? pair.startMs,
      status: 'unmatched',
      kind: 'source_only',
      similarity: null,
      confidence: 0,
    })
  }
  return {
    key: JSON.stringify({
      sourceEnd: visibleSourceEnd,
      translationEnd: visibleTranslationEnd,
      liveSource: request.final && !liveTranslation ? '' : liveSource,
      liveTranslation,
    }),
    pairs,
    liveSource: request.final && !liveTranslation ? '' : liveSource,
    liveTranslation,
    pendingTranslation: '',
    atomicLiveRow,
  }
}

class AlignmentHTTPError extends Error {
  status: number
  retryAfterMs: number

  constructor(status: number, retryAfterMs: number) {
    super(`semantic alignment returned ${status}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const alignmentTimeoutMs = 2000
const alignmentDebounceMs = 120
const maxConcurrentAlignmentRequests = 2
const maxRetryDelayMs = 5000
const configurationRetryDelayMs = 15000
const maxRetryAfterMs = 30000

export function semanticAlignmentStatusIsRetryable(status?: number) {
  if (status === undefined) return true
  return status === 401
    || status === 403
    || status === 404
    || status === 408
    || status === 409
    || status === 425
    || status === 429
    || status >= 500
}

export function semanticAlignmentRetryDelayMs(
  failures: number,
  status?: number,
  retryAfterMs = 0,
) {
  if (retryAfterMs > 0) return Math.min(maxRetryAfterMs, Math.max(250, retryAfterMs))
  if (status === 401 || status === 403 || status === 404) return configurationRetryDelayMs
  return Math.min(maxRetryDelayMs, 500 * (2 ** Math.max(0, failures - 1)))
}

function responseRetryAfterMs(response: Response) {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

function jitter(delayMs: number) {
  return Math.round(delayMs * (0.85 + Math.random() * 0.3))
}

export function useSemanticShowcaseRowsV2({ terminal, atomicFrameCommits = false, ...input }: Input) {
  const cacheRef = useRef<Record<string, CacheEntry>>({})
  const frozenRef = useRef<Record<string, FrozenSemanticAlignmentStateV2>>({})
  const previewRef = useRef<Record<string, SemanticAlignmentCandidateV2[]>>({})
  const readinessRef = useRef<Record<string, Record<string, number>>>({})
  const attemptsRef = useRef<Record<string, Attempt>>({})
  const inFlightRef = useRef<Record<string, InFlight>>({})
  const presentationRef = useRef<Record<string, ShowcaseSemanticAlignment>>({})
  const rowMergeStateRef = useRef<ShowcaseRowMergeState>({ owners: new Map<string, string>(), ids: new Map<string, string>() })
  const displayedRowsRef = useRef<ReturnType<typeof buildShowcaseRows>>([])
  const presentedFrozenRef = useRef<Record<string, FrozenSemanticAlignmentStateV2>>({})
  const lastFrameCommitAtRef = useRef<Record<string, number>>({})
  const deferredCommitRef = useRef<Record<string, DeferredCommit>>({})
  const serviceFailureRef = useRef({ failures: 0, retryAt: 0 })
  const mountedRef = useRef(true)
  const vadSettledBaseRef = useRef<Record<string, FrozenSemanticAlignmentStateV2>>({})
  const vadActivityRef = useRef<Record<string, { key: string; at: number }>>({})
  const rebasedPairIdsRef = useRef(new Set<string>())
  const [revision, setRevision] = useState(0)
  const work = useMemo(() => orderedShowcasePairs(input.vadTranscriptPairs).map((pair) => {
    const activityKey = JSON.stringify([pair.source, pair.translation, pair.committed, pair.sourceFinal])
    if (vadActivityRef.current[pair.id]?.key !== activityKey) {
      // VAD silence does not mean the translator has finished. A late target
      // may still complete the settled tail; reopen only that tail's base.
      if (!terminal && vadSettledBaseRef.current[pair.id]) {
        frozenRef.current[pair.id] = vadSettledBaseRef.current[pair.id]
        delete vadSettledBaseRef.current[pair.id]
        delete deferredCommitRef.current[pair.id]
        previewRef.current[pair.id] = []
      }
      vadActivityRef.current[pair.id] = { key: activityKey, at: Date.now() }
    }
    const settleAt = semanticVadSettleAt(pair.committed, vadActivityRef.current[pair.id].at)
    const settled = Date.now() >= settleAt
    // Settle the editable tail after silence. Keep confirmed prefixes intact:
    // reopening a long VAD can shift earlier matches and visibly reflow history.
    const initial = vadSettledBaseRef.current[pair.id] || frozenRef.current[pair.id] || emptyFrozenSemanticAlignment()
    if (settled) vadSettledBaseRef.current[pair.id] = initial
    const initialRequest = semanticRequestForPairV2(pair, terminal || settled, initial)
    const transition = semanticAlignmentTransitionV2(
      initialRequest,
      initial,
      pair.sourceFinal,
      terminal,
    )
    const frozen = transition.frozen
    if (transition.mode !== 'suspended' && frozen !== initial) {
      frozenRef.current[pair.id] = frozen
      previewRef.current[pair.id] = []
      delete cacheRef.current[pair.id]
      readinessRef.current[pair.id] = {}
      if (transition.mode === 'rebase') {
        // Retain matched boundaries after a revision so the playback layer can
        // repair individual history rows before batching newly promoted text.
        rebasedPairIdsRef.current.add(pair.id)
        delete deferredCommitRef.current[pair.id]
        delete vadSettledBaseRef.current[pair.id]
      }
    }
    const request = semanticRequestForPairV2(
      pair,
      terminal || settled || (transition.mode === 'rebase' && pair.sourceFinal),
      frozen,
    )
    return { pair, frozen, request, mode: transition.mode, settleAt }
  }), [input.vadTranscriptPairs, revision, terminal])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      Object.values(inFlightRef.current).forEach(({ controller }) => controller.abort())
      inFlightRef.current = {}
    }
  }, [])

  useEffect(() => {
    if (input.vadTranscriptPairs.length > 0) return
    Object.values(inFlightRef.current).forEach(({ controller }) => controller.abort())
    cacheRef.current = {}
    frozenRef.current = {}
    previewRef.current = {}
    readinessRef.current = {}
    attemptsRef.current = {}
    inFlightRef.current = {}
    presentationRef.current = {}
    rowMergeStateRef.current = { owners: new Map(), ids: new Map() }
    displayedRowsRef.current = []
    presentedFrozenRef.current = {}
    lastFrameCommitAtRef.current = {}
    deferredCommitRef.current = {}
    serviceFailureRef.current = { failures: 0, retryAt: 0 }
    vadActivityRef.current = {}
    vadSettledBaseRef.current = {}
    rebasedPairIdsRef.current.clear()
  }, [input.vadTranscriptPairs.length])

  useEffect(() => {
    const validKeys = new Map(work.flatMap(({ pair, request, mode }) => (
      mode === 'normal' || mode === 'rebase' ? [[pair.id, request.key]] : []
    )))
    Object.entries(inFlightRef.current).forEach(([pairID, active]) => {
      if (validKeys.get(pairID) === active.key) return
      delete inFlightRef.current[pairID]
      active.controller.abort()
    })

    const now = Date.now()
    let nextWakeAt = serviceFailureRef.current.retryAt > now
      ? serviceFailureRef.current.retryAt
      : Number.POSITIVE_INFINITY
    for (const item of work) {
      if ('settleAt' in item && item.settleAt! > now) nextWakeAt = Math.min(nextWakeAt, item.settleAt!)
    }
    let appliedDeferredCommit = false
    if (atomicFrameCommits) {
      for (const { pair, request } of work) {
        const deferred = deferredCommitRef.current[pair.id]
        if (!deferred) continue
        const current = frozenRef.current[pair.id] || emptyFrozenSemanticAlignment()
        if (
          current.sourceEnd !== deferred.current.sourceEnd
          || current.targetEnd !== deferred.current.targetEnd
          || current.translationEnd !== deferred.current.translationEnd
        ) {
          delete deferredCommitRef.current[pair.id]
          continue
        }
        const delay = semanticFrameCommitDelayV2(
          lastFrameCommitAtRef.current[pair.id],
          now,
          request.final || terminal,
        )
        if (delay > 0) {
          nextWakeAt = Math.min(nextWakeAt, now + delay)
          continue
        }
        const nextFrozen = deferred.nextFrozen
        if (
          unicodeSlice(request.stableSource, 0, nextFrozen.sourceEnd) !== nextFrozen.sourcePrefix
          || unicodeSlice(request.stableTranslation, 0, nextFrozen.translationEnd) !== nextFrozen.translationPrefix
        ) {
          delete deferredCommitRef.current[pair.id]
          continue
        }
        frozenRef.current[pair.id] = nextFrozen
        previewRef.current[pair.id] = []
        delete cacheRef.current[pair.id]
        delete deferredCommitRef.current[pair.id]
        lastFrameCommitAtRef.current[pair.id] = now
        appliedDeferredCommit = true
      }
    }
    if (appliedDeferredCommit) {
      setRevision((value) => value + 1)
      return
    }
    const ready: typeof work = []

    for (const item of work) {
      const { pair, request, mode } = item
      if (mode === 'suspended') continue
      const cached = cacheRef.current[pair.id]
      if (cached?.key === request.key) {
        const readiness = readinessRef.current[pair.id] || {}
        const candidates = candidatesWithReadiness(
          cached.request,
          cached.response,
          cached.frozen,
          readiness,
          now,
        )
        readinessRef.current[pair.id] = readiness
        for (const candidate of candidates) {
          if (candidate.kind !== 'target_only' || !candidate.targetComplete) continue
          const readyAt = (candidate.readySinceMs ?? now) + targetPresentationWaitMs
          if (readyAt > now) nextWakeAt = Math.min(nextWakeAt, readyAt)
        }
        delete attemptsRef.current[pair.id]
        continue
      }
      if (!hasSemanticContent(request.payload.source) || !hasSemanticContent(request.payload.translation)) continue
      if (inFlightRef.current[pair.id]?.key === request.key) continue

      let attempt = attemptsRef.current[pair.id]
      if (!attempt || attempt.key !== request.key) {
        attempt = {
          key: request.key,
          failures: 0,
          retryAt: now + (terminal ? 0 : alignmentDebounceMs),
          permanent: false,
        }
        attemptsRef.current[pair.id] = attempt
      }
      if (attempt.permanent) continue
      const retryAt = Math.max(attempt.retryAt, serviceFailureRef.current.retryAt)
      if (retryAt > now) {
        nextWakeAt = Math.min(nextWakeAt, retryAt)
        continue
      }
      ready.push(item)
    }

    const requestLimit = serviceFailureRef.current.failures > 0 ? 1 : maxConcurrentAlignmentRequests
    const availableSlots = Math.max(0, requestLimit - Object.keys(inFlightRef.current).length)
    ready.slice(0, availableSlots).forEach(({ pair, frozen, request }) => {
      const controller = new AbortController()
      const active = { key: request.key, controller }
      inFlightRef.current[pair.id] = active
      let timedOut = false
      const timeout = window.setTimeout(() => {
        timedOut = true
        controller.abort()
      }, alignmentTimeoutMs)

      void apiFetch('/api/semantic-align/align', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.payload),
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) {
            throw new AlignmentHTTPError(response.status, responseRetryAfterMs(response))
          }
          return response.json() as Promise<AlignmentResponse>
        })
        .then((rawResponse) => {
          if (controller.signal.aborted || inFlightRef.current[pair.id] !== active) return
          const response = normalizedResponse(request, rawResponse)
          const readiness = readinessRef.current[pair.id] || {}
          const nowMs = Date.now()
          const candidateFrozen = freezeSemanticPrefix(
            request,
            response,
            frozen,
            readiness,
            nowMs,
            atomicFrameCommits,
            rebasedPairIdsRef.current.has(pair.id),
          )
          const advances = candidateFrozen.sourceEnd !== frozen.sourceEnd
            || candidateFrozen.targetEnd !== frozen.targetEnd
          let nextFrozen = candidateFrozen
          if (atomicFrameCommits && advances) {
            const commitDelay = semanticFrameCommitDelayV2(
              lastFrameCommitAtRef.current[pair.id],
              nowMs,
              request.final || semanticTranslationExtensionV2(candidateFrozen, presentedFrozenRef.current[pair.id]),
            )
            if (commitDelay > 0) {
              const deferred = deferredCommitRef.current[pair.id]
              if (!deferred || candidateFrozen.translationEnd >= deferred.nextFrozen.translationEnd) {
                deferredCommitRef.current[pair.id] = {
                  current: frozen,
                  nextFrozen: candidateFrozen,
                }
              }
              nextFrozen = frozen
            } else {
              lastFrameCommitAtRef.current[pair.id] = nowMs
              delete deferredCommitRef.current[pair.id]
            }
          }
          frozenRef.current[pair.id] = nextFrozen
          previewRef.current[pair.id] = deferredCommitRef.current[pair.id]
            ? []
            : semanticPreviewRowsV2(
                request,
                response,
                frozen,
                nextFrozen,
                readiness,
                nowMs,
                atomicFrameCommits,
              )
          readinessRef.current[pair.id] = readiness
          cacheRef.current[pair.id] = { key: request.key, request, response, frozen }
          delete attemptsRef.current[pair.id]
          serviceFailureRef.current = { failures: 0, retryAt: 0 }
        })
        .catch((error: unknown) => {
          if (inFlightRef.current[pair.id] !== active) return
          if (controller.signal.aborted && !timedOut) return
          const status = error instanceof AlignmentHTTPError ? error.status : undefined
          const retryAfterMs = error instanceof AlignmentHTTPError ? error.retryAfterMs : 0
          const previous = attemptsRef.current[pair.id]
          if (!previous || previous.key !== request.key) return
          const failures = previous.failures + 1
          if (!semanticAlignmentStatusIsRetryable(status)) {
            attemptsRef.current[pair.id] = { ...previous, failures, permanent: true }
          } else {
            const serviceFailures = serviceFailureRef.current.failures + 1
            const retryDelay = semanticAlignmentRetryDelayMs(serviceFailures, status, retryAfterMs)
            const delay = retryAfterMs > 0 ? retryDelay : jitter(retryDelay)
            const retryAt = Date.now() + Math.min(maxRetryAfterMs, delay)
            attemptsRef.current[pair.id] = { ...previous, failures, retryAt }
            serviceFailureRef.current = { failures: serviceFailures, retryAt }
          }
          const reason = timedOut || status === 408 || status === 504
            ? 'timeout'
            : status === 502 || status === 503 ? 'unavailable' : 'request_failed'
          const message = reason === 'timeout'
            ? 'Semantic showcase alignment v2 timed out; will retry.'
            : reason === 'unavailable'
              ? 'Semantic showcase alignment v2 service is unavailable; will retry.'
              : 'Semantic showcase alignment v2 request failed.'
          console.warn(message, {
            reason,
            error,
            pairID: pair.id,
            retryable: semanticAlignmentStatusIsRetryable(status),
            failures,
          })
        })
        .finally(() => {
          window.clearTimeout(timeout)
          if (inFlightRef.current[pair.id] === active) delete inFlightRef.current[pair.id]
          if (mountedRef.current) setRevision((value) => value + 1)
        })
    })

    if (!Number.isFinite(nextWakeAt)) return
    const timer = window.setTimeout(
      () => setRevision((value) => value + 1),
      Math.max(0, nextWakeAt - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [atomicFrameCommits, input.vadTranscriptPairs.length, revision, terminal, work])

  return useMemo(() => {
    const nowMs = Date.now()
    const semanticAlignments = Object.fromEntries(work.map(({ pair, request, mode }) => {
      if (mode === 'suspended') {
        const presentation = presentationRef.current[pair.id]
        if (presentation) return [pair.id, presentation]
      }
      const frozen = frozenRef.current[pair.id] || emptyFrozenSemanticAlignment()
      const cached = cacheRef.current[pair.id]
      const readiness = readinessRef.current[pair.id] || {}
      const previews = deferredCommitRef.current[pair.id]
        ? []
        : cached?.key === request.key
          ? semanticPreviewRowsV2(
              request,
              cached.response,
              cached.frozen,
              frozen,
              readiness,
              nowMs,
              atomicFrameCommits,
            )
          : previewRef.current[pair.id] || []
      readinessRef.current[pair.id] = readiness
      const presentedFrozen = semanticPresentationFrozenV2(request, frozen, presentedFrozenRef.current[pair.id])
      presentedFrozenRef.current[pair.id] = presentedFrozen
      const presentation = semanticAlignmentFromState(
        pair,
        request,
        presentedFrozen,
        presentedFrozen === frozen ? previews : [],
        atomicFrameCommits,
      )
      presentationRef.current[pair.id] = presentation
      return [pair.id, presentation]
    }))
    const pending = atomicFrameCommits && work.some(({ pair, request, mode }) => (
      mode === 'normal'
      && hasSemanticContent(request.payload.source) && hasSemanticContent(request.payload.translation)
      && cacheRef.current[pair.id]?.key !== request.key
      && !attemptsRef.current[pair.id]?.failures
    ))
    const previousMerges = rowMergeStateRef.current.owners.size
    const groupedRows = buildShowcaseRows({ ...input, semanticAlignments, terminal, rowMergeState: rowMergeStateRef.current })
    const retainedRows = semanticPendingRowsV2(
      groupedRows, displayedRowsRef.current,
      pending && !terminal && rowMergeStateRef.current.owners.size === previousMerges,
    )
    const rows = retainedRows === groupedRows ? groupedRows : refreshShowcasePlaybackRows(retainedRows, input)
    displayedRowsRef.current = rows
    return atomicFrameCommits ? commitPlayedShowcaseRows(rows, rowMergeStateRef.current, terminal, input) : rows
  }, [atomicFrameCommits, input, revision, terminal, work])
}
