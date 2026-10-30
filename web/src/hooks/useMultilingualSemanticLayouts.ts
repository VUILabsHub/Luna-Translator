import { useMemo } from 'react'
import type { VadTranscriptPair } from '@simultrans/ui-shared/src/lib/vadTranscriptPairs'
import type { MultilingualOutput } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import { useSemanticShowcaseRows } from './useSemanticShowcaseRows'
import type { MultilingualSemanticLayouts } from '../lib/multilingualShowcase'
import type { ShowcaseSettledPlaybackStatus } from '@simultrans/ui-shared/src/lib/showcaseRows'
import { indexedPlaybackText } from '@simultrans/ui-shared/src/lib/playbackText'

const languagePrefix = (language: string) => `${language}\u001f`

export function joinInterruptedTranslationPairs(pairs: VadTranscriptPair[]): VadTranscriptPair[] {
  const result: VadTranscriptPair[] = []
  const joinedIds = new Set<string>()
  for (const pair of pairs) {
    const previous = result.at(-1)
    const firstUnit = pair.translationUnits[0]
    const crossesSourceBoundary = firstUnit?.startMs !== undefined
      && firstUnit.endMs !== undefined && pair.sourceVadStartMs !== undefined
      && firstUnit.startMs < pair.sourceVadStartMs
      && firstUnit.endMs > pair.sourceVadStartMs
    const previousText = indexedPlaybackText(previous?.translation || '').text
    const unitText = indexedPlaybackText(firstUnit?.text || '').text
    const continuationAt = unitText && crossesSourceBoundary
      ? (previousText + indexedPlaybackText(pair.translation).text)
        .indexOf(unitText, Math.max(0, previousText.length - unitText.length + 1))
      : -1
    const continuesPriorText = continuationAt >= 0 && continuationAt < previousText.length
    // A translation force-flushed at a pause can continue in the next VAD.
    // Limit punctuation-only joins to two pairs. An explicitly overlapping
    // audio unit can extend that same editable tail without replacing its ID.
    if (previous && (!joinedIds.has(previous.id) || crossesSourceBoundary) && previous.committed
      && previous.translation.trim() && pair.translation.trim()
      && (crossesSourceBoundary || !/[.!?。！？]["”’')\]】]*$/u.test(previous.translation.trim()))
      // VAD end cursors include silence and may overlap the next speech start.
      // Only a TTS text spanning both groups can override that overlap.
      && (pair.startMs >= (previous.endMs ?? previous.startMs)
        || (continuesPriorText && pair.startMs >= previous.startMs))
      && pair.startMs - (previous.endMs ?? previous.startMs) <= 5000) {
      const join = (left: string, right: string) => [left.trim(), right.trim()].filter(Boolean).join(' ')
      joinedIds.add(previous.id)
      result[result.length - 1] = {
        // The semantic hook stores confirmed rows by pair ID. Keep that prefix
        // when a later VAD contributes the continuation of its editable tail.
        ...pair, id: previous.id,
        source: join(previous.source, pair.source),
        sourceStableText: join(previous.sourceStableText, pair.sourceStableText),
        translation: join(previous.translation, pair.translation),
        translationStableEpochText: join(previous.translationStableEpochText, pair.translationStableEpochText),
        translationEpochText: join(previous.translationEpochText, pair.translationEpochText),
        startMs: previous.startMs, sourceVadStartMs: previous.sourceVadStartMs,
        translationUnits: [...previous.translationUnits, ...pair.translationUnits],
        translationSegmentIds: [...previous.translationSegmentIds, ...pair.translationSegmentIds],
        translationRetiredSegmentIds: [...previous.translationRetiredSegmentIds, ...pair.translationRetiredSegmentIds],
        translationSeenDoneKeys: [...previous.translationSeenDoneKeys, ...pair.translationSeenDoneKeys],
      }
    } else result.push(pair)
  }
  return result
}

export function useMultilingualSemanticLayouts(
  targetLanguages: string[],
  outputs: Record<string, MultilingualOutput>,
  terminal: boolean,
  atomicFrameCommits = false,
): MultilingualSemanticLayouts {
  const pairs = useMemo(() => {
    const sharedPairs = targetLanguages.flatMap((language) => outputs[language]?.vadTranscriptPairs || [])
    return targetLanguages.flatMap((language) => {
      const prefix = languagePrefix(language)
      return joinInterruptedTranslationPairs(outputs[language]?.vadTranscriptPairs || []).map((pair) => {
        const sourcePair = sharedPairs.find((candidate) => (
          (pair.speechEpoch > 0
            ? candidate.speechEpoch === pair.speechEpoch
            : candidate.id === pair.id)
          && Boolean(candidate.source.trim())
        ))
        return {
          ...pair,
          ...(sourcePair && !pair.source.trim() ? {
            source: sourcePair.source,
            sourceStableText: sourcePair.sourceStableText,
            sourceFinal: sourcePair.sourceFinal,
            sourceVadStartMs: pair.sourceVadStartMs ?? sourcePair.sourceVadStartMs,
            committed: pair.committed || sourcePair.committed,
          } : {}),
          id: `${prefix}${pair.id}`,
          translationSegmentIds: pair.translationSegmentIds.map((segmentId) => `${prefix}${segmentId}`),
          translationUnits: pair.translationUnits.map((unit) => ({
            ...unit,
            providerSegmentId: unit.providerSegmentId ? `${prefix}${unit.providerSegmentId}` : '',
          })),
        }
      })
    })
  }, [outputs, targetLanguages])
  const playingTranslationSegmentIds = useMemo(() => new Set(targetLanguages.flatMap((language) => {
    const segmentId = outputs[language]?.playingTranslationSegmentId
    return segmentId ? [`${languagePrefix(language)}${segmentId}`] : []
  })), [outputs, targetLanguages])
  const settledTranslationSegments = useMemo(() => new Map<string, ShowcaseSettledPlaybackStatus>(
    targetLanguages.flatMap((language) => (
      Object.entries(outputs[language]?.settledTranslationSegments || {}).map(([segmentId, status]) => (
        [`${languagePrefix(language)}${segmentId}`, status] as const
      ))
    )),
  ), [outputs, targetLanguages])

  const receivedTranslationAudioSegments = useMemo(() => new Set(targetLanguages.flatMap(language => (
    Object.keys(outputs[language]?.audioRanges || {}).map(segmentId => `${languagePrefix(language)}${segmentId}`)
  ))), [outputs, targetLanguages])

  const rows = useSemanticShowcaseRows({
    sourceText: '',
    translation: '',
    modelOutputTranslation: '',
    sourceSegments: [],
    translationDisplayUnits: [],
    vadTranscriptPairs: pairs,
    playingTranslationSegmentId: playingTranslationSegmentIds,
    settledTranslationSegments,
    receivedTranslationAudioSegments,
    terminal,
    atomicFrameCommits,
  })

  return useMemo(() => Object.fromEntries(targetLanguages.map((language) => {
    const prefix = languagePrefix(language)
    return [language, rows
      .filter((row) => row.id.startsWith(prefix))
      .map((row) => ({ ...row, id: row.id.slice(prefix.length) }))]
  })), [rows, targetLanguages])
}
