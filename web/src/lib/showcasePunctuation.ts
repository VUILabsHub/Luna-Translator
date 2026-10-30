import { canaryDesignEnabled } from './canaryDesign'

const leadingPunctuation = /^\s*(?:[,.!?;:，。！？；：、]\s*)+/u
// Canary 放开阿拉伯语、乌尔都语输出：阿拉伯文的 ، ؛ ؟ 与乌尔都文句号 ۔ 同样会被模型挤到下一行行首。
// 阿拉伯文小数点是 ٫ 不是 ،，下面的小数守卫不用加 ،。prod 保持原规则。
const leadingPunctuationWithArabic = /^\s*(?:[,.!?;:，。！？；：、،؛؟۔]\s*)+/u

/** Display-only projection; callers pass one session's visible rows in display order. */
export function moveLeadingTranslationPunctuation<T extends { translations: Record<string, string>; side?: string }>(rows: readonly T[], arabicPunctuation = canaryDesignEnabled()): T[] {
  const leading = arabicPunctuation ? leadingPunctuationWithArabic : leadingPunctuation
  const displayed = rows.map(row => ({ ...row, translations: { ...row.translations } }))
  const previousBySide = new Map<string, number>()
  displayed.forEach((row, index) => {
    const side = row.side || ''
    const previousIndex = previousBySide.get(side)
    previousBySide.set(side, index)
    if (previousIndex === undefined) return
    const previous = displayed[previousIndex]
    for (const [language, text] of Object.entries(row.translations)) {
      const prefix = text.match(leading)?.[0]
      const before = previous.translations[language]?.trimEnd()
      if (!prefix || !before) continue
      const tail = text.slice(prefix.length)
      const punctuation = prefix.replace(/\s/gu, '')
      // A decimal or numeric continuation belongs to the current row.
      if (/[.,，]$/u.test(punctuation) && /^\p{N}/u.test(tail)) continue
      // The alignment layer may already have restored this late punctuation.
      let overlap = punctuation.length
      while (overlap > 0 && !before.endsWith(punctuation.slice(0, overlap))) overlap -= 1
      previous.translations[language] = before + punctuation.slice(overlap)
      row.translations[language] = tail
    }
  })
  // Keep playback fragments and audio identities on their original rows.
  return displayed
}
