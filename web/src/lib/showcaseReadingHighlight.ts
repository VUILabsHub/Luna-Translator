import type { ShowcaseTranslationPlaybackFragment as Fragment } from '@simultrans/ui-shared/src/lib/showcaseRows'
import { indexedPlaybackText, remapPlaybackFragments } from '@simultrans/ui-shared/src/lib/playbackText'

/** Retain only the last actually read character ranges during the UI grace period. */
export function retainReadingHighlight(current: Fragment[] | undefined, previous: Fragment[] | undefined) {
  if (!current || !previous?.length) return current
  const previousDisplay = previous.map(fragment => fragment.text).join('')
  const previousText = indexedPlaybackText(previousDisplay).text
  const currentText = current.map(fragment => fragment.text).join('')
  const indexed = indexedPlaybackText(currentText)
  if (!previousText || !indexed.text.startsWith(previousText)) return current
  if (!currentText.startsWith(previousDisplay)) {
    previous = remapPlaybackFragments(currentText.slice(0, indexed.starts[previousText.length] ?? currentText.length).trimEnd(), previous)
  }
  if (!previous) return current
  let offset = 0
  const ranges = previous.flatMap(fragment => {
    const start = offset
    offset += fragment.text.length
    return fragment.status === 'playing' || fragment.playing ? [{ start, end: offset }] : []
  })
  offset = 0
  return current.flatMap(fragment => {
    const start = offset
    offset += fragment.text.length
    const overlaps = ranges.filter(range => range.start < offset && range.end > start)
    if (!overlaps.length) return [fragment]
    const cuts = [...new Set([0, fragment.text.length, ...overlaps.flatMap(range => [
      Math.max(0, range.start - start), Math.min(fragment.text.length, range.end - start),
    ])])].sort((a, b) => a - b)
    return cuts.slice(1).map((end, index) => ({
      ...fragment,
      text: fragment.text.slice(cuts[index], end),
      ...(overlaps.some(range => range.start < start + end && range.end > start + cuts[index])
        ? { playing: true, status: 'playing' as const } : {}),
    }))
  })
}
