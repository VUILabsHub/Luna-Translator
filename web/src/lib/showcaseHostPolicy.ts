/** Only public production and canary entry points hide new dual-microphone sessions. */
export function canStartDuoShowcase(hostname = typeof window === 'undefined' ? '' : window.location.hostname): boolean {
  return !['simultrans.lunalabs.cn', 'simultrans-canary.lunalabs.cn'].includes((hostname || '').toLowerCase())
}
