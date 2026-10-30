// 设置目录（GET /api/settings/catalog）：设置面板的选项、文案、默认值与路由映射由后端下发，
// 契约见 backend/server/settings_catalog.go 与 docs/settings-catalog-plan.md。
// Web 内置了一份同构的兜底数据（showcaseSettingsInfo / MultilingualShowcasePage 的选项表），
// 目录拉到后按 id 覆盖标签与说明；拉不到时界面照常工作。
import { useEffect, useState } from 'react'
import { apiFetch } from '@simultrans/ui-shared/src/lib/apiFetch'
import type { ShowcaseSettingsInfo, ShowcaseSettingsInfoTopic } from './showcaseSettingsInfo'

export type SettingsCatalogOption = {
  id: string
  label: string
  default?: boolean
  /** 该选项当前不可选（例如健康检查不通过）：下拉里置灰、不允许选中。 */
  disabled?: boolean
  /** 置灰原因（可展示在标签后面）。 */
  disabledReason?: string
}

/**
 * 目录下发的语言选项（2026-09-05.3 新增）。结构与移动端内置表一致
 * （mobile/src/session/languages.ts 的 LanguageOption）：code = 语言码、
 * label = 单字标签、name = 中文全名、native = 该语言自称。
 * Web 目前仍渲染自己的 omniTargetLanguages，这里只做类型同步。
 */
export type SettingsCatalogLanguage = { code: string; label: string; name: string; native: string   /** 仅这些翻译模型可选（日 / 韩输入只对 Pro 开放）；缺省 = 全部。 */
  models?: string[]
}
export type SettingsCatalogRoute = { translationModel: string; ttsModel: string; providerId: string }
export type SettingsCatalogNoisePreset = SettingsCatalogOption & {
  deepFilterNet: boolean
  vadLoudnessMode: 'frame_rms' | 'p90_400ms'
  vadLoudnessThresholdDbfs: number
  webService: 'websocket' | 'volc-rtc'
  webEchoCancellation: boolean
  nativeNoiseSuppressor: boolean
  nativeEchoCancel: boolean
  /** 原生采集链路：App 用系统通话链路 / 识别链路；Web 的 'phone-call' 档用 voice-call 表示请求浏览器 AEC·NS·AGC。 */
  captureMode?: 'voice-call' | 'recognition'
  /** 该预设在哪些端展示；缺省 = 全部。 */
  platforms?: string[]
}

/** 目录里对 Web 可见的降噪预设（platforms 缺省 = 全部；'phone-call' 需要列出 web 才对 Web 可见）。 */
export function webNoisePresets(catalog: SettingsCatalog | null): SettingsCatalogNoisePreset[] {
  return (catalog?.noisePresets ?? []).filter((preset) => !preset.platforms || preset.platforms.includes('web'))
}
export type SettingsCatalog = {
  version: string
  defaults: {
    translationModel: string
    ttsModel: string
    noisePreset: string
    fontSize: string
    /** 各端默认降噪预设（ios / android / web-mobile）；Web 手机浏览器默认手机通话模式。 */
    noisePresetByPlatform?: Record<string, string>
  }
  translationModels: SettingsCatalogOption[]
  ttsModels: SettingsCatalogOption[]
  routes: SettingsCatalogRoute[]
  noisePresets: SettingsCatalogNoisePreset[]
  fontSizes: SettingsCatalogOption[]
  /** 输入语言（auto / zh / en）；缺省时客户端回落内置表。 */
  sourceLanguages?: SettingsCatalogLanguage[]
  /** 输出语言（18 种）；缺省时客户端回落内置表。 */
  targetLanguages?: SettingsCatalogLanguage[]
  /** 同时输出的语言路数上限（Web 与 App 均为 4）；缺省时回落内置常量。 */
  maxTargetLanguages?: number
  /** 单麦路数上限：生产为 2，其他环境与双麦保留原上限。 */
  maxSoloTargetLanguages?: number
  info: Partial<Record<ShowcaseSettingsInfoTopic, ShowcaseSettingsInfo>>
}

