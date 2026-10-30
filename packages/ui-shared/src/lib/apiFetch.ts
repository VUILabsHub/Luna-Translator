import { apiURL, configureProductHistoryRoute } from './apiBase'
import { productAnalyticsHeaders } from './productAnalytics'
let exhibitionConsumerAuth = false

export function configureExhibitionConsumerAuth(enabled: boolean) {
  exhibitionConsumerAuth = enabled
  configureProductHistoryRoute(enabled)
}

export type ApiObservation = {
  event: 'api_request_completed' | 'api_request_failed'
  traceId: string
  requestId: string
  method: string
  path: string
  status?: number
  durationMs: number
  errorType?: string
}

export type ApiTraceContext = {
  traceId: string
  requestId?: string
  traceFlags?: string
}

export function createApiTraceContext(): ApiTraceContext {
  return { traceId: randomHex(16), requestId: `req-${randomHex(12)}`, traceFlags: '01' }
}

export function traceparentFor(context: ApiTraceContext) {
  const traceId = validTraceId(context.traceId) ? context.traceId.toLowerCase() : randomHex(16)
  return `00-${traceId}-${randomHex(8)}-${validFlags(context.traceFlags)}`
}

export async function apiFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  traceContext?: ApiTraceContext,
): Promise<Response> {
  if (input instanceof Request) {
    const mapped = apiURL(input.url)
    if (mapped !== input.url) input = new Request(mapped, input)
  } else {
    const raw = input.toString()
    const mapped = apiURL(raw)
    if (mapped !== raw) input = mapped
  }
  const startedAt = performance.now()
  const request = input instanceof Request ? input : null
  const url = requestURL(input)
  const method = (init.method || request?.method || 'GET').toUpperCase()
  const effectiveTrace = traceContext || createApiTraceContext()
  const traceId = validTraceId(effectiveTrace.traceId) ? effectiveTrace.traceId.toLowerCase() : randomHex(16)
  const requestId = safeRequestId(effectiveTrace.requestId) || `req-${randomHex(12)}`
  const headers = new Headers(request?.headers)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  if (sameOrigin(url)) {
    // Auxiliary Product APIs also require the account token in exhibition mode.
    // Never attach it to Eval (/admin/api), external URLs or explicit credentials.
    if (exhibitionConsumerAuth && url.pathname.startsWith('/api/') && !headers.has('Authorization')) {
      try {
        const token = localStorage.getItem('consumer_access_token')
        if (token) headers.set('Authorization', `Bearer ${token}`)
      } catch { /* Storage may be unavailable. */ }
    }
    if (/^\/api\/(auth|consumer)\//.test(url.pathname)) {
      for (const [name, value] of Object.entries(productAnalyticsHeaders())) if (!headers.has(name)) headers.set(name, value)
    }
    headers.set('traceparent', traceparentFor({ ...effectiveTrace, traceId }))
    headers.set('x-request-id', requestId)
  }

  try {
    const response = await fetch(input, { ...init, headers })
    publishObservation({
      event: 'api_request_completed',
      traceId: responseHeader(response, 'traceparent')?.split('-')[1] || traceId,
      requestId: responseHeader(response, 'x-request-id') || requestId,
      method,
      path: safePath(url),
      status: response.status,
      durationMs: roundedDuration(startedAt),
    }, response.ok ? 'info' : 'warn')
    return response
  } catch (error) {
    publishObservation({
      event: 'api_request_failed', traceId, requestId, method, path: safePath(url),
      durationMs: roundedDuration(startedAt),
      errorType: error instanceof DOMException && error.name === 'AbortError' ? 'AbortError' : error instanceof Error ? error.name : 'UnknownError',
    }, 'warn')
    throw error
  }
}

function responseHeader(response: Response, name: string) {
  return response.headers?.get?.(name) || ''
}

function requestURL(input: RequestInfo | URL) {
  const raw = input instanceof Request ? input.url : input.toString()
  const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/'
  return new URL(raw, base)
}

function sameOrigin(url: URL) {
  return typeof window === 'undefined' || url.origin === window.location.origin
}

function safePath(url: URL) {
  return url.pathname
}

function publishObservation(observation: ApiObservation, level: 'info' | 'warn') {
  console[level]('[simultrans-api]', observation)
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent<ApiObservation>('simultrans:api-observation', { detail: observation }))
  }
}

function roundedDuration(startedAt: number) {
  return Math.round(Math.max(0, performance.now() - startedAt) * 1000) / 1000
}

function randomHex(byteCount: number) {
  const bytes = new Uint8Array(byteCount)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function validTraceId(value?: string): value is string {
  return Boolean(value && /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value))
}

function validFlags(value?: string) {
  return value && /^[0-9a-f]{2}$/i.test(value) ? value.toLowerCase() : '01'
}

function safeRequestId(value?: string) {
  return value && /^[A-Za-z0-9._-]{1,128}$/.test(value) ? value : ''
}
