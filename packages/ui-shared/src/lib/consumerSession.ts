// Consumer（C 端）会话层 for the web showcase.
//
// Flow mirrors mobile/src/api/auth.ts: sendOtp → verifyOtp (stores the RS256
// token pair in localStorage) → consumerFetch adds `Authorization: Bearer` on
// top of apiFetch (which stamps x-request-id / traceparent) and refreshes once
// on 401 via POST /api/auth/refresh { refreshToken }.
//
// 会话终态：refresh 凭证被服务端明确拒绝 → clearConsumerSession()
// 并派发 window 事件 'consumer:session-expired'；网络异常、限流和 5xx
// 是暂时失败，保留会话等待下次重试。登录/登出派发 'consumer:session-changed'。
import { apiFetch } from './apiFetch'

const ACCESS_TOKEN_KEY = 'consumer_access_token'
const REFRESH_TOKEN_KEY = 'consumer_refresh_token'
const SESSION_ID_KEY = 'consumer_session_identity'
const INSTALLATION_KEY = 'consumer_installation_id'
let generation = 0
let volatileInstallation: string | undefined

function randomID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function installationID(): string {
  const stored = safeGet(INSTALLATION_KEY)
  if (stored) return stored
  const value = volatileInstallation ??= randomID()
  safeSet(INSTALLATION_KEY, value)
  return value
}

export type ConsumerSessionEvent = { type: 'changed' | 'expired'; reason?: 'session_replaced' }
export type ConsumerSessionListener = (event: ConsumerSessionEvent) => void

export type SendOtpResult = {
  ok: boolean
  error?: string
  delivery?: 'sms' | 'dev'
  /** DevOTP 环境后端直接回带验证码（测试环境提示条展示）。 */
  devCode?: string
}

export type VerifyOtpResult = { ok: boolean; error?: string }

const listeners = new Set<ConsumerSessionListener>()
let observedWindow: Window | undefined
const onStorage = (event: StorageEvent) => {
  // The identity marker changes only on login/logout, never token rotation.
  if (event.key !== SESSION_ID_KEY && event.key !== null) return
  generation++
  notify('changed')
}

/** 订阅登录态变化（登录、登出、会话过期）；返回取消订阅函数。 */
export function subscribeConsumerSession(listener: ConsumerSessionListener): () => void {
  if (typeof window !== 'undefined' && observedWindow !== window && typeof window.addEventListener === 'function') {
    observedWindow?.removeEventListener?.('storage', onStorage)
    observedWindow = window
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(type: ConsumerSessionEvent['type'], reason?: ConsumerSessionEvent['reason']) {
  const detail: ConsumerSessionEvent = reason ? { type, reason } : { type }
  for (const listener of [...listeners]) listener(detail)
  // 跨模块通知（契约事件名）：changed → 'consumer:session-changed'，
  // expired → 'consumer:session-expired'。
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(`consumer:session-${type}`, { detail }))
  }
}

// localStorage 在隐私模式/SSR 下可能不可用或直接抛错，所有存取都包 try/catch。
function safeGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
  } catch {
    return null
  }
}

function safeSet(key: string, value: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Storage unavailable — session simply won't persist.
  }
}

function safeRemove(key: string) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key)
  } catch {
    // Ignore.
  }
}

/** 当前 access token，未登录返回 null。 */
export function getConsumerToken(): string | null {
  return safeGet(ACCESS_TOKEN_KEY)
}

/** Login lifecycle revision for reactive work; access-token rotation keeps it stable. */
export function getConsumerSessionRevision(): number {
  return generation
}

export function isLoggedIn(): boolean {
  return getConsumerToken() !== null
}

/** 清除本地会话（只清 storage，不发事件；事件由调用方按语义派发）。 */
export function clearConsumerSession(): void {
  generation++
  safeRemove(ACCESS_TOKEN_KEY)
  safeRemove(REFRESH_TOKEN_KEY)
  safeRemove(SESSION_ID_KEY)
}

async function postJson(path: string, body: unknown): Promise<{ status: number; json: any }> {
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // Empty/non-JSON body — leave json null.
    }
    return { status: res.status, json }
  } catch {
    // status 0 = 网络异常（与 mobile/src/api/auth.ts 约定一致）。
    return { status: 0, json: null }
  }
}

