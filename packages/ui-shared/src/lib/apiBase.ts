// The Product client keeps root API paths. Eval configures its own gateway
// before mounting, so shared UI code does not depend on the Product backend.
let basePath = ''
let mobileProduction = false
/** Used only by the isolated production browser invitation bundle. */
export function configureMobileProductionAPI(enabled: boolean) { mobileProduction = enabled }
let productHistoryRoute = false
export function configureProductHistoryRoute(enabled: boolean) { productHistoryRoute = enabled }
export function configureApiBasePath(path: string) {
  if (path && !/^\/[a-zA-Z0-9_/-]+$/.test(path)) throw new Error('Invalid API base path')
  basePath = path.replace(/\/+$/, '')
}
export function apiURL(input: string): string {
  if (mobileProduction) {
    const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
    const parsed = new URL(input, origin)
    if (parsed.origin.replace(/^ws/, 'http') !== origin) return input
    if (/^\/api\/(?!mobile\/v1(?:\/|$))/.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace('/api/', '/api/mobile/v1/')
    else if (/^\/ws\/(?!mobile\/v1(?:\/|$))/.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace('/ws/', '/ws/mobile/v1/')
    return input.startsWith('/') ? parsed.pathname + parsed.search + parsed.hash : parsed.toString()
  }
  if (!basePath) return productHistoryRoute && /^\/api\/history(?:[/?]|$)/.test(input) ? input.replace('/api/history', '/api/product/history') : input
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
  const parsed = new URL(input, origin)
  const httpOrigin = parsed.origin.replace(/^ws/, 'http')
  if (httpOrigin !== origin || !/^\/(api(?:\/|$)|ws(?:\/|$)|health$|ready$)/.test(parsed.pathname)) return input
  parsed.pathname = basePath + parsed.pathname
  return input.startsWith('/') ? parsed.pathname + parsed.search + parsed.hash : parsed.toString()
}
