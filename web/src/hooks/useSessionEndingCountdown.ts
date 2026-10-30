// 会话结束前最后 10 秒的提醒文案（Web 侧）。
//
// 结束时刻由 useMultilingualRealtimeSession 的 sessionEndsAtMs 给出（服务端
// session_started 帧优先，收不到帧时用本地开始时间 + SESSION_TIME_LIMIT_MS）；
// 判定规则与 mobile 共用 @simultrans/core/sessionLimits 的纯函数。
//
// 只在窗口内 tick：会话中途不挂任何定时器，也不做常驻计时展示。
import { useEffect, useState } from 'react'
import {
  sessionEndingCountdown,
  sessionEndingReminderText,
  type SessionEndingCountdown,
} from '@simultrans/core/sessionLimits'

const HIDDEN: SessionEndingCountdown = { visible: false, secondsLeft: 0 }

/** 双人页：两路会话取更早的结束时刻；都没有则 null。 */
export function earliestSessionEndsAt(...candidates: Array<number | null | undefined>): number | null {
  let earliest: number | null = null
  for (const value of candidates) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (earliest === null || value < earliest) earliest = value
  }
  return earliest
}

export function useSessionEndingCountdown(
  endsAtMs: number | null | undefined,
  active: boolean,
): SessionEndingCountdown & { notice: string | undefined } {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const armed = active && typeof endsAtMs === 'number' && Number.isFinite(endsAtMs)

  useEffect(() => {
    if (!armed) return undefined
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [armed, endsAtMs])

  const state = armed ? sessionEndingCountdown(endsAtMs, nowMs) : HIDDEN
  return {
    ...state,
    notice: state.visible ? sessionEndingReminderText(state.secondsLeft) : undefined,
  }
}
