import type { HistoryAudioArchive } from '@simultrans/ui-shared/src/historyAudio'
import { showcaseAudioEndMs, type MultilingualShowcaseRow } from './multilingualShowcase'

// Old archives may have a generic output track. Only assign it when its language is unambiguous.
export function resolveFinishedArchive(archive: HistoryAudioArchive, languages: string[]): HistoryAudioArchive {
  const language = languages.length === 1 ? languages[0] : undefined
  if (!language || !archive.output || archive.outputs?.[language]) return archive
  return { ...archive, outputs: { ...archive.outputs, [language]: archive.output } }
}

export function translatedPlaybackRange(
  rows: MultilingualShowcaseRow[],
  index: number,
  language: string,
) {
  const startMs = rows[index]?.outputAudioStarts[language]
  if (!Number.isFinite(startMs) || startMs < 0) return { startMs: 0, fullTrack: true }
  return { startMs, endMs: showcaseAudioEndMs(rows, index, language), fullTrack: false }
}
