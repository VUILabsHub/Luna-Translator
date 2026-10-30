import type { MultilingualOutput } from '@simultrans/ui-shared/src/hooks/useMultilingualRealtimeSession'
import type { TimedTranscriptSegment } from '@simultrans/ui-shared/src/types/history'
import {
  combinePlaybackStatuses,
  hasShowcaseContent,
  type ShowcasePlaybackStatus,
  type ShowcaseTranscriptRow,
  type ShowcaseTranslationPlaybackFragment,
} from '@simultrans/ui-shared/src/lib/showcaseRows'
import { groupTimedTranscriptSentences } from '@simultrans/ui-shared/src/lib/transcript'
// 活行非主语言只显示最近一截：与 App 同一份实现（含泰文 / 阿拉伯文附标不悬空）。
import { latestLineTail } from '@simultrans/core/textJoin'

export type MultilingualShowcaseRow = {
  /** Known turn language for script-aware source rendering (conversation). */
  sourceLanguage?: string
  id: string
  source: string
  startMs: number
  committed: boolean
  playbackCommitted?: boolean
  atomicLiveRow?: boolean
  translations: Record<string, string>
  translationPlaybackFragments?: Record<string, ShowcaseTranslationPlaybackFragment[]>
  outputAudioStarts: Record<string, number>
  outputAudioEnds: Record<string, number>
  playing?: boolean
  /** 主语言译文的播放状态（未读 / 阅读中 / 已读 / 跳过）；无 TTS 段落信息时缺省。 */
  playbackStatus?: ShowcasePlaybackStatus
}

export type DuoShowcaseBubble = MultilingualShowcaseRow & {
  side: 'a' | 'b'
  layoutLanguage?: string
  sourceLanguage: string
  targetLanguages: string[]
}

/** 时间只用于交错两路；每路保持分段器的顺序，不能按可变的子行时间重新排序。 */
export function mergeDuoSpeakerRows(left: DuoShowcaseBubble[], right: DuoShowcaseBubble[]): DuoShowcaseBubble[] {
  const rows: DuoShowcaseBubble[] = []
  let a = 0
  let b = 0
  while (a < left.length && b < right.length) {
    rows.push(left[a].startMs <= right[b].startMs ? left[a++] : right[b++])
  }
  return [...rows, ...left.slice(a), ...right.slice(b)]
}

/** 每侧选择自己的完整语言布局；旧记录只展示实际保存了该语言的行。 */
export function selectDuoLanguageLayouts(bubbles: DuoShowcaseBubble[], leftLanguage: string, rightLanguage: string) {
  const selected = bubbles.filter((bubble) => {
    const language = bubble.side === 'a' ? leftLanguage : rightLanguage
    if (bubble.layoutLanguage) return bubble.layoutLanguage === language
    return Boolean(bubble.translations[language]?.trim())
      || (!Object.values(bubble.translations).some(text => text.trim()) && Boolean(bubble.source))
  })
  return mergeDuoSpeakerRows(selected.filter(row => row.side === 'a'), selected.filter(row => row.side === 'b'))
}

export type MultilingualSemanticLayouts = Record<string, ShowcaseTranscriptRow[]>

function playbackFragmentsForDisplayedText(
  fragments: ShowcaseTranslationPlaybackFragment[] | undefined,
  displayedText: string,
) {
  if (!fragments) return undefined
  const fullText = fragments.map((fragment) => fragment.text).join('')
  if (fullText === displayedText) return fragments
  const visibleTail = displayedText.startsWith('…') ? displayedText.slice(1) : displayedText
  if (!visibleTail || !fullText.endsWith(visibleTail)) return undefined

  const projected: ShowcaseTranslationPlaybackFragment[] = []
  const visibleStart = fullText.length - visibleTail.length
  let offset = 0
  for (const fragment of fragments) {
    const fragmentEnd = offset + fragment.text.length
    if (fragmentEnd > visibleStart) {
      projected.push({
        ...fragment,
        text: fragment.text.slice(Math.max(0, visibleStart - offset)),
      })
    }
    offset = fragmentEnd
  }
  if (displayedText.startsWith('…')) {
    // 省略号跟随首个可见片段的状态，不然灰色行前面会顶着一个黑色「…」。
    const leadStatus = projected[0]?.status
    projected.unshift({ text: '…', playing: false, ...(leadStatus ? { status: leadStatus } : {}) })
  }
  return projected
}

function latestOutputText(output?: MultilingualOutput) {
  const pairs = output?.vadTranscriptPairs || []
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    if (pairs[index].translation.trim()) return pairs[index].translation
  }
  return output?.modelOutputTranslation || output?.translation || ''
}