export async function sendOtp(phone: string): Promise<SendOtpResult> {
  if (!/^1\d{10}$/.test(phone)) return { ok: false, error: '请输入 11 位手机号' }
  const { status, json } = await postJson('/api/auth/otp/send', { phone })
  if (status === 0) return { ok: false, error: '网络异常，请检查连接后重试' }
  if (status >= 200 && status < 300) {
    const delivery: 'sms' | 'dev' = json?.delivery === 'dev' ? 'dev' : 'sms'
    return { ok: true, delivery, devCode: json?.devCode }
  }
  // 429 限流等错误带人类可读 `error` 文案，原样透传。
  return { ok: false, error: json?.error || '验证码发送失败，请稍后再试' }
}

/**
 * 校验短信验证码，成功后把 token 对写入 localStorage 并派发
 * 'consumer:session-changed'。consent 为协议勾选回执（版本 + 时间戳），
 * 随 verify 上报供 PIPL 留痕（后端可选字段，老客户端不发）。
 */
export async function verifyOtp(
  phone: string,
  code: string,
  consent?: { version: string; atMs: number },
): Promise<VerifyOtpResult> {
  const requestGeneration = ++generation
  const identity = safeGet(SESSION_ID_KEY)
  const { status, json } = await postJson('/api/auth/otp/verify', {
    phone,
    code,
    platform: 'web',
    installationId: installationID(),
    ...(consent ? { consentVersion: consent.version, consentAtMs: consent.atMs } : {}),
  })
  if (generation !== requestGeneration || identity !== safeGet(SESSION_ID_KEY)) return { ok: false, error: '登录状态已改变，请重试' }
  if (status === 0) return { ok: false, error: '网络异常，请检查连接后重试' }
  if (status >= 200 && status < 300 && typeof json?.accessToken === 'string' && json.accessToken) {
    safeSet(ACCESS_TOKEN_KEY, json.accessToken)
    if (typeof json.refreshToken === 'string' && json.refreshToken) safeSet(REFRESH_TOKEN_KEY, json.refreshToken)
    else safeRemove(REFRESH_TOKEN_KEY)
    safeSet(SESSION_ID_KEY, randomID())
    notify('changed')
    return { ok: true }
  }
  return { ok: false, error: json?.error || '验证码不正确' }
}

/** 登出：清本地会话 + 派发 'consumer:session-changed'；服务端吊销 best-effort。 */
export async function logout(): Promise<void> {
  const refreshToken = safeGet(REFRESH_TOKEN_KEY)
  clearConsumerSession()
  notify('changed')
  if (refreshToken) {
    // Best-effort server-side revoke; local state is already cleared.
    await postJson('/api/auth/logout', { refreshToken })
  }
}

type SessionStamp = { generation: number; identity: string | null }
const stamp = (): SessionStamp => ({ generation, identity: safeGet(SESSION_ID_KEY) })
const current = (value: SessionStamp) => value.generation === generation && value.identity === safeGet(SESSION_ID_KEY)
/** Guard all work belonging to one login, including pending connection setup. */
export function createConsumerSessionGuard(): () => boolean {
  const owner = stamp()
  return () => current(owner)
}
/** Bind long-lived sockets to the login that created them, never a later login. */
export function createConsumerSessionInvalidator(): () => void {
  const owner = stamp()
  return () => {
    if (!current(owner)) return
    clearConsumerSession()
    notify('expired', 'session_replaced')
  }
}
type RefreshOutcome = { status: 'ok' | 'rejected' | 'transient' | 'superseded'; reason?: ConsumerSessionEvent['reason'] }

