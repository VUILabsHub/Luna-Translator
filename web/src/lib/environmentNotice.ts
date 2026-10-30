// 手机浏览器「环境提示」弹窗的展示节流：每天最多弹一次；勾选「以后不再提示」后不再弹。
// 只在开始同传前调用；日期按设备本地时区计算，跨天即重新提示。

export const environmentNoticeStorageKey = 'simultrans.showcaseEnvironmentNotice'

export type EnvironmentNoticeState = {
  /** 最近一次展示的本地日期（YYYY-MM-DD）。 */
  shownOn?: string
  /** 用户勾选了「以后不再提示」。 */
  suppressed?: boolean
}

export function localDayKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 今天还没弹过且没被永久关闭时才需要提示。 */
export function shouldShowEnvironmentNotice(state: EnvironmentNoticeState | null | undefined, now: Date): boolean {
  if (!state) return true
  if (state.suppressed) return false
  return state.shownOn !== localDayKey(now)
}

/** 用户点了「确认」之后的新状态；suppress 为真表示勾选了「以后不再提示」。 */
export function environmentNoticeAcknowledged(state: EnvironmentNoticeState | null | undefined, now: Date, suppress: boolean): EnvironmentNoticeState {
  const next: EnvironmentNoticeState = { shownOn: localDayKey(now) }
  if (suppress || state?.suppressed) next.suppressed = true
  return next
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function readEnvironmentNoticeState(storage: StorageLike | undefined = defaultStorage()): EnvironmentNoticeState | null {
  try {
    const value = JSON.parse(storage?.getItem(environmentNoticeStorageKey) || 'null') as unknown
    return value && typeof value === 'object' ? value as EnvironmentNoticeState : null
  } catch {
    return null
  }
}

export function writeEnvironmentNoticeState(state: EnvironmentNoticeState, storage: StorageLike | undefined = defaultStorage()) {
  try {
    storage?.setItem(environmentNoticeStorageKey, JSON.stringify(state))
  } catch { /* 存储不可用时本次会话内照常提示。 */ }
}
