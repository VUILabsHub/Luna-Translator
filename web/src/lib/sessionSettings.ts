import { HISTORY_MODE_LABELS as modeLabels } from '@simultrans/core/historyTitle'
// Session settings snapshot (2026-09-05): the technical parameters a consumer
// session ran with, uploaded alongside the history record so support can line
// a recording up with the trace and the client logs. The shape is the open
// JSON contract in docs/session-settings-history-plan.md §二 — the backend only
// enforces a size cap and a key whitelist, so this module owns the Web side of
// the contract and never emits keys outside it.

import {
  FONT_SIZE_LABELS as fontSizeLabels,
  NOISE_PRESET_LABELS as noisePresetLabels,
  PLATFORM_LABELS as platformLabels,
  sessionLabel,
  TRANSLATION_MODEL_LABELS as translationModelLabels,
  TTS_MODEL_LABELS as ttsModelLabels,
  VAD_LOUDNESS_MODE_LABELS as vadLoudnessModeLabels,
  SERVICE_LABELS,
  VOICE_MODE_LABELS as voiceModeLabels,
} from '@simultrans/core/sessionLabels'

export type SessionSettingsPlatform = 'web' | 'ios' | 'android'

export type SessionSettingsClient = {
  platform: SessionSettingsPlatform
  version?: string
  buildSha?: string
}

/** Capture diagnostics reported by the recording client. */
export type SessionSettingsAudio = {
  inputDeviceId?: string
  inputDeviceLabel?: string
  inputDeviceGroupId?: string
  route?: string
  captureSource?: string
  aec?: string
  ns?: string
  scoState?: string
  scoWaitMs?: number
}

export type SessionSettings = {
  client: SessionSettingsClient
  mode: 'solo' | 'duo'
  scene?: 'listen' | 'speak' | 'conversation'
  sourceLanguage?: string
  targetLanguages?: string[]
  translationModel?: string
  ttsModel?: string
  provider?: string
  noisePreset?: string
  service?: string
  echoCancellation?: boolean
  deepFilterNet?: boolean
  vadLoudnessMode?: string
  vadLoudnessThresholdDbfs?: number
  voiceClone?: boolean
  voiceMode?: string
  fontSize?: string
  audio?: SessionSettingsAudio
}

export type BuildSessionSettingsInput = {
  platform?: SessionSettingsPlatform
  version?: string
  buildSha?: string
  mode: 'solo' | 'duo'
  scene?: 'listen' | 'speak' | 'conversation'
  sourceLanguage?: string
  targetLanguages?: string[]
  translationModel?: string
  ttsModel?: string
  provider?: string
  noisePreset?: string
  service?: string
  echoCancellation?: boolean
  deepFilterNet?: boolean
  vadLoudnessMode?: string
  vadLoudnessThresholdDbfs?: number
  voiceClone?: boolean
  voiceMode?: string
  fontSize?: string
  audio?: SessionSettingsAudio
}

function text(value?: string) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed ? trimmed : undefined
}

function flag(value?: boolean) {
  return typeof value === 'boolean' ? value : undefined
}