async function rotateRefreshToken(owner: SessionStamp, refreshToken: string | null): Promise<RefreshOutcome> {
  if (!current(owner)) return { status: 'superseded' }
  // A second tab may have rotated while this tab waited for the browser lock.
  if (refreshToken !== safeGet(REFRESH_TOKEN_KEY)) return { status: getConsumerToken() ? 'ok' : 'superseded' }
  if (!refreshToken) return { status: 'rejected' }
  const { status, json } = await postJson('/api/auth/refresh', { refreshToken })
  if (!current(owner)) return { status: 'superseded' }
  if (refreshToken !== safeGet(REFRESH_TOKEN_KEY)) return { status: getConsumerToken() ? 'ok' : 'superseded' }
  if (status >= 200 && status < 300 && json?.accessToken) {
    safeSet(ACCESS_TOKEN_KEY, json.accessToken)
    // 后端 refresh 会轮转 refresh token；缺省时保留旧值（对齐 iOS 行为）。
    if (json.refreshToken) safeSet(REFRESH_TOKEN_KEY, json.refreshToken)
    return { status: 'ok' }
  }
  return {
    status: status >= 400 && status < 500 && status !== 429 ? 'rejected' : 'transient',
    ...(json?.code === 'session_replaced' ? { reason: 'session_replaced' as const } : {}),
  }
}

// 单飞：并发 401 只旋转一次 refresh token（轮转是原子的，重复调用会烧掉凭据）。
let refreshInFlight: { owner: SessionStamp; promise: Promise<RefreshOutcome> } | null = null

function refresh(owner: SessionStamp): Promise<RefreshOutcome> {
  if (refreshInFlight && current(refreshInFlight.owner)) return refreshInFlight.promise
  const refreshToken = safeGet(REFRESH_TOKEN_KEY)
  const rotate = () => rotateRefreshToken(owner, refreshToken)
  const work = typeof navigator !== 'undefined' && navigator.locks?.request
    ? navigator.locks.request('luna-consumer-refresh', rotate) : rotate()
  const pending = work.finally(() => {
    if (refreshInFlight?.promise === pending) refreshInFlight = null
  })
  refreshInFlight = { owner, promise: pending }
  return pending
}

/**
 * Consumer REST 认证请求：自动带 `Authorization: Bearer` 与 apiFetch 的
 * x-request-id / traceparent；401 时 refresh 一次并重试，refresh 被服务端
 * 明确拒绝则 clearConsumerSession() + 派发 'consumer:session-expired'。
 * `path` 为绝对 API 路径（如 '/api/consumer/quota'）。
 */
export async function consumerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const owner = stamp()
  const requireCurrent = () => {
    if (current(owner)) return
    const error = new Error('登录状态已改变，请重试')
    error.name = 'AbortError'
    throw error
  }
  const expireIfReplaced = async (response: Response): Promise<boolean> => {
    if (response.status !== 401 && response.status !== 403) return false
    const failure = await response.clone().json().catch(() => null)
    requireCurrent()
    if (failure?.code !== 'session_replaced') return false
    clearConsumerSession(); notify('expired', 'session_replaced')
    return true
  }
  const withAuth = (): RequestInit => {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${getConsumerToken() ?? ''}`)
    return { ...init, headers }
  }
  let res = await apiFetch(path, withAuth())
  // Successful private data from a retired login must not reach the new one.
  requireCurrent()
  if (await expireIfReplaced(res)) return res
  requireCurrent()
  if (res.status === 401) {
    // Never replay an old account's write under a newer account's credentials.
    const outcome = await refresh(owner)
    requireCurrent()
    if (outcome.status === 'ok') {
      res = await apiFetch(path, withAuth())
      requireCurrent()
      if (await expireIfReplaced(res)) return res
      requireCurrent()
    } else if (outcome.status === 'rejected') {
      // 无可用 refresh token 或服务端明确否决 → 终态，清会话并通知。
      clearConsumerSession()
      notify('expired', outcome.reason)
    }
    // 暂时失败时保留会话，把原始 401 交给调用方。
  }
  return res
}

/** Sign into a self-hosted, single-workspace community deployment. */
export async function communitySignIn(password: string): Promise<boolean> {
  const { status, json } = await postJson('/api/community/login', { password })
  if (status !== 200 || !json?.accessToken) return false
  generation++
  safeSet(ACCESS_TOKEN_KEY, json.accessToken)
  safeRemove(REFRESH_TOKEN_KEY)
  safeSet(SESSION_ID_KEY, randomID())
  notify('changed')
  return true
}
