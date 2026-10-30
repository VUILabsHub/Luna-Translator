export type ShowcaseTextSize = 'small' | 'standard' | 'large'
export const SHOWCASE_TEXT_SIZE_KEY = 'simultrans.showcaseFontSize'
export function readShowcaseTextSize(): ShowcaseTextSize {
  try { const value = localStorage.getItem(SHOWCASE_TEXT_SIZE_KEY); return value === 'small' || value === 'large' ? value : 'standard' } catch { return 'standard' }
}
export function saveShowcaseTextSize(value: ShowcaseTextSize) {
  try { localStorage.setItem(SHOWCASE_TEXT_SIZE_KEY, value) } catch { /* The current preview still updates when browser storage is unavailable. */ }
}
