import { analyticsAccountId, readAnalyticsConsent, writeAnalyticsConsent } from './analyticsConsent'
// Inert until the consumer Web entry point initializes it. No dependency on
// React; an audio callback only enqueues a small, explicit record.
export type AnalyticsName = 'page_view' | 'login_started' | 'session_start_clicked' | 'microphone_result' | 'session_connected' | 'first_translation_shown' | 'first_audio_received' | 'first_audio_playback' | 'session_client_ended' | 'session_error' | 'language_changed' | 'session_paused' | 'session_resumed' | 'playback_result' | 'history_viewed' | 'history_playback' | 'transcript_copied' | 'audio_exported' | 'share_opened' | 'share_link_copied' | 'feedback_submitted' | 'web_vital' | 'js_error' | 'api_result'
export type AnalyticsFields = {
  attemptId?: string; sessionId?: string; traceId?: string; mode?: string; sourceLanguage?: string; targetLanguage?: string; targetCount?: number; audioEnabled?: boolean;
  result?: string; reason?: string; metric?: string; durationMs?: number; value?: number;
}
export type AnalyticsEvent = AnalyticsFields & { id: string; name: AnalyticsName; version: 1; at: string; visitorId: string; visitId: string; release: string; browser: string; browserVersion: string; os: string; device: string; page: string; channel: string }
type Queued = { event: AnalyticsEvent; token: string | null }
const MAX_QUEUE = 200, BATCH_SIZE = 30
const OPT_OUT = 'luna.analytics.optout.v1'
let initialized = false, configured = false, enabled = false, release = '', visitorId = '', visitId = '', lastToken: string | null = null
let queue: Queued[] = [], pending = false, failures = 0, retryAt = 0
let configExpiresAt = 0
const onceKeys = new Set<string>()
let requestContext: AnalyticsFields = {}
let dimensions = { browser: 'unknown', browserVersion: '', os: 'unknown', device: 'desktop' }
function get(key: string, session = false) { try { return (session ? sessionStorage : localStorage).getItem(key) } catch { return null } }
function put(key: string, value: string, session = false) { try { (session ? sessionStorage : localStorage).setItem(key, value) } catch { /* Storage is optional. */ } }
async function timedFetch(input: string, init: RequestInit, timeout: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try { return await fetch(input, { ...init, signal: controller.signal }) } finally { clearTimeout(timer) }
}
function token() { return get('consumer_access_token') }
export function analyticsID() { try { return crypto.randomUUID() } catch { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}` } }
export function analyticsOptedOut() { return !analyticsAccountId() || readAnalyticsConsent() !== true }
export function setAnalyticsOptOut(value: boolean) { writeAnalyticsConsent(!value); put(OPT_OUT, value ? '1' : '0'); if (value) { queue = []; requestContext = {}; onceKeys.clear(); identity(true) } else if (initialized && !analyticsOptedOut()) { identity(); void refreshConfig() } }
function identity(reset = false) {
  if (analyticsOptedOut()) {
    visitorId = ''; visitId = ''
    try { localStorage.removeItem('luna.analytics.visitor.v1'); sessionStorage.removeItem('luna.analytics.visit.v1') } catch { /* Storage is optional. */ }
    return
  }
  visitorId = (!reset && get('luna.analytics.visitor.v1')) || analyticsID(); put('luna.analytics.visitor.v1', visitorId)
  const raw = get('luna.analytics.visit.v1', true); let stored: { id?: string; at?: number } = {}; try { stored = JSON.parse(raw || '{}') } catch { /* malformed local state */ }
  visitId = !reset && stored.id && stored.at && Date.now() - stored.at < 30 * 60_000 ? stored.id : analyticsID()
  put('luna.analytics.visit.v1', JSON.stringify({ id: visitId, at: Date.now() }), true)
}
export function analyticsDevice(ua: string) {
  const match = ua.match(/(?:MQQBrowser|QQBrowser)\/([\d.]+)/) || ua.match(/Edg\/([\d.]+)/) || ua.match(/(?:CriOS|Chrome)\/([\d.]+)/) || ua.match(/Firefox\/([\d.]+)/) || ua.match(/Version\/([\d.]+).*Safari/)
  const browser = /(?:MQQBrowser|QQBrowser)/.test(ua) ? 'QQBrowser' : /Edg\//.test(ua) ? 'Edge' : /(?:CriOS|Chrome)\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'unknown'
  return { browser, browserVersion: match?.[1] || '', os: /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown', device: /iPad|Tablet/.test(ua) ? 'tablet' : /Mobile|iPhone|Android/.test(ua) ? 'mobile' : 'desktop' }
}
export function analyticsPage(path: string) { return path === '/' ? 'home' : path === '/settings' ? 'settings' : path === '/history' ? 'history' : /^\/history\/[^/]+$/.test(path) ? 'history_detail' : /^\/s\/[^/]+$/.test(path) ? 'share' : 'other' }
function safeFields(fields: AnalyticsFields): AnalyticsFields {
  const result: Record<string, string | number | boolean> = {}
  for (const key of ['attemptId', 'sessionId', 'traceId', 'mode', 'sourceLanguage', 'targetLanguage', 'result', 'reason', 'metric'] as const) { const value = fields[key]; if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/.test(value)) result[key] = value }
  for (const key of ['durationMs', 'value', 'targetCount'] as const) { const value = fields[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400_000) result[key] = value }
  if (typeof fields.audioEnabled === 'boolean') result.audioEnabled = fields.audioEnabled
  return result
}
function base() {
  return { visitorId, visitId, release, ...dimensions, page: analyticsPage(window.location.pathname), channel: channel() }
}
function channel() { const value = new URLSearchParams(window.location.search).get('utm_source') || ''; return /^[a-zA-Z0-9_-]{1,40}$/.test(value) ? value : '' }
export function trackProduct(name: AnalyticsName, fields: AnalyticsFields = {}, onceKey?: string) {
  if (!initialized || (configured && !enabled) || analyticsOptedOut()) return
  if (onceKey) { if (onceKeys.has(onceKey)) return; if (onceKeys.size > 1000) onceKeys.clear(); onceKeys.add(onceKey) }
  const event: AnalyticsEvent = { ...base(), ...safeFields(fields), id: analyticsID(), name, version: 1, at: new Date().toISOString() }
  if (queue.length >= MAX_QUEUE) queue.shift()
  queue.push({ event, token: token() }); put('luna.analytics.visit.v1', JSON.stringify({ id: visitId, at: Date.now() }), true)
  if (queue.length >= BATCH_SIZE) void flushProductAnalytics()
}
export function productAnalyticsMetadata(fields: AnalyticsFields = requestContext) {
  if (!initialized || (configured && !enabled) || analyticsOptedOut()) return undefined
  return { ...base(), ...safeFields(fields) }
}
export function productAnalyticsHeaders(fields: AnalyticsFields = requestContext): Record<string, string> {
  if (!initialized || (configured && !enabled) || analyticsOptedOut()) return {}
  return { 'X-Luna-Analytics': JSON.stringify({ ...base(), ...safeFields(fields) }) }
}
export function beginProductAttempt(fields: AnalyticsFields): AnalyticsFields {
  const attempt = { ...safeFields(fields), attemptId: analyticsID() }
  requestContext = attempt
  trackProduct('session_start_clicked', attempt)
  return attempt
}
export function endProductAttempt() { requestContext = {} }
export async function flushProductAnalytics(keepalive = false) {
  if (!enabled || analyticsOptedOut() || pending || queue.length === 0 || Date.now() < retryAt) return
  pending = true
  const auth = queue[0].token, batch = queue.filter(item => item.token === auth).slice(0, BATCH_SIZE)
  const ids = new Set(batch.map(item => item.event.id))
  try {
    // No apiFetch here: the collector cannot observe and recursively log itself.
    const response = await timedFetch('/api/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ events: batch.map(item => item.event) }), keepalive }, 5000)
    if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) { queue = queue.filter(item => !ids.has(item.event.id)); failures = 0; retryAt = 0 }
    else { failures++; retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) }
  } catch { failures++; retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) } finally { pending = false }
}
async function refreshConfig() {
  if (analyticsOptedOut()) { enabled = false; queue = []; return }
  try {
    const response = await timedFetch('/api/analytics/config', { cache: 'no-store' }, 4000); if (!response.ok) throw new Error('config')
    const config = await response.json() as { enabled?: boolean; release?: string }
    configured = true; enabled = config.enabled === true; configExpiresAt = Date.now() + 120_000
    if (!enabled) queue = []
  } catch { if (Date.now() > configExpiresAt) { configured = true; enabled = false; queue = [] } }
}
export async function initializeProductAnalytics(webRelease = 'development') {
  // The native share viewer has no Web analytics opt-in/settings surface.
  // Do not create identifiers or send analytics/config requests there.
  if (initialized || typeof window === 'undefined' || /LunaTransMobile/.test(navigator.userAgent) || /^\/(?:admin|ui-showcase)/.test(window.location.pathname)) return
  initialized = true; release = /^[A-Za-z0-9_.-]{1,80}$/.test(webRelease) ? webRelease : 'development'; dimensions = analyticsDevice(navigator.userAgent); identity(); lastToken = token()
  trackProduct('page_view', {}, `page:${visitId}:${analyticsPage(window.location.pathname)}`)
  if (analyticsPage(window.location.pathname) === 'share') trackProduct('share_opened')
  if (analyticsPage(window.location.pathname).startsWith('history')) trackProduct('history_viewed')
  await refreshConfig()
  window.addEventListener('consumer:session-changed', () => { const next = token(); if (lastToken && next !== lastToken) { queue = []; identity(true); requestContext = {}; onceKeys.clear() }; lastToken = next; if (!analyticsOptedOut()) { identity(); void refreshConfig() } })
  window.addEventListener('consumer:session-expired', () => { queue = []; identity(true); requestContext = {}; lastToken = null })
  window.addEventListener('storage', event => { if (event.key === 'consumer_access_token' || event.key === OPT_OUT || event.key?.startsWith('luna.analytics.consent.v1:')) { queue = []; requestContext = {}; onceKeys.clear(); identity(true); lastToken = token() } })
  window.addEventListener('simultrans:api-observation', event => {
    const observation = (event as CustomEvent<{ path: string; status?: number; event: string; durationMs: number; traceId: string }>).detail
    if (!observation || !/^\/api\/(auth|consumer)\//.test(observation.path) || (observation.status && observation.status < 400)) return
    trackProduct('api_result', { result: 'failure', reason: observation.status ? 'http_error' : 'network_error', durationMs: observation.durationMs, traceId: observation.traceId })
  })
  window.addEventListener('pagehide', () => { void flushProductAnalytics(true) })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushProductAnalytics(true) })
  window.addEventListener('error', () => trackProduct('js_error', { reason: 'uncaught_error' }, `js:${visitId}:error`))
  window.addEventListener('unhandledrejection', () => trackProduct('js_error', { reason: 'unhandled_rejection' }, `js:${visitId}:rejection`))
  setInterval(() => { void flushProductAnalytics() }, 5000)
  setInterval(() => { void refreshConfig() }, 60_000)
}
