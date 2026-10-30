import { MEETING_NOISE_REDUCTION_THRESHOLD_DBFS, isMeetingNoiseReduction, type MeetingNoiseReduction } from '@simultrans/core/meeting'

export const QUICK_AUDIO_KEY = 'simultrans.quickAudio'
export type QuickAudioPreferences = { volume: number; noiseReduction: MeetingNoiseReduction }
export function normalizeQuickAudio(value: unknown): QuickAudioPreferences {
  const data = value as Partial<QuickAudioPreferences> | null
  return {
    volume: typeof data?.volume === 'number' && Number.isFinite(data.volume) ? Math.max(0, Math.min(100, Math.round(data.volume))) : 100,
    noiseReduction: isMeetingNoiseReduction(data?.noiseReduction) ? data.noiseReduction : 'default',
  }
}
export function readQuickAudio(): QuickAudioPreferences {
  try { return normalizeQuickAudio(JSON.parse(localStorage.getItem(QUICK_AUDIO_KEY) || '{}')) }
  catch { return normalizeQuickAudio(null) }
}
export function saveQuickAudio(value: QuickAudioPreferences): void {
  localStorage.setItem(QUICK_AUDIO_KEY, JSON.stringify(normalizeQuickAudio(value)))
}
export function quickNoiseThreshold(level: MeetingNoiseReduction): -45 | -40 | -35 {
  return MEETING_NOISE_REDUCTION_THRESHOLD_DBFS[level] as -45 | -40 | -35
}
