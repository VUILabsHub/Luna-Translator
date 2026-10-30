// Match spoken content independently of late punctuation, retaining UTF-16
// offsets into the original display text. Never rewrite the visible words.
export function indexedPlaybackText(value: string) {
  let text = ''
  const starts: number[] = [], ends: number[] = []
  let offset = 0
  for (const character of value) {
    if (!/[\p{P}\s]/u.test(character)) {
      text += character
      for (let index = 0; index < character.length; index += 1) {
        starts.push(offset)
        ends.push(offset + character.length)
      }
    }
    offset += character.length
  }
  return { text, starts, ends }
}

/** Rebase existing audio ranges after punctuation changes, without fuzzy matches. */
export function remapPlaybackFragments<T extends { text: string }>(text: string, fragments: readonly T[] | undefined): T[] | undefined {
  if (!fragments?.length) return undefined
  const original = fragments.map(fragment => fragment.text).join('')
  if (original === text) return [...fragments]
  const display = indexedPlaybackText(text)
  if (!display.text || !indexedPlaybackText(original).text.startsWith(display.text)) return undefined
  let contentOffset = 0, displayOffset = 0
  return fragments.flatMap(fragment => {
    contentOffset += indexedPlaybackText(fragment.text).text.length
    const end = display.starts[contentOffset] ?? text.length
    const value = text.slice(displayOffset, end)
    displayOffset = end
    return value ? [{ ...fragment, text: value }] : []
  })
}
