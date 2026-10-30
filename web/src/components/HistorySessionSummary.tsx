import type { ReactNode } from 'react'
import { historyDisplayTitle, historySceneLabel, type HistoryTitleContext } from '@simultrans/core/historyTitle'
import { historyShortTitle } from '../lib/historyTitle'

export function HistorySessionSummary({ context, duration, children }: {
  context: HistoryTitleContext
  duration?: string
  children?: ReactNode
}) {
  // 用户 2026-10-21 标题最多 13 个字：Canary 上老长标题显示前 13 个字加「…」，悬停仍给完整标题；prod 两者相同。
  const title = historyShortTitle(context)
  return (
    <div className="showcase-finished-summary showcase-history-summary" aria-label="本次同传概要">
      <strong title={historyDisplayTitle(context)}>{title}</strong>
      <span>{historySceneLabel(context)}{duration && <> · {duration}</>}{children && <> · {children}</>}</span>
    </div>
  )
}
