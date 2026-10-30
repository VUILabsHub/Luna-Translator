/**
 * 历史音频回放的倍速档位（finished-09）。
 *
 * Web（`SessionAudioDownloads.tsx`）与移动端（`SessionAudioExports`）以前各写
 * 一套：Web 是 1.0 → 1.25 → 1.5 → 2.0 的四档循环，移动端只有 1x / 2x 一个开关，
 * 而且按钮上印的是「点下去会切到哪一档」而不是当前档位，两端读数正好相反。
 * 档位表与格式化收敛到这里，两端共用。
 *
 * 上限 2.0 不是随便定的：iOS 的 `AVAudioPlayer.rate` 合法区间是 [0.5, 2.0]，
 * 超出会被系统夹住而**不报错**——界面显示 3x、实际仍按 2x 播，比不支持更糟。
 */

/** 档位循环顺序；点一次 chip 走下一档，到末尾回到 1.0。 */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const

export type PlaybackRate = (typeof PLAYBACK_RATES)[number]

/** 浮点比较：1.25 这类档位不能用 === 去表里找。 */
function sameRate(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6
}

/** 把任意数值归一到档位表里的一档；认不出来（旧持久化值 / NaN）一律回 1.0。 */
export function normalizePlaybackRate(rate: number): PlaybackRate {
  const found = PLAYBACK_RATES.find((candidate) => sameRate(candidate, rate))
  return found ?? PLAYBACK_RATES[0]
}

/**
 * 下一档倍速（循环）。
 *
 * 认不出来的当前值（外部写进来的 0.75、持久化里的脏值）回到 1.0 而不是 1.25：
 * 与 Web 原来的 `nextPlaybackRate` 逐字同义（`findIndex` 返回 -1 时取首档）。
 */
export function nextPlaybackRate(rate: number): PlaybackRate {
  const index = PLAYBACK_RATES.findIndex((candidate) => sameRate(candidate, rate))
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length]
}

/** 1 → "1.0x"，1.25 → "1.25x"，2 → "2.0x"（与 Web `formatPlaybackRate` 同字面）。 */
export function formatPlaybackRate(rate: number): string {
  const text = Number.isInteger(rate * 10) ? rate.toFixed(1) : String(rate)
  return `${text}x`
}
