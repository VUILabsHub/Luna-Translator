// Shared presentation segmentation for a single VAD utterance. It preserves
// the Web sentence/number boundaries without changing recognition or audio.
import { numericBoundaryUnsafe } from './numericBoundary'
import { closingGuillemetAt } from './textJoin'

export type TranscriptSegmentationPair = {
  id: string
  source: string
  translation: string
  sourceFinal: boolean
  committed: boolean
  translationUnits: ReadonlyArray<{ text: string; providerSegmentId: string }>
  translationSegmentIds: string[]
}

const normalized = (value: string | undefined) => value?.trim() || ''

export type TranscriptPairPart = {
  id: string
  source: string
  translation: string
  atomicLiveRow?: boolean
  sourceOffset: number
  translationSegmentIds: string[]
}

type TextSentence = {
  text: string
  end: number
  soft: boolean
}

const maxTargetSentencesPerSource = 3
const minTargetUnitsBeforeCommaBoundary = 12
const earlySourceBoundaryCost = 0.55
const earlySourceBoundaryMargin = 0.18
// 原文只有 zh/en/ja/ko，原文边界只认这几种标点。
const strongSourceBoundary = /[。！？.!?]/u
const anySourceBoundary = /[。！？.!?，,;；]/gu
// 译文是 18 种输出之一：阿拉伯 / 乌尔都语的 ؟(U+061F) ۔(U+06D4) 算句末，
// ،(U+060C) ؛(U+061B) 算逗号；»(U+00BB) 是俄、法、阿拉伯语的后引号。泰文
// 没有句末标点（句间只留空格），靠 targetUnitCount 计数。
const strongTranslationBoundary = /[。！？.!?\u061F\u06D4]/u
const commaTranslationBoundary = /[，,\u060C\u061B]/u
const translationCloser = /["”’')\]】》」』]/u
const translationBoundaryFollower = /[\s"”’')\]】》」』\u00BB]/u
// 不会落在句末、后面常跟大写词的缩写（小写比较）。拉丁的 Mr / Dr / etc 见
// terminalTranslationPeriod 里的正则；这里补俄文与德文：ул. им. проф. 后面跟
// 人名地名，单独的 т. 只出现在 т. е. / т. д. 里，德文名词大写（bzw. Nr. vgl.）。
const nonFinalAbbreviations = new Set([
  'т', 'ул', 'им', 'проф', 'акад', 'доц', 'напр', 'тел',
  'bzw', 'nr', 'ca', 'vgl', 'ggf', 'evtl', 'inkl',
])
// 两个单字母、中间留空格的缩写。前一个字母的句点从不收尾；后一个只有
// z. B.、d. h.、т. е.、т. к. 从不收尾，u. a.、т. д.、т. п. 常在句末，照常断。
const letterPairAbbreviations = new Set(['zb', 'dh', 'ua', 'те', 'тк', 'тд', 'тп'])
const nonFinalLetterPairs = new Set(['zb', 'dh', 'те', 'тк'])

// 有大小写的字母（拉丁、西里尔、希腊）：用大小写映射判断，不靠 \p{L}（Hermes）。
const casedLetter = (character: string) => character.toLowerCase() !== character.toUpperCase()
const lowercaseCyrillic = (character: string) => (
  /[\u0400-\u04FF]/u.test(character) && character === character.toLowerCase() && casedLetter(character)
)

function wordBefore(value: string, index: number) {
  let start = index
  while (start > 0 && casedLetter(value[start - 1])) start -= 1
  return value.slice(start, index)
}

function terminalTranslationPeriod(value: string, index: number, final = false) {
  if (value[index] !== '.') return true
  const next = value[index + 1] || ''
  if (/\b[ap]$/iu.test(value.slice(0, index)) && /^\s*m(?:\.|$)/iu.test(value.slice(index + 1))) return false
  if (next && !translationBoundaryFollower.test(next)) return false
  const prefix = value.slice(Math.max(0, index - 12), index + 1)
  if (!final && /\b[ap]\.$/iu.test(prefix)) return false
  if (/(?:\b[A-Za-z]\.){2,}$/u.test(prefix)) return false
  if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc)\.$/iu.test(prefix)) return false
  // 句点后隔着空白接西里尔小写字母：是缩写不是句末——「В 2025 г. выручка」
  // 「5 млн. руб.」「т. е. выходить」。俄文按词计数以后，这些句点真的会被拿去
  // 和原文对齐，不能再当句末。拉丁文字不套这条，en 的分段保持原样。
  const following = /^\s+(\S)/u.exec(value.slice(index + 1, index + 9))?.[1] || ''
  if (lowercaseCyrillic(following)) return false
  const word = wordBefore(value, index)
  if (nonFinalAbbreviations.has(word.toLowerCase())) return false
  if (word.length !== 1) return true
  const nextLetter = /^[ \u00A0](\S)\./u.exec(value.slice(index + 1, index + 4))?.[1] || ''
  if (letterPairAbbreviations.has(`${word}${nextLetter}`.toLowerCase())) return false
  const letter = index - 1
  const pairedWithPrevious = /[ \u00A0]/u.test(value[letter - 1] || '')
    && value[letter - 2] === '.'
    && casedLetter(value[letter - 3] || '')
    && !casedLetter(value[letter - 4] || '')
  return !(pairedWithPrevious && nonFinalLetterPairs.has(`${value[letter - 3]}${word}`.toLowerCase()))
}

