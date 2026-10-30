import { omniTargetLanguages } from '@simultrans/ui-shared/src/languageCapabilities'

export type WebHomeMode = 'solo' | 'listen' | 'speak' | 'conversation' | 'meeting'
export type WebSceneMode = 'listen' | 'speak' | 'conversation'

// Keep legacy scene data readable while limiting all product entry points to
// the current release's three modes. History/share records keep their labels.
export const HOME_MODE_OPTIONS = [
  { value: 'solo', label: '快速开始', icon: 'quick-start' },
  { value: 'meeting', label: '会议', icon: 'meeting' },
  { value: 'conversation', label: '对话', icon: 'conversation' },
] as const

export function isVisibleHomeMode(value: unknown): value is typeof HOME_MODE_OPTIONS[number]['value'] {
  return HOME_MODE_OPTIONS.some(option => option.value === value)
}

export function isHiddenHomeScene(value: unknown): value is 'listen' | 'speak' {
  return value === 'listen' || value === 'speak'
}

/** Hidden legacy scenes never restore an active product view; storage is left intact. */
export function productHomeScene(requested: string | null, restored?: WebSceneMode): 'conversation' | undefined {
  return (requested || restored) === 'conversation' ? 'conversation' : undefined
}

export function canonicalProductHomeURL(href: string): URL {
  const url = new URL(href)
  if (isHiddenHomeScene(url.searchParams.get('mode'))) url.searchParams.delete('mode')
  return url
}

type SceneCopy = {
  title: string
  subtitle: string
  startLabel: string
  sourceLanguage: 'auto'
  targetLanguages: string[]
}

/** Scene defaults are independent of the base single-microphone preferences. */
export const SCENE_COPY: Record<WebSceneMode, SceneCopy> = {
  listen: {
    title: '我听别人说',
    subtitle: '会议 · 课堂 · 直播',
    startLabel: '开始同传听话',
    sourceLanguage: 'auto',
    targetLanguages: ['en'],
  },
  speak: {
    title: '我说给大家',
    subtitle: '宣讲 · 直播销售',
    startLabel: '开始同传说话',
    sourceLanguage: 'auto',
    targetLanguages: ['en'],
  },
  conversation: {
    title: '我和别人聊',
    subtitle: '旅游 · 洽谈 · 面对面',
    startLabel: '开始对话',
    sourceLanguage: 'auto',
    targetLanguages: ['en', 'zh'],
  },
}

export type SceneLanguagePreferences = {
  sourceLanguage: string
  targetLanguages: string[]
  primaryLanguage: string
}

const sceneStoragePrefix = 'simultrans.homeScenePreferences.v1:'
const sourceCodes = new Set(['auto', 'zh', 'en', 'ja', 'ko'])
const targetCodes = new Set(omniTargetLanguages.map(language => language.code))

function normalizeScenePreferences(scene: WebSceneMode, value: unknown): SceneLanguagePreferences {
  const candidate = value && typeof value === 'object' ? value as Partial<SceneLanguagePreferences> : {}
  const validTargets = Array.isArray(candidate.targetLanguages)
    ? [...new Set(candidate.targetLanguages.filter(code => typeof code === 'string' && targetCodes.has(code)
      && (scene !== 'conversation' || ['zh', 'en', 'ja', 'ko'].includes(code))))]
    : []
  const targetLanguages = scene === 'conversation'
    ? validTargets.length >= 2 ? validTargets.slice(0, 2) : [...SCENE_COPY[scene].targetLanguages]
    : validTargets.length ? validTargets : [...SCENE_COPY[scene].targetLanguages]
  return {
    sourceLanguage: scene !== 'conversation' && typeof candidate.sourceLanguage === 'string' && sourceCodes.has(candidate.sourceLanguage)
      ? candidate.sourceLanguage : 'auto',
    targetLanguages,
    primaryLanguage: typeof candidate.primaryLanguage === 'string' && targetLanguages.includes(candidate.primaryLanguage)
      ? candidate.primaryLanguage : targetLanguages[0],
  }
}

/** Each scene has its own key; reading or updating it never modifies solo preferences. */
export function readScenePreferences(scene: WebSceneMode): SceneLanguagePreferences {
  try { return normalizeScenePreferences(scene, JSON.parse(localStorage.getItem(`${sceneStoragePrefix}${scene}`) || 'null')) }
  catch { return normalizeScenePreferences(scene, null) }
}

export function writeScenePreferences(scene: WebSceneMode, value: SceneLanguagePreferences): void {
  try { localStorage.setItem(`${sceneStoragePrefix}${scene}`, JSON.stringify(normalizeScenePreferences(scene, value))) }
  catch { /* The current session remains usable when browser storage is unavailable. */ }
}
