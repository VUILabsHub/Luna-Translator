import { apiURL } from '@simultrans/ui-shared/src/lib/apiBase'
import { productionMeetingJoinEnabled, productionMeetingFetch } from './productionMeetingJoin'
import { createContext } from 'react'
import { canaryDesignEnabled } from './canaryDesign'
export const CanaryGuestContext = createContext(false)
let access: Promise<string> | null = null
const guestStorageKey = () => productionMeetingJoinEnabled() ? 'luna.prod.meeting.guest.v1' : 'luna.canary.guest.v1'
async function token(): Promise<string> {
  if (!access) access = (async () => {
    try {
      const saved = JSON.parse(localStorage.getItem(guestStorageKey()) || 'null')
      if (saved?.token && saved.expiresAt > Date.now() + 30000) return saved.token
    } catch { /* Continue without persistent storage. */ }
    const response = await productionMeetingFetch(apiURL('/api/guest/access'), { method: 'POST' })
    if (!response.ok) throw new Error('无法开启游客体验，请稍后重试')
    const value = await response.json()
    if (typeof value.accessToken !== 'string' || !value.accessToken) throw new Error('游客凭证无效')
    try { localStorage.setItem(guestStorageKey(), JSON.stringify({ token: value.accessToken, expiresAt: Date.now() + Number(value.expiresIn || 300) * 1000 })) } catch { /* In-memory credential remains usable. */ }
    return value.accessToken
  })().catch(error => { access = null; throw error })
  return access
}
/** Guest credentials use their own storage key and never replace the account session. */
export async function canaryGuestFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!canaryDesignEnabled()) throw new Error('游客体验仅在 Canary 开放')
  const meeting = /^\/api\/consumer\/meetings\/(?:capabilities|join|release-attendance|[A-Za-z0-9_-]+(?:\/(?:preferences|renew|leave|idle))?)$/.test(path)
  const url = path.replace(/^\/api\/consumer\//, '/api/guest/')
  if (!meeting && !/^\/api\/guest\/(quota|quota\/consume|ws\/session)$/.test(url)) throw new Error('游客不支持此操作')
  const send = async () => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${await token()}`)
    return productionMeetingFetch(apiURL(url), { ...init, headers })
  }
  let response = await send()
  if (response.status === 401) { access = null; try { localStorage.removeItem(guestStorageKey()) } catch { /* Storage unavailable. */ } response = await send() }
  return response
}