function terminalTranslationComma(value: string, index: number) {
  if (value[index] === '，') return true
  const next = value[index + 1] || ''
  return !next || translationBoundaryFollower.test(next)
}

// 句末之后紧跟的后引号 / 括号收进这一句。法文在 » 前留一个（窄）不换行空格
// （「« Bonjour ! » puis」），这个空格连同 » 一起收；德文的开引号 » 不收。
function closedTranslationSentenceEnd(value: string, end: number) {
  for (;;) {
    if (translationCloser.test(value[end] || '') || closingGuillemetAt(value, end)) {
      end += 1
    } else if (/[ \u00A0\u202F]/u.test(value[end] || '') && closingGuillemetAt(value, end + 1)) {
      end += 2
    } else {
      return end
    }
  }
}

export function completedTranslationSentences(value: string, final = false) {
  const sentences: TextSentence[] = []
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const strongBoundary = strongTranslationBoundary.test(value[index])
      && terminalTranslationPeriod(value, index, final)
    const commaBoundary = commaTranslationBoundary.test(value[index])
      && terminalTranslationComma(value, index)
      && targetUnitCount(value.slice(start, index)) >= minTargetUnitsBeforeCommaBoundary
    if (!strongBoundary && !commaBoundary) continue
    if (numericBoundaryUnsafe(value, index + 1, final)) continue
    const end = closedTranslationSentenceEnd(value, index + 1)
    const text = value.slice(start, end).trim()
    if (text) sentences.push({ text, end, soft: commaBoundary })
    start = end
    index = end - 1
  }
  return sentences
}

export function stableTranslationSentences(value: string, final: boolean) {
  const sentences = completedTranslationSentences(value, final)
  const consumed = sentences.at(-1)?.end || 0
  const tail = value.slice(consumed).trim()
  return tail
    ? [...sentences, { text: tail, end: value.length, soft: false }]
    : sentences
}

export function unsplitPairPart(pair: TranscriptSegmentationPair, source: string, translation: string): TranscriptPairPart {
  return {
    id: pair.id,
    source,
    translation,
    sourceOffset: 0,
    translationSegmentIds: pair.translationSegmentIds,
  }
}

export function segmentIdsForText(pair: TranscriptSegmentationPair, text: string) {
  return pair.translationUnits
    .filter((unit) => {
      const unitText = unit.text.trim()
      return unitText && (text.includes(unitText) || unitText.includes(text))
    })
    .map((unit) => unit.providerSegmentId)
    .filter(Boolean)
}

