import type { AudioDeviceOption } from '@simultrans/ui-shared/src/useAudioDevices'
import type { MeetingNoiseReduction } from '@simultrans/core/meeting'
import type { TranscriptDisplayMode } from './transcriptDisplay'
import type { ShowcaseComboboxOption } from '../components/ShowcaseCombobox'

export type ConversationSide = 'top' | 'bottom'
export type ConversationSidePreferences = { language: string; inputDeviceId: string; outputDeviceId: string; volume: number; displayMode: TranscriptDisplayMode; noiseReduction: MeetingNoiseReduction }
export type ConversationPreferences = Record<ConversationSide, ConversationSidePreferences>
export const CONVERSATION_PREFERENCES_KEY = 'simultrans.conversationSettings.v1'
export const oppositeConversationSide = (side: ConversationSide): ConversationSide => side === 'top' ? 'bottom' : 'top'
export const CONVERSATION_LANGUAGE_OPTIONS = [
  { value: 'zh', label: '中文' }, { value: 'en', label: 'English' },
]
export const conversationVolume = (value: number) => Math.min(100, Math.max(0, Math.round(Number.isFinite(value) ? value : 100)))
export function readConversationPreferences(): { sides: ConversationPreferences; noise: MeetingNoiseReduction } {
  let saved: any = {}
  try { saved = JSON.parse(localStorage.getItem(CONVERSATION_PREFERENCES_KEY) || '{}') || {} } catch { /* use defaults */ }
  const side = (key: ConversationSide, language: string): ConversationSidePreferences => ({
    language: CONVERSATION_LANGUAGE_OPTIONS.some(option => option.value === saved[key]?.language) ? saved[key].language : language,
    // Devices are a physical-session choice; never revive stale browser IDs.
    inputDeviceId: 'default', outputDeviceId: 'default', volume: conversationVolume(saved[key]?.volume),
    displayMode: ['source', 'translation', 'bilingual'].includes(saved[key]?.displayMode) ? saved[key].displayMode : 'bilingual',
    noiseReduction: ['weak', 'default', 'strong'].includes(saved[key]?.noiseReduction) ? saved[key].noiseReduction : saved.noise === 'weak' || saved.noise === 'strong' ? saved.noise : 'default',
  })
  const sides = { top: side('top', 'en'), bottom: side('bottom', 'zh') }
  if (sides.top.language === sides.bottom.language) sides.top.language = sides.bottom.language === 'en' ? 'zh' : 'en'
  return { sides, noise: saved.noise === 'weak' || saved.noise === 'strong' ? saved.noise : 'default' }
}
export function saveConversationPreferences(sides: ConversationPreferences, noise?: MeetingNoiseReduction) {
  const saved = Object.fromEntries((['top', 'bottom'] as const).map(side => {
    const { language, volume, displayMode, noiseReduction } = sides[side]
    return [side, { language, volume: conversationVolume(volume), displayMode, noiseReduction: noiseReduction || noise || 'default' }]
  }))
  try { localStorage.setItem(CONVERSATION_PREFERENCES_KEY, JSON.stringify({ ...saved, noise })) } catch { /* live settings still work */ }
}
export function conversationDeviceOptions(devices: AudioDeviceOption[], selected: string, kind: 'input' | 'output', defaultLabel = ''): ShowcaseComboboxOption[] {
  const options: ShowcaseComboboxOption[] = [{ value: 'default', label: defaultLabel || (kind === 'input' ? '跟随系统麦克风' : '跟随系统输出') }, ...devices.map(device => ({ value: device.deviceId, label: device.label }))]
  if (selected !== 'default' && !options.some(option => option.value === selected)) options.push({ value: selected, label: '所选设备（已断开）', disabled: true })
  return options
}
export function conversationTurnRoute(sides: ConversationPreferences, speaker: ConversationSide, outputSupported: boolean) {
  const receiver = oppositeConversationSide(speaker)
  return { speaker, receiver, sourceLanguage: sides[speaker].language, targetLanguage: sides[receiver].language, inputDeviceId: sides[speaker].inputDeviceId,
    outputDeviceId: outputSupported ? sides[receiver].outputDeviceId : 'default', playbackVolume: conversationVolume(sides[receiver].volume) / 100 }
}
/** Embed the real server turn ID without adding an unsupported history field. */
export const conversationHistoryRowId = (sessionId: string, rowId: string) => `conversation-turn/${encodeURIComponent(sessionId)}/${rowId}`
export function conversationHistoryRowSessionId(rowId: string, sessionIds: readonly string[]): string | undefined {
  const match = /^conversation-turn\/([^/]+)\//.exec(rowId)
  if (!match) return undefined
  try { const id = decodeURIComponent(match[1]); return sessionIds.includes(id) ? id : undefined } catch { return undefined }
}