const storageKey = 'simultrans.settingsCatalog'
let cached: SettingsCatalog | null = null
let inflight: Promise<SettingsCatalog | null> | null = null
const listeners = new Set<() => void>()

function isCatalog(value: unknown): value is SettingsCatalog {
  const catalog = value as SettingsCatalog | null
  return Boolean(catalog && typeof catalog.version === 'string' && Array.isArray(catalog.translationModels)
    && Array.isArray(catalog.ttsModels) && Array.isArray(catalog.noisePresets) && catalog.info && typeof catalog.info === 'object')
}

function readStoredCatalog(): SettingsCatalog | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null') as unknown
    return isCatalog(value) ? value : null
  } catch {
    return null
  }
}

function remember(catalog: SettingsCatalog) {
  cached = catalog
  try { localStorage.setItem(storageKey, JSON.stringify(catalog)) } catch { /* 仅内存缓存。 */ }
  listeners.forEach((listener) => listener())
}

/** 当前已知的目录（内存 → localStorage），没有则 null。 */
export function getSettingsCatalog(): SettingsCatalog | null {
  if (!cached) cached = readStoredCatalog()
  return cached
}

/** 拉取目录；失败返回已缓存的版本（可能为 null），绝不抛出。 */
export async function fetchSettingsCatalog(): Promise<SettingsCatalog | null> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const response = await apiFetch('/api/settings/catalog')
      if (!response.ok) return getSettingsCatalog()
      const value = await response.json() as unknown
      if (!isCatalog(value)) return getSettingsCatalog()
      if (value.version !== cached?.version) remember(value)
      return value
    } catch {
      return getSettingsCatalog()
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 订阅目录变化并在挂载时拉一次；返回当前目录（可能为 null）。 */
export function useSettingsCatalog(): SettingsCatalog | null {
  const [catalog, setCatalog] = useState<SettingsCatalog | null>(getSettingsCatalog)
  useEffect(() => {
    const listener = () => setCatalog(getSettingsCatalog())
    listeners.add(listener)
    void fetchSettingsCatalog().then(listener)
    return () => { listeners.delete(listener) }
  }, [])
  return catalog
}

/** 按 id 取目录里的标签；目录没有该项时返回 undefined（调用方回落内置文案）。 */
export function settingsCatalogLabel(catalog: SettingsCatalog | null, list: 'translationModels' | 'ttsModels' | 'noisePresets' | 'fontSizes', id: string): string | undefined {
  return catalog?.[list]?.find((option) => option.id === id)?.label
}

/** 用目录标签覆盖一组下拉选项（id 不在目录里的保留内置标签）。 */
// 注：降噪下拉的选项来自 Web 自己的内置表（showcaseNoisePresetOptions，'phone-call'
// 只在手机浏览器加入），本函数只按 id 覆盖标签；若将来 Web 改为直接从目录渲染选项，
// 请先用 webNoisePresets() 过滤。
export function withSettingsCatalogLabels<T extends { value: string; label: string }>(catalog: SettingsCatalog | null, list: 'translationModels' | 'ttsModels' | 'noisePresets' | 'fontSizes', options: T[]): T[] {
  if (!catalog) return options
  return options.map((option) => ({ ...option, label: settingsCatalogLabel(catalog, list, option.value) ?? option.label }))
}

/** 仅测试用：清空内存缓存。 */
export function resetSettingsCatalogForTest() {
  cached = null
  inflight = null
}

/** Server catalog wins, including test deployments served on another host. */
export function soloTargetLanguageLimit(catalog: SettingsCatalog | null, hostname = typeof window === 'undefined' ? '' : window.location.hostname): number {
  const limit = catalog?.maxSoloTargetLanguages
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0
    ? Math.min(limit, 4) : hostname === 'simultrans.lunalabs.cn' ? 2 : 4
}
