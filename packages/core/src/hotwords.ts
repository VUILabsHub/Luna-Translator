// 热词三档（无 / 默认配置 / 自定义配置）。
//
// 来源是 Web `web/src/lib/showcaseHotwords.ts`（d782f94），逐字搬进 core 供
// 两端共用。**词序是有意义的**：后端 `backend/core/brand_defaults.go` 的常量是
// `VUI Labs、宇生月伴、数贸会`，Web 默认档是 `宇生月伴、VUI Labs、数贸会`，
// 而 `backend/providers/qwen3asr/hotword_echo.go` 的回声过滤按顺序比较，所以
// 「跟 Web 一致」只能是逐字抄下面这一份，不能改成后端常量的顺序。
//
// Web 侧 `web/src/lib/showcaseHotwords.ts` 现在只是这里的 re-export + 落盘字段名
// 适配（`hotwordMode`/`qwen3SimulSystemPrompt` → `mode`/`prompt`），常量与
// `selectHotwordMode` 不再有第二份。要改默认档，改这里。

export type HotwordMode = 'none' | 'default' | 'custom'

export type HotwordSelection = {
  mode: HotwordMode
  asrContext: string
  prompt: string
}

/** 不带热词时的基准翻译 prompt（Web `baseTranslationPrompt`）。 */
export const baseTranslationPrompt = 'Translate into {target}.'

/** Web 默认档的 ASR 热词串（词序与 Web 完全一致）。 */
export const defaultASRHotwords = '宇生月伴、VUI Labs、数贸会'

/** Web 默认档的翻译 prompt（含品牌固定译法）。 */
export const defaultHotwordPrompt =
  'Translate into {target}, using these fixed translations for hotwords:{宇生月伴(公司名)->VUI Labs, 全球数字贸易博览会->Global Digital Trade Expo,西湖-> West Lake}.'

/** 三档选择（Web `selectHotwordMode`）。 */
export function selectHotwordMode(mode: HotwordMode, current: HotwordSelection): HotwordSelection {
  if (mode === 'none') return { mode, asrContext: '', prompt: baseTranslationPrompt }
  if (mode === 'default') return { mode, asrContext: defaultASRHotwords, prompt: defaultHotwordPrompt }
  return { ...current, mode }
}

/**
 * 移动端当前固定采用的档位：Web 的「默认配置」。
 * 与 Web 一样恒发 `asrContextOverride: true`，让服务端用这一份而不是它自己的
 * 加性默认热词（`brand_defaults.go`）。
 */
export const defaultHotwordSelection: HotwordSelection = selectHotwordMode('default', {
  mode: 'default',
  asrContext: defaultASRHotwords,
  prompt: defaultHotwordPrompt,
})

/** 翻译 prompt 的字符上限（后端 `core.ValidateSystemPrompt`：2000 字符）。 */
export const MAX_HOTWORD_PROMPT_LENGTH = 2000

/** ASR 热词串的字符上限（客户端自设，避免把整段会议纪要塞进 start 帧）。 */
export const MAX_ASR_CONTEXT_LENGTH = 512

/**
 * 后端 `ValidateSystemPrompt` 的客户端预检：超长或含角色特殊记号一律拒绝，
 * 免得等到 start 之后才被服务端整场拒连。
 */
export function isValidHotwordPrompt(prompt: string): boolean {
  return (
    [...prompt].length <= MAX_HOTWORD_PROMPT_LENGTH
    && !prompt.includes('<|')
    && !prompt.includes('\u0000')
  )
}

/**
 * 落盘值 → 三档选择（Web `readShowcaseHotwords` 的同一套语义，含老值迁移）：
 * 没有 mode 字段的旧记录，若带着自定义热词 / prompt 就认作 custom，否则回默认档。
 */
export function normalizeHotwordSelection(stored: {
  mode?: unknown
  asrContext?: unknown
  prompt?: unknown
}): HotwordSelection {
  const current: HotwordSelection = {
    mode: 'custom',
    asrContext: typeof stored.asrContext === 'string' ? stored.asrContext : '',
    prompt: typeof stored.prompt === 'string' ? stored.prompt : baseTranslationPrompt,
  }
  if (stored.mode === 'none' || stored.mode === 'default' || stored.mode === 'custom') {
    return selectHotwordMode(stored.mode, current)
  }
  const legacyCustom =
    current.asrContext.trim() !== ''
    || (current.prompt.trim() !== '' && current.prompt !== baseTranslationPrompt)
  return legacyCustom ? current : selectHotwordMode('default', current)
}
