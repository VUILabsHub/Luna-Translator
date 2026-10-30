import { HOME_MODE_LABELS, SESSION_MODE_LABELS } from './sessionLabels'

/**
 * Read-side metadata shared by Web and both mobile clients. `user` is a title the
 * owner chose (PATCH /api/consumer/history/{id}); it is terminal like ready /
 * fallback, so nobody polls for a better one.
 */
export type HistoryTitleStatus = 'pending' | 'ready' | 'fallback' | 'user'
export type HistoryScene = 'listen' | 'speak' | 'conversation' | 'meeting'
export type HistoryTitleContext = {
  title?: unknown
  titleStatus?: unknown
  scene?: unknown
  mode?: unknown
  settings?: unknown
}

/**
 * Every new record title, generated or user-chosen, is at most this many code points
 * (owner decision 2026-10-21, was 28; backend consumerstore.HistoryTitleMaxRunes).
 */
export const HISTORY_TITLE_MAX = 13
/**
 * Titles stored under the old limit are never rewritten and still come back with up to this
 * many code points. The unclamped display (prod) shows them in full, as before.
 */
export const HISTORY_TITLE_LEGACY_MAX = 28
/** What a clamped display title ends with: one character, U+2026. */
export const HISTORY_TITLE_ELLIPSIS = '…'

/**
 * Display clamp for titles stored under the old limit: at most HISTORY_TITLE_MAX code points
 * come back as is, a longer title becomes its first 13 code points plus 「…」. Counts code points
 * (`Array.from`, like the server's rune count), so an emoji is never split. Trailing spaces and
 * punctuation are kept, so a clamped title is always exactly 13 + 「…」. Idempotent.
 */
export function clampHistoryTitle(title: string): string {
  const codePoints = Array.from(title)
  return codePoints.length > HISTORY_TITLE_MAX
    ? codePoints.slice(0, HISTORY_TITLE_MAX).join('') + HISTORY_TITLE_ELLIPSIS
    : title
}

// Mirrors of the backend rules (backend/server/consumer_history_title.go
// normalizeHistoryUserTitle / historyUserTitleProblem). Explicit code point
// ranges, no `\p{}` or `u`-flag regexes: Hermes must run this too.

/** Go `unicode.IsSpace` (what `strings.Fields` splits on). */
const USER_TITLE_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g

/** Go `unicode.Cf` (Unicode 15.0), inclusive ranges. */
const FORMAT_CODE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x0600, 0x0605], [0x061c, 0x061c], [0x06dd, 0x06dd], [0x070f, 0x070f],
  [0x0890, 0x0891], [0x08e2, 0x08e2], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x110bd, 0x110bd],
  [0x110cd, 0x110cd], [0x13430, 0x1343f], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0001, 0xe0001], [0xe0020, 0xe007f],
]

function invalidUserTitleCodePoint(code: number): boolean {
  // Go unicode.IsControl (C0, DEL and C1), markup / Markdown delimiters and the line separators.
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  if (code === 0x3c || code === 0x3e || code === 0x60 || code === 0x2028 || code === 0x2029) return true
  return FORMAT_CODE_POINTS.some(([low, high]) => code >= low && code <= high)
}

/**
 * Trim and collapse every whitespace run (a pasted newline, an ideographic space) to one space.
 * Not `String.prototype.trim`: that also eats U+FEFF, which the server rejects instead.
 */
export function normalizeHistoryUserTitle(raw: string): string {
  return raw.replace(USER_TITLE_SPACE, ' ').replace(/^ | $/g, '')
}

export type HistoryUserTitleProblem = 'empty' | 'too_long' | 'invalid_char'

/**
 * Why a **normalized** user title would be rejected, or null when it is valid.
 * Length counts code points (`Array.from`), the same as the server's rune count:
 * an emoji is one character, not two UTF-16 units.
 */
export function historyUserTitleProblem(title: string): HistoryUserTitleProblem | null {
  if (title === '') return 'empty'
  const codePoints = Array.from(title)
  if (codePoints.length > HISTORY_TITLE_MAX) return 'too_long'
  return codePoints.some((character) => invalidUserTitleCodePoint(character.codePointAt(0) ?? 0)) ? 'invalid_char' : null
}

export const HISTORY_MODE_LABELS: Record<string, string> = { ...SESSION_MODE_LABELS, solo: '快速开始' }

const SCENE_TITLES: Record<HistoryScene, string> = {
  listen: '听译记录',
  speak: '发言记录',
  conversation: '对话记录',
  meeting: '会议记录',
}

function validScene(value: unknown): HistoryScene | undefined {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCENE_TITLES, value)
    ? value as HistoryScene
    : undefined
}

function storedSettings(context: HistoryTitleContext): Record<string, unknown> | undefined {
  return context.settings && typeof context.settings === 'object' && !Array.isArray(context.settings)
    ? context.settings as Record<string, unknown>
    : undefined
}

/** A session's saved scene takes precedence over its underlying solo engine. */
export function historyScene(context: HistoryTitleContext): HistoryScene | undefined {
  return validScene(storedSettings(context)?.scene) ?? validScene(context.scene)
}

export function historySceneLabel(context: HistoryTitleContext): string {
  const scene = historyScene(context)
  return scene ? HOME_MODE_LABELS[scene] : (context.mode === 'duo' || storedSettings(context)?.mode === 'duo' ? HISTORY_MODE_LABELS.duo : HISTORY_MODE_LABELS.solo)
}

/** Always available, including old records and a disabled/unavailable provider. */
export function historyFallbackTitle(context: HistoryTitleContext): string {
  const scene = historyScene(context)
  return scene ? SCENE_TITLES[scene] : `${historySceneLabel(context)}记录`
}

/**
 * The title to show: the stored one with control / invisible characters made spaces, or the scene
 * fallback. `clamp` (Canary display) applies clampHistoryTitle; without it a title stored under
 * the old limit shows in full (up to HISTORY_TITLE_LEGACY_MAX), so prod is unchanged.
 */
export function historyDisplayTitle(context: HistoryTitleContext, clamp = false): string {
  const title = typeof context.title === 'string'
    ? context.title.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()
    : ''
  // The legacy engine name is remapped only when the server wrote it; a name the owner typed shows as typed.
  if ((title === '单麦多语记录' || title === '单麦多语言记录') && context.titleStatus !== 'user') return historyFallbackTitle(context)
  if (!title) return historyFallbackTitle(context)
  return clamp ? clampHistoryTitle(title) : Array.from(title).slice(0, HISTORY_TITLE_LEGACY_MAX).join('')
}