function fallbackRowForSemanticRow(
  row: ShowcaseTranscriptRow | undefined,
  fallbackRows: MultilingualShowcaseRow[],
) {
  if (!row) return undefined
  return fallbackRows.find((fallback) => (
    row.id === fallback.id || row.id.startsWith(`${fallback.id}:`)
  ))
}

export function buildPrimaryDrivenMultilingualRows(
  targetLanguages: string[],
  primaryLanguage: string,
  layouts: MultilingualSemanticLayouts,
  fallbackRows: MultilingualShowcaseRow[],
  outputs: Record<string, MultilingualOutput>,
): MultilingualShowcaseRow[] {
  const primaryRows = layouts[primaryLanguage] || []
  const rows: MultilingualShowcaseRow[] = primaryRows.length > 0
    ? primaryRows.map((row, index) => {
      const fallback = fallbackRowForSemanticRow(row, fallbackRows)
      const prefix = `${primaryLanguage}\u001f`
      const segmentIds = row.translationPlaybackFragments?.flatMap(({ segmentId }) => segmentId
        ? [segmentId.startsWith(prefix) ? segmentId.slice(prefix.length) : segmentId] : []) || []
      const range = exactTTSAudioRange(segmentIds, outputs[primaryLanguage])
        || translationAudioRange(segmentIds, outputs[primaryLanguage]?.segments || [], 0, row.translation)
      // A semantic child must not inherit its entire VAD parent's audio.
      // If a TTS unit contains several displayed sentences, replay that actual
      // unit in full; do not invent word-level timestamps by character ratio.
      const exactFallback = fallback?.translations[primaryLanguage] === row.translation ? fallback : undefined
      const primaryAudioStart = range?.startMs ?? exactFallback?.outputAudioStarts[primaryLanguage]
      const primaryAudioEnd = range?.endMs ?? exactFallback?.outputAudioEnds[primaryLanguage]
      const oneSided = hasShowcaseContent(row.source) !== hasShowcaseContent(row.translation)
      return {
        id: `${primaryLanguage}:${row.id}`,
        source: row.source,
        startMs: row.startMs,
        committed: row.playbackCommitted ?? (!oneSided && Boolean(fallback?.committed || index < primaryRows.length - 1)),
        ...(row.playbackCommitted !== undefined ? { playbackCommitted: row.playbackCommitted } : {}),
        ...(row.atomicLiveRow ? { atomicLiveRow: true } : {}),
        translations: Object.fromEntries(targetLanguages.map((language) => [
          language,
          language === primaryLanguage ? row.translation : '',
        ])),
        ...(row.translationPlaybackFragments ? {
          translationPlaybackFragments: { [primaryLanguage]: row.translationPlaybackFragments },
        } : {}),
        outputAudioStarts: primaryAudioStart === undefined ? {} : { [primaryLanguage]: primaryAudioStart },
        outputAudioEnds: primaryAudioEnd === undefined ? {} : { [primaryLanguage]: primaryAudioEnd },
        playing: row.playing,
        ...(row.playbackStatus ? { playbackStatus: row.playbackStatus } : {}),
      }
    })
    : fallbackRows.map((row) => ({
      ...row,
      translations: Object.fromEntries(targetLanguages.map((language) => [
        language,
        language === primaryLanguage ? row.translations[language] || '' : '',
      ])),
      outputAudioStarts: row.outputAudioStarts[primaryLanguage] === undefined
        ? {}
        : { [primaryLanguage]: row.outputAudioStarts[primaryLanguage] },
      outputAudioEnds: row.outputAudioEnds[primaryLanguage] === undefined
        ? {}
        : { [primaryLanguage]: row.outputAudioEnds[primaryLanguage] },
    }))

  const latestRow = rows.at(-1)
  if (!latestRow) return rows
  const latestPrimarySemanticRow = primaryRows.at(-1)
  const latestPrimaryFallback = fallbackRowForSemanticRow(latestPrimarySemanticRow, fallbackRows)
  for (const language of targetLanguages) {
    if (language === primaryLanguage) continue
    const latestSemanticRow = layouts[language]?.at(-1)
    const latestFallback = fallbackRowForSemanticRow(latestSemanticRow, fallbackRows)
    if (
      latestPrimarySemanticRow?.atomicLiveRow
      && (latestPrimaryFallback
        ? latestFallback?.id !== latestPrimaryFallback.id
        : latestSemanticRow?.id !== latestPrimarySemanticRow.id)
    ) continue
    const latestTranslation = latestPrimarySemanticRow?.atomicLiveRow
      ? latestSemanticRow?.translation || ''
      : latestSemanticRow?.translation || latestOutputText(outputs[language])
    const displayedTranslation = latestLineTail(latestTranslation)
    latestRow.translations[language] = displayedTranslation
    const displayedFragments = playbackFragmentsForDisplayedText(
      latestSemanticRow?.translationPlaybackFragments,
      displayedTranslation,
    )
    if (displayedFragments) {
      latestRow.translationPlaybackFragments ||= {}
      latestRow.translationPlaybackFragments[language] = displayedFragments
    }
    const fallback = latestFallback || fallbackRows.at(-1)
    const audioStart = fallback?.outputAudioStarts[language]
    const audioEnd = fallback?.outputAudioEnds[language]
    if (audioStart !== undefined) latestRow.outputAudioStarts[language] = audioStart
    if (audioEnd !== undefined) latestRow.outputAudioEnds[language] = audioEnd
  }
  return rows
}

function validAudioOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function exactTTSAudioRange(segmentIds: string[], output?: MultilingualOutput) {
  const ids = [...new Set(segmentIds)]
  const ranges = ids.map(id => output?.audioRanges?.[id])
  if (!ranges.length || ranges.some(range => !range || !validAudioOffset(range.startMs) || !validAudioOffset(range.endMs) || range.endMs <= range.startMs)) return undefined
  return { startMs: Math.min(...ranges.map(range => range!.startMs)), endMs: Math.max(...ranges.map(range => range!.endMs)) }
}

function translationAudioRange(
  segmentIds: string[],
  sentences: TimedTranscriptSegment[],
  fallbackIndex: number,
  translation: string,
) {
  const ids = new Set(segmentIds)
  const matchedIndices = ids.size > 0
    ? sentences.flatMap((sentence, index) => (
      [sentence.id, ...(sentence.memberIds || [])].some((id) => ids.has(id)) ? [index] : []
    ))
    : []
  const normalizedTranslation = translation.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
  const textMatchedIndices: number[] = []
  if (matchedIndices.length === 0 && normalizedTranslation) {
    const containing = sentences.filter(sentence => sentence.text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '').includes(normalizedTranslation))
    // Repeated short phrases cannot identify a particular TTS unit by text.
    if (containing.length > 1) return undefined
    for (let index = fallbackIndex; index < sentences.length; index += 1) {
      const normalizedSentence = sentences[index].text.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
      const matches = normalizedSentence.length > 0 && (
        normalizedTranslation.includes(normalizedSentence)
        || normalizedSentence.includes(normalizedTranslation)
      )
      if (matches) textMatchedIndices.push(index)
      else if (textMatchedIndices.length > 0) break
    }
  }
  const indices = matchedIndices.length > 0
    ? matchedIndices
    : textMatchedIndices.length > 0
      ? textMatchedIndices
    : []
  const starts = indices
    .map((index) => sentences[index].outputAudioStartMs)
    .filter(validAudioOffset)
  if (starts.length === 0 || starts.length !== indices.length) return undefined
  const lastIndex = Math.max(...indices)
  const explicitEnds = indices.map((index) => sentences[index].outputAudioEndMs).filter(validAudioOffset)
  const nextStart = sentences
    .slice(lastIndex + 1)
    .map((sentence) => sentence.outputAudioStartMs)
    .find(validAudioOffset)
  return {
    startMs: Math.min(...starts),
    endMs: explicitEnds.length === indices.length ? Math.max(...explicitEnds) : nextStart,
  }
}

