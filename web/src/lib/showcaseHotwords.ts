// 热词三档（无 / 默认配置 / 自定义配置）：实现在
// `packages/core/src/hotwords.ts`，这里只做 re-export + 字段名适配。
//
// core 那份是 d782f94 从本文件逐字搬过去的（移动端够不着 `web/`），于是同样
// 的三个常量与 `selectHotwordMode` 在仓库里存了两份。**默认热词串的词序是有
// 意义的**：后端 `qwen3asr/hotword_echo.go` 的回声过滤保序比较，两端一旦漂成
// 不同顺序，「Web 能过滤、App 不能」这类问题就无从对照。所以这里改成从 core 取。
//
// 唯一留在 Web 的是落盘字段名的适配：Web 的偏好里存的是
// `hotwordMode` / `asrContext` / `qwen3SimulSystemPrompt`，core 的
// `normalizeHotwordSelection` 收的是中立的 `mode` / `asrContext` / `prompt`。
import { normalizeHotwordSelection, type HotwordMode, type HotwordSelection } from '@simultrans/core/hotwords'

export type { HotwordMode } from '@simultrans/core/hotwords'
export {
  baseTranslationPrompt,
  defaultASRHotwords,
  defaultHotwordPrompt,
  selectHotwordMode,
} from '@simultrans/core/hotwords'

/** Web 侧沿用的名字；形状与 core 的 `HotwordSelection` 完全一致。 */
export type ShowcaseHotwords = HotwordSelection

/** 落盘偏好 → 三档选择（含无 `hotwordMode` 的老值迁移，语义由 core 定义）。 */
export function readShowcaseHotwords(stored: {
  hotwordMode?: HotwordMode
  asrContext?: string
  qwen3SimulSystemPrompt?: string
}): ShowcaseHotwords {
  return normalizeHotwordSelection({
    mode: stored.hotwordMode,
    asrContext: stored.asrContext,
    prompt: stored.qwen3SimulSystemPrompt,
  })
}
