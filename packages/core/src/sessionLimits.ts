// 会话时限与「最后 N 秒」倒计时的唯一真相（Web 与 React Native 共用）。
//
// 后端 backend/server/server.go 的 maxSessionDuration 是权威值；会话开始时它以
// `{"type":"session_started","timeLimitMs":…,"startedAtMs":…}` 下发（协议见
// docs/protocol/realtime-text-sync-v1.md §2.3）。这里的常量只是「没收到帧」
// 时的兜底，改动后必须与后端同步。
//
// 这个文件只放纯函数：不碰计时器、不碰 DOM/RN，两端各自在 hook 里 tick。

/** 单场会话的硬时限，对齐后端 maxSessionDuration = 15 * time.Minute。 */
export const SESSION_TIME_LIMIT_MS = 15 * 60 * 1000

/** 会话结束前多久开始提醒用户（最后 10 秒）。 */
export const SESSION_ENDING_REMINDER_MS = 10 * 1000

export type SessionEndsAtInput = {
  /** 会话开始的墙钟时间（Unix ms）。非正数 / 非有限值视为「会话未开始」。 */
  startedAtMs: number | null | undefined
  /** 服务端下发的时限；缺省或非正数时回落到 SESSION_TIME_LIMIT_MS。 */
  timeLimitMs?: number | null
  /** 会话开始时的今日剩余额度（分钟）；未知时只看时限。 */
  quotaRemainingMinutes?: number | null
}

export type SessionEndingCountdown = {
  /** 是否处在「最后 SESSION_ENDING_REMINDER_MS」的提醒窗口内。 */
  visible: boolean
  /** 提醒窗口内剩余整秒（10 → 0）；窗口外恒为 0。 */
  secondsLeft: number
}

function positiveFinite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 会话的预期结束时刻（Unix ms）：时限与今日额度两者取更早的一个。
 *
 * - 额度未知（null / undefined / 非有限值）→ 只看时限；
 * - 额度已知但 ≤ 0 → 结束时刻就是开始时刻（额度已耗尽，服务端会立刻切断）；
 * - 会话未开始 → null。
 */
export function sessionEndsAt(input: SessionEndsAtInput): number | null {
  const startedAtMs = positiveFinite(input.startedAtMs)
  if (startedAtMs === null) return null
  const limitMs = positiveFinite(input.timeLimitMs) ?? SESSION_TIME_LIMIT_MS
  const limitEndsAt = startedAtMs + limitMs
  const quotaMinutes = input.quotaRemainingMinutes
  if (typeof quotaMinutes !== 'number' || !Number.isFinite(quotaMinutes)) return limitEndsAt
  const quotaEndsAt = startedAtMs + Math.max(0, quotaMinutes) * 60_000
  return Math.min(limitEndsAt, quotaEndsAt)
}

/**
 * 倒计时状态。最后 SESSION_ENDING_REMINDER_MS 内可见，逐秒递减到 0；
 * 越过结束时刻（或结束时刻未知）后不可见。
 */
export function sessionEndingCountdown(
  endsAtMs: number | null | undefined,
  nowMs: number,
): SessionEndingCountdown {
  if (typeof endsAtMs !== 'number' || !Number.isFinite(endsAtMs)) return { visible: false, secondsLeft: 0 }
  if (!Number.isFinite(nowMs)) return { visible: false, secondsLeft: 0 }
  const remainingMs = endsAtMs - nowMs
  if (remainingMs < 0 || remainingMs > SESSION_ENDING_REMINDER_MS) return { visible: false, secondsLeft: 0 }
  const secondsLeft = Math.min(
    Math.ceil(SESSION_ENDING_REMINDER_MS / 1000),
    Math.max(0, Math.ceil(remainingMs / 1000)),
  )
  return { visible: true, secondsLeft }
}

/** 提醒文案（两端一字不差）。 */
export function sessionEndingReminderText(secondsLeft: number): string {
  return `本次同传将在 ${Math.max(0, Math.trunc(secondsLeft))} 秒后自动结束`
}