export function buildMultilingualShowcaseRows(
  sourceText: string,
  sourceSegments: TimedTranscriptSegment[],
  targetLanguages: string[],
  outputs: Record<string, MultilingualOutput>,
): MultilingualShowcaseRow[] {
  const primaryOutput = outputs[targetLanguages[0]]
  const primaryPairs = primaryOutput?.vadTranscriptPairs || []
  const sourceSentences = groupTimedTranscriptSentences(sourceSegments)
  const outputSentences = Object.fromEntries(targetLanguages.map((language) => [
    language,
    groupTimedTranscriptSentences(outputs[language]?.segments || []),
  ]))
  const rowCount = Math.max(primaryPairs.length, sourceSentences.length, sourceText.trim() ? 1 : 0)

  return Array.from({ length: rowCount }, (_, index) => {
    const primaryPair = primaryPairs[index]
    const sourceSentence = sourceSentences[index]
    const primaryPlaybackStatus = primaryOutput && primaryPair
      ? combinePlaybackStatuses(primaryPair.translationSegmentIds.map((segmentId) => (
        primaryOutput.playingTranslationSegmentId === segmentId
          ? 'playing'
          : primaryOutput.settledTranslationSegments[segmentId] ?? 'pending'
      )))
      : undefined
    const outputAudioStarts: Record<string, number> = {}
    const outputAudioEnds: Record<string, number> = {}
    const translations = Object.fromEntries(targetLanguages.map((language) => {
      const output = outputs[language]
      const pair = primaryPair
        ? output?.vadTranscriptPairs.find((candidate) => (
            primaryPair.speechEpoch
              ? candidate.speechEpoch === primaryPair.speechEpoch
              : candidate.id === primaryPair.id
          ))
        : output?.vadTranscriptPairs[index]
      const sentence = outputSentences[language][index]
      const fallbackSnapshot = rowCount === 1
        ? output?.modelOutputTranslation || output?.translation || ''
        : ''
      const translation = pair?.translation || (!primaryPair ? sentence?.text || fallbackSnapshot : '')
      const range = translation
        ? exactTTSAudioRange(pair?.translationSegmentIds || [], output)
          || translationAudioRange(pair?.translationSegmentIds || [], output?.segments || [], 0, translation)
        : undefined
      if (range) {
        outputAudioStarts[language] = range.startMs
        if (range.endMs !== undefined) outputAudioEnds[language] = range.endMs
      }
      return [language, translation]
    }))

    return {
      id: primaryPair?.id || sourceSentence?.id || `multilingual-row-${index}`,
      source: primaryPair?.source || sourceSentence?.text || (rowCount === 1 ? sourceText : ''),
      startMs: primaryPair?.sourceVadStartMs ?? primaryPair?.startMs ?? sourceSentence?.startMs ?? 0,
      committed: primaryPair?.committed ?? index < rowCount - 1,
      translations,
      outputAudioStarts,
      outputAudioEnds,
      playing: Boolean(
        primaryOutput?.playingTranslationSegmentId
        && primaryPair?.translationSegmentIds.includes(primaryOutput.playingTranslationSegmentId)
      ),
      ...(primaryPlaybackStatus ? { playbackStatus: primaryPlaybackStatus } : {}),
    }
  }).filter((row) => row.source || Object.values(row.translations).some(Boolean))
}

export function showcaseAudioEndMs(
  rows: MultilingualShowcaseRow[],
  rowIndex: number,
  language?: string,
) {
  const currentStart = language ? rows[rowIndex]?.outputAudioStarts[language] : rows[rowIndex]?.startMs
  if (typeof currentStart !== 'number' || !Number.isFinite(currentStart)) return undefined
  const explicitEnd = language ? rows[rowIndex]?.outputAudioEnds[language] : undefined
  if (validAudioOffset(explicitEnd) && explicitEnd > currentStart) return explicitEnd
  for (let index = rowIndex + 1; index < rows.length; index += 1) {
    const nextStart = language ? rows[index].outputAudioStarts[language] : rows[index].startMs
    if (typeof nextStart === 'number' && Number.isFinite(nextStart) && nextStart > currentStart) return nextStart
  }
  return undefined
}

export function featuredShowcaseRowId(rows: MultilingualShowcaseRow[]) {
  const latest = rows.at(-1)
  return latest?.playbackCommitted ? '' : latest?.id || ''
}

export function buildDuoShowcaseBubbles(
  side: 'a' | 'b',
  sourceLanguage: string,
  targetLanguages: string[],
  sourceText: string,
  sourceSegments: TimedTranscriptSegment[],
  outputs: Record<string, MultilingualOutput>,
): DuoShowcaseBubble[] {
  if (targetLanguages.length === 0) return []
  return buildMultilingualShowcaseRows(
    sourceText,
    sourceSegments,
    targetLanguages,
    outputs,
  ).map((row) => ({ ...row, side, sourceLanguage, targetLanguages }))
}

export function combineDuoStatus(left: string, right: string) {
  if (left === 'recording' || right === 'recording') return 'recording'
  if (left === 'connecting' || right === 'connecting') return 'connecting'
  if (left === 'processing' || right === 'processing') return 'processing'
  if (left === 'error' || right === 'error') return 'error'
  if (left === 'finished' || right === 'finished') return 'finished'
  return 'idle'
}

export function validateDuoMicrophones(leftDeviceId: string, rightDeviceId: string) {
  if (leftDeviceId === 'default' || rightDeviceId === 'default') return '请为甲、乙分别选择一支明确的麦克风。'
  if (leftDeviceId === rightDeviceId) return '甲、乙不能使用同一支麦克风。'
  return ''
}

export function validateDuoStereoMicrophone(deviceId: string) {
  return deviceId === 'default' ? '请选择一台明确的双声道接收器。' : ''
}

export function validateDuoOutputDevices(leftDeviceId: string, rightDeviceId: string, supported: boolean) {
  if (!supported) return '当前浏览器不支持分别选择甲、乙的输出设备。'
  if (leftDeviceId === 'default' || rightDeviceId === 'default') return '请为甲、乙分别选择一个明确的输出设备。'
  if (leftDeviceId === rightDeviceId) return '甲、乙不能使用同一个输出设备。'
  return ''
}
