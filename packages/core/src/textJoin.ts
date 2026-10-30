// Pure text-joining primitives shared by every client. Moved verbatim from
// frontend/src/lib/transcript.ts under contract v1 (docs/protocol/
// realtime-text-sync-v1.md R7/R10, goldens S1/S2/B1/B2).

export function joinTranscriptFragment(current: string, next: string) {
  if (!current) return next
  if (!next) return current
  if (
    /\s$/u.test(current)
    || /^\s/u.test(next)
    || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(current)
    || /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}，。！？；：、,.!?;:)}\]】》」』’”]/u.test(next)
    || /[-–—/('“‘]$/u.test(current)
  ) {
    return current + next
  }
  return `${current} ${next}`
}

export function splitCompletedSentences(value: string) {
  const completed: string[] = []
  let sentenceStart = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    const isDecimalPoint = (
      character === '.'
      && /\d/u.test(value[index - 1] || '')
      && /\d/u.test(value[index + 1] || '')
    )
    // 阿拉伯 / 乌尔都语的问号 ؟(U+061F)、句号 ۔(U+06D4)、分号 ؛(U+061B) 与
    // ？。； 同样算句末；作后引号的 » 和 ” 一样跟着句末收进这一句（法文 » 前
    // 的不换行空格也一起收）。
    if (!/[。！？!?；;\.\u061F\u06D4\u061B]/u.test(character) || isDecimalPoint) continue

    let sentenceEnd = index + 1
    while (
      sentenceEnd < value.length
      && (
        /[。！？!?\.\u061F\u06D4）)\]】》」』’”"' \t\u00A0\u202F]/u.test(value[sentenceEnd])
        || closingGuillemetAt(value, sentenceEnd)
      )
    ) {
      sentenceEnd += 1
    }
    const sentence = value.slice(sentenceStart, sentenceEnd).trim()
    if (sentence) completed.push(sentence)
    sentenceStart = sentenceEnd
    index = sentenceEnd - 1
  }
  return { completed, remainder: value.slice(sentenceStart).trim() }
}

/**
 * `value[index]` 的 »(U+00BB) 是不是后引号。俄、法、阿拉伯语的 «…» 里它收尾，
 * 后面是空白、标点或文本末尾；德语的 »…« 里它是开引号，后面直接跟字母
 * （「Er ging. »Hallo«」），不能收进前一句。
 */
export function closingGuillemetAt(value: string, index: number) {
  if (value[index] !== '\u00BB') return false
  const next = value[index + 1] || ''
  return !next || /[\s.,;:!?…)\]"”’'\u00BB\u060C\u061B\u061F\u06D4\u2013\u2014-]/u.test(next)
}

export function translationUnitSeparator(previousText: string | undefined, nextText: string) {
  if (!previousText || !nextText) return ''
  const previousCharacter = previousText.at(-1) || ''
  const nextCharacter = nextText.at(0) || ''
  if (/\s/.test(previousCharacter) || /\s/.test(nextCharacter)) return ''
  // ، ؛ ؟ ۔（U+060C / U+061B / U+061F / U+06D4，阿拉伯 / 乌尔都语的逗号、
  // 分号、问号、句号）前面同样不加空格。
  if (/[,.;:!?，。！？；：、)\]}>》」』】）\u060C\u061B\u061F\u06D4]/.test(nextCharacter)) return ''
  if (/[(\[<{《「『【（]/.test(previousCharacter)) return ''
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(previousCharacter) || /[\u3400-\u9fff\uf900-\ufaff]/.test(nextCharacter)) return ''
  return ' '
}

/**
 * 组合附标：不占独立字位，只能跟在基字后面。通用附标（越南文等的分解形式）、
 * 阿拉伯 / 乌尔都语的 harakat 与上下标记、泰文的上下元音与声调符号。
 */
const combiningMark = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/u

/**
 * 「活行」上非主语言那一行只显示**最近的一截**（duo-14）。Web
 * `web/src/lib/multilingualShowcase.ts` 直接引用这一份，两端同一结果。
 *
 * 为什么不是普通的单行省略：非主语言行只有一行高度，从头截断（`ellipsize:
 * tail`）会把用户正在听的那几个字挤出屏幕，屏幕上永远停在这句话的开头。
 * 这里反过来保留尾部、在前面补一个 `…`。
 *
 * `maxUnits` 按**显示宽度**算：CJK / 假名 / 谚文算 2，组合附标算 0，其余算 1。
 * 截点前的基字被省略时，跟在它后面的附标也一起去掉，否则行首会画出一个
 * 虚线圈（◌ั）。
 */
export function latestLineTail(value: string, maxUnits = 44): string {
  const characters = [...value.replace(/\s+/gu, ' ').trim()]
  let units = 0
  let start = characters.length
  while (start > 0) {
    const character = characters[start - 1]
    const width = combiningMark.test(character) ? 0 : /[㐀-鿿぀-ヿ가-힯]/u.test(character) ? 2 : 1
    if (units + width > maxUnits) break
    units += width
    start -= 1
  }
  if (start > 0) {
    while (start < characters.length && combiningMark.test(characters[start])) start += 1
  }
  const tail = characters.slice(start).join('').trimStart()
  return start > 0 ? `…${tail}` : tail
}
