export type TranscriptDisplayMode = 'translation' | 'source' | 'bilingual'
export const TRANSCRIPT_DISPLAY_OPTIONS: Array<{ value: TranscriptDisplayMode; label: string }> = [
  { value: 'translation', label: '只译文' },
  { value: 'source', label: '只原文' },
  { value: 'bilingual', label: '原译混排' },
]
const key = 'simultrans.quickTranscriptDisplay'
export function readQuickTranscriptDisplay(): TranscriptDisplayMode {
  try {
    const value = localStorage.getItem(key)
    return value === 'translation' || value === 'source' ? value : 'bilingual'
  } catch { return 'bilingual' }
}
export function saveQuickTranscriptDisplay(value: TranscriptDisplayMode) { localStorage.setItem(key, value) }