function number(value?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optional<T>(key: string, value: T | undefined) {
  return value === undefined ? {} : { [key]: value }
}

function audioDiagnostics(audio?: SessionSettingsAudio) {
  if (!audio) return undefined
  const normalized: SessionSettingsAudio = {
    ...optional('inputDeviceId', text(audio.inputDeviceId)),
    ...optional('inputDeviceLabel', text(audio.inputDeviceLabel)),
    ...optional('inputDeviceGroupId', text(audio.inputDeviceGroupId)),
    ...optional('route', text(audio.route)),
    ...optional('captureSource', text(audio.captureSource)),
    ...optional('aec', text(audio.aec)),
    ...optional('ns', text(audio.ns)),
    ...optional('scoState', text(audio.scoState)),
    ...optional('scoWaitMs', number(audio.scoWaitMs)),
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined
}

/**
 * buildSessionSettings normalises the live showcase state into the upload
 * contract: empty strings and undefined values are dropped so the stored JSON
 * stays small and a missing setting reads as "not recorded" instead of "off".
 */
export function buildSessionSettings(input: BuildSessionSettingsInput): SessionSettings {
  const targetLanguages = (input.targetLanguages || [])
    .map((language) => text(language))
    .filter((language): language is string => Boolean(language))
  return {
    client: {
      platform: input.platform || 'web',
      ...optional('version', text(input.version)),
      ...optional('buildSha', text(input.buildSha)),
    },
    mode: input.mode,
    ...(['listen', 'speak', 'conversation'].includes(input.scene || '') ? { scene: input.scene } : {}),
    ...optional('sourceLanguage', text(input.sourceLanguage)),
    ...(targetLanguages.length > 0 ? { targetLanguages } : {}),
    ...optional('translationModel', text(input.translationModel)),
    ...optional('ttsModel', text(input.ttsModel)),
    ...optional('provider', text(input.provider)),
    ...optional('noisePreset', text(input.noisePreset)),
    ...optional('service', text(input.service)),
    ...optional('echoCancellation', flag(input.echoCancellation)),
    ...optional('deepFilterNet', flag(input.deepFilterNet)),
    ...optional('vadLoudnessMode', text(input.vadLoudnessMode)),
    ...optional('vadLoudnessThresholdDbfs', number(input.vadLoudnessThresholdDbfs)),
    ...optional('voiceClone', flag(input.voiceClone)),
    ...optional('voiceMode', text(input.voiceMode)),
    ...optional('fontSize', text(input.fontSize)),
    ...optional('audio', audioDiagnostics(input.audio)),
  }
}

// ---------------------------------------------------------------------------
// Chinese labels. 这张表已下沉到 `@simultrans/core/sessionLabels`，Web 与 App
// 共用同一份（settings-x1 / x7）：改文案只改 core，不要在这里就地写字面量。
// ---------------------------------------------------------------------------

const labelled = sessionLabel

export const sessionSettingsModeLabel = (value?: string) => labelled(modeLabels, value)
export const sessionSettingsTranslationModelLabel = (value?: string) => labelled(translationModelLabels, value)
export const sessionSettingsTTSModelLabel = (value?: string) => labelled(ttsModelLabels, value)
export const sessionSettingsNoisePresetLabel = (value?: string) => labelled(noisePresetLabels, value)
export const sessionSettingsServiceLabel = (value?: string) => labelled(SERVICE_LABELS, value)
export const sessionSettingsVoiceModeLabel = (value?: string) => labelled(voiceModeLabels, value)
export const sessionSettingsFontSizeLabel = (value?: string) => labelled(fontSizeLabels, value)

export const sessionSettingsToggleLabel = (value?: boolean) => (
  typeof value === 'boolean' ? (value ? '开启' : '关闭') : undefined
)

/** 响度门控 collapses the mode and its threshold into one readable cell. */
export function sessionSettingsLoudnessLabel(mode?: string, thresholdDbfs?: number) {
  const modeLabel = labelled(vadLoudnessModeLabels, mode)
  const threshold = number(thresholdDbfs)
  if (modeLabel && threshold !== undefined) return `${modeLabel} · ${threshold} dBFS`
  if (modeLabel) return modeLabel
  return threshold === undefined ? undefined : `${threshold} dBFS`
}

/** 客户端版本 reads as "Web · 1.0 (2) · 38f0593", skipping the parts not reported. */
export function sessionSettingsClientLabel(client?: SessionSettingsClient) {
  if (!client) return undefined
  const parts = [
    platformLabels[client.platform] || text(client.platform),
    text(client.version),
    text(client.buildSha),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** 音频 folds the App-only diagnostics into one line; Web sessions omit it. */
export function sessionSettingsAudioLabel(audio?: SessionSettingsAudio) {
  if (!audio) return undefined
  const parts = [
    text(audio.route) && `链路 ${text(audio.route)}`,
    text(audio.captureSource) && `采集源 ${text(audio.captureSource)}`,
    text(audio.aec) && `AEC ${text(audio.aec)}`,
    text(audio.ns) && `NS ${text(audio.ns)}`,
    text(audio.scoState) && `SCO ${text(audio.scoState)}`,
    number(audio.scoWaitMs) !== undefined && `SCO 等待 ${audio.scoWaitMs}ms`,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : undefined
}
