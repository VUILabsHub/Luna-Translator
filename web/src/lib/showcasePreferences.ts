import { omniTargetLanguages } from '@simultrans/ui-shared/src/languageCapabilities'

const storageKey = 'simultrans.showcasePreferences.v1'
const targetCodes = new Set(omniTargetLanguages.map(({ code }) => code))
export const showcaseSourceLanguages = ['zh', 'en', 'ja', 'ko']

export function normalizeShowcaseSourceLanguage(value: string | undefined, fallback = 'zh'): string {
  return showcaseSourceLanguages.includes(value || '') ? value! : fallback
}

export type LanguagePreferences = {
  sourceLanguage: string
  targetLanguages: string[]
  primaryLanguage: string
}

type ShowcasePreferences = {
  mode?: 'solo' | 'duo'
  solo?: LanguagePreferences
  duoLeft?: LanguagePreferences
  duoRight?: LanguagePreferences
}

function readLanguages(value: unknown, fallback = 'zh'): LanguagePreferences | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<LanguagePreferences>
  const targetLanguages = Array.isArray(candidate.targetLanguages)
    ? [...new Set(candidate.targetLanguages.filter((code) => typeof code === 'string' && targetCodes.has(code)))]
    : []
  if (!targetLanguages.length) return undefined
  return {
    sourceLanguage: normalizeShowcaseSourceLanguage(candidate.sourceLanguage, fallback),
    targetLanguages,
    primaryLanguage: targetLanguages.includes(candidate.primaryLanguage || '') ? candidate.primaryLanguage! : targetLanguages[0],
  }
}

export function readShowcasePreferences(): ShowcasePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}')
    if (!value || typeof value !== 'object') return {}
    return {
      mode: value.mode === 'solo' || value.mode === 'duo' ? value.mode : undefined,
      solo: readLanguages(value.solo),
      duoLeft: readLanguages(value.duoLeft),
      duoRight: readLanguages(value.duoRight, 'en'),
    }
  } catch {
    return {}
  }
}

export function writeShowcasePreferences(value: ShowcasePreferences) {
  try {
    localStorage.setItem(storageKey, JSON.stringify({ ...readShowcasePreferences(), ...value }))
  } catch { /* The current page remains usable when browser storage is unavailable. */ }
}

/** Shrink old selections without dropping the user's primary output. */
export function limitShowcaseTargets(targets: string[], primary: string, limit: number): string[] {
  const unique = [...new Set(targets)]
  if (unique.length <= limit) return targets
  const kept = unique.slice(0, limit)
  if (unique.includes(primary) && !kept.includes(primary)) kept[kept.length - 1] = primary
  return kept
}
