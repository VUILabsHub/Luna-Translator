// 用户 2026-10-21：历史记录标题最多 13 个字。后端对新标题一律收在 13 个字以内（consumerstore
// HistoryTitleMaxRunes = 13）：AI 标题的提示词要 ≤13 个字、答长了按标点截；用户改名超过 13 个字直接 400。
// 按旧上限 28 存下的老标题不改写、照旧下发——Web 显示时截成前 13 个字加「…」，与 App
// （mobile/src/lib/historyTitle displayTitle）同一条规则。上限与截断都在 core（packages/core historyTitle.ts
// HISTORY_TITLE_MAX / clampHistoryTitle），这里只决定截不截。
//
// 只在 Canary 主机截（canaryDesignEnabled，与 App 只在 canary 环境截同口径）；prod 照旧显示 core
// historyDisplayTitle 不截的结果（≤28 个字）。Web 没有改名入口，这里只管展示。
import { historyDisplayTitle, type HistoryTitleContext } from '@simultrans/core/historyTitle'
import { canaryDesignEnabled } from './canaryDesign'

/**
 * 历史卡片、详情与分享页显示的标题：先走 core 的清洗与兜底（换行、零宽字符变空格，
 * 空标题、旧引擎名换成场景默认标题），clamp 时再截到 13 个字加「…」。clamp 默认跟 Canary 主机走。
 */
export function historyShortTitle(context: HistoryTitleContext, clamp = canaryDesignEnabled()): string {
  return historyDisplayTitle(context, clamp)
}
