/** Decisions stay on this browser and are scoped to the authenticated subject. */
export function analyticsAccountId(): string {
  try {
    const token = localStorage.getItem('consumer_access_token')
    const payload = token?.split('.')[1]
    if (!payload) return ''
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))) as { sub?: unknown }
    return typeof parsed.sub === 'string' && parsed.sub && !parsed.sub.startsWith('guest:') ? parsed.sub : ''
  } catch { return '' }
}
export const analyticsConsentKey = (accountId: string) => `luna.analytics.consent.v1:${encodeURIComponent(accountId)}`
const choices = new Map<string, boolean>()
export function readAnalyticsConsent(accountId = analyticsAccountId()): boolean | null {
  if (!accountId) return null
  try {
    const stored = localStorage.getItem(analyticsConsentKey(accountId))
    if (stored === '1' || stored === '0') return stored === '1'
  } catch { return choices.get(accountId) ?? null }
  return choices.get(accountId) ?? null
}
export function writeAnalyticsConsent(allowed: boolean, accountId = analyticsAccountId()): void {
  if (!accountId) return
  choices.set(accountId, allowed)
  try { localStorage.setItem(analyticsConsentKey(accountId), allowed ? '1' : '0'); choices.delete(accountId) } catch { /* Choice persists in memory for this visit. */ }
}