function sourceUnitCount(value: string) {
  return [...value.replace(/[\s，。！？；、,.!?;:'"“”‘’()-]/gu, '')].length
}

// 以空格分词的文字按词计：拉丁（含 Latin-1、扩展 A/B 与越南文所在的扩展
// 附加区）、西里尔、阿拉伯（含乌尔都语字母）及各自的数字。附标（分解形式的
// 越南文声调、阿拉伯文 harakat）算在词内，不把一个词拆成两截。显式区间而不是
// \p{Script=…}：这段要在 Hermes 上跑。
const wordLetter = 'A-Za-z0-9\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u1E00-\\u1EFF'
  + '\\u0400-\\u0481\\u048A-\\u052F'
  + '\\u0620-\\u064A\\u0660-\\u0669\\u066E\\u066F\\u0671-\\u06D3\\u06D5\\u06EE-\\u06FC\\u06FF'
const wordMark = '\\u0300-\\u036F\\u0483-\\u0489'
  + '\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E4\\u06E7\\u06E8\\u06EA-\\u06ED'
const wordPart = `[${wordLetter}][${wordLetter}${wordMark}]*`
const targetWord = new RegExp(`${wordPart}(?:['’-]${wordPart})*`, 'gu')
// 泰文词间不留空格：按字符数（不含上下元音与声调符号）除以 3 折算成词。
const thaiCharacter = /[\u0E01-\u0E30\u0E32\u0E33\u0E40-\u0E46\u0E50-\u0E59]/gu

// 假名与谚文不计，保持 ja/ko 既有的分段结果。
function targetUnitCount(value: string) {
  const words = value.match(targetWord)?.length || 0
  const cjkUnits = value.match(/[\u3400-\u9fff]/gu)?.length || 0
  const thaiUnits = Math.round((value.match(thaiCharacter)?.length || 0) / 3)
  return Math.max(1, words + cjkUnits + thaiUnits)
}

function median(values: number[]) {
  if (values.length === 0) return 1.4
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2
}

function trailingDiscourseMarkerCost(value: string) {
  return /[。！？.!?；;，,]\s*(?:第[一二三四五六七八九十百\d]+|首先|其次|再次|最后)[，,]$/u.test(value)
    ? 0.3
    : 0
}

function selectSourceBoundary(
  source: string,
  target: string,
  learnedRatios: number[],
  allowTerminalBoundary: boolean,
) {
  const expectedRatio = median(learnedRatios)
  const targetLength = targetUnitCount(target)
  const candidates = [...source.matchAll(anySourceBoundary)].flatMap((match, index) => {
    const end = (match.index || 0) + match[0].length
    if (numericBoundaryUnsafe(source, end)) return []
    if (match[0] === '.' && !terminalTranslationPeriod(source, end - 1, allowTerminalBoundary)) return []
    if (!allowTerminalBoundary && !source.slice(end).trim()) return []
    const text = source.slice(0, end)
    const measuredRatio = sourceUnitCount(text) / targetLength
    const ratioCost = Math.abs(Math.log(Math.max(0.01, measuredRatio / expectedRatio)))
    const boundaryCost = strongSourceBoundary.test(match[0]) ? 0 : 0.18
    return [{
      text,
      end,
      strong: strongSourceBoundary.test(match[0]),
      measuredRatio,
      cost: ratioCost + boundaryCost + trailingDiscourseMarkerCost(text) + index * 0.004,
    }]
  })
  const best = [...candidates].sort((left, right) => left.cost - right.cost)[0]
  if (best?.strong && best.cost <= earlySourceBoundaryCost) return best
  const earliestConfident = candidates.find((candidate) => (
    candidate.cost <= earlySourceBoundaryCost
    && candidate.cost <= (best?.cost ?? candidate.cost) + earlySourceBoundaryMargin
  ))
  if (earliestConfident) return earliestConfident
  return best?.cost <= 0.85 ? best : undefined
}

export function splitTranscriptPair(pair: TranscriptSegmentationPair): TranscriptPairPart[] {
  const source = normalized(pair.source)
  const translation = normalized(pair.translation)
  if (!source || !translation) {
    return [unsplitPairPart(pair, source, translation)]
  }

  const targetSentences = completedTranslationSentences(translation, pair.committed)
  if (targetSentences.length === 0) return [unsplitPairPart(pair, source, translation)]

  const learnedRatios: number[] = []
  const parts: TranscriptPairPart[] = []
  let sourceOffset = 0
  let translationOffset = 0
  const allowTerminalBoundary = pair.sourceFinal || pair.committed
  let sentenceIndex = 0
  while (sentenceIndex < targetSentences.length) {
    let selected: ReturnType<typeof selectSourceBoundary> = undefined
    let targetEndIndex = sentenceIndex
    let targetText = ''
    while (
      !selected
      && targetEndIndex < targetSentences.length
      && targetEndIndex - sentenceIndex < maxTargetSentencesPerSource
    ) {
      targetText = translation.slice(translationOffset, targetSentences[targetEndIndex].end).trim()
      selected = selectSourceBoundary(
        source.slice(sourceOffset),
        targetText,
        learnedRatios,
        allowTerminalBoundary,
      )
      const consumesFinalSource = Boolean(
        selected
        && allowTerminalBoundary
        && !source.slice(sourceOffset + selected.end).trim(),
      )
      const canExpandTarget = targetEndIndex + 1 < targetSentences.length
        && targetEndIndex - sentenceIndex + 1 < maxTargetSentencesPerSource
      if (consumesFinalSource && canExpandTarget) {
        selected = undefined
        targetEndIndex += 1
        continue
      }
      if (!selected) targetEndIndex += 1
    }
    if (!selected) break
    parts.push({
      id: `${pair.id}:soft-${parts.length}`,
      source: selected.text.trim(),
      translation: targetText,
      sourceOffset,
      translationSegmentIds: segmentIdsForText(pair, targetText),
    })
    sourceOffset += selected.end
    translationOffset = targetSentences[targetEndIndex].end
    if (!targetSentences.slice(sentenceIndex, targetEndIndex + 1).some((sentence) => sentence.soft)) {
      learnedRatios.push(selected.measuredRatio)
    }
    sentenceIndex = targetEndIndex + 1
  }

  if (parts.length === 0) {
    return [unsplitPairPart(pair, source, translation)]
  }

  const tailSource = source.slice(sourceOffset).trim()
  const tailTranslation = translation.slice(translationOffset).trim()
  if (!tailSource && !tailTranslation && parts.length === 1) {
    return [unsplitPairPart(pair, source, translation)]
  }
  if (tailSource || tailTranslation) {
    parts.push({
      id: `${pair.id}:tail`,
      source: tailSource,
      translation: tailTranslation,
      sourceOffset,
      translationSegmentIds: segmentIdsForText(pair, tailTranslation),
    })
  }
  return parts
}
