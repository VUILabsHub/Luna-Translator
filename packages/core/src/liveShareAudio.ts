// Output-only, opt-in fanout. A publisher never changes the owner's player.
export type SharePCM = { sessionId: string; kind: string; audio: string; sampleRate: number }
const listeners = new Set<(chunk: SharePCM) => void>()
const limits = new Map<string, number>()
export function observeSharePCM(chunk: SharePCM) {
  const bytes = Math.floor(chunk.audio.length * 3 / 4) - (chunk.audio.endsWith('==') ? 2 : chunk.audio.endsWith('=') ? 1 : 0)
  recordBytes(chunk.sessionId, chunk.kind, bytes)
  notify(chunk)
}
function recordBytes(sessionId: string, kind: string, bytes: number) {
  const key = `${sessionId}/${kind}`
  if (!limits.has(key) && limits.size >= 256) limits.delete(limits.keys().next().value!)
  limits.set(key, (limits.get(key) || 0) + bytes)
}
function notify(chunk: SharePCM) {
  if (!chunk.kind.startsWith('output')) return
  for (const listener of listeners) { try { listener(chunk) } catch { /* sharing must not interrupt recording */ } }
}
export function subscribeSharePCM(listener: (chunk: SharePCM) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function sharePCMLimits(sessionIds: string[]) {
  return Object.fromEntries([...limits].filter(([key]) => sessionIds.some(id => key.startsWith(`${id}/`))))
}

export function observeSharePCMBytes(sessionId: string, kind: string, bytes: Uint8Array, sampleRate: number) {
  recordBytes(sessionId, kind, bytes.length)
  if (!listeners.size) return
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let audio = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0)
    audio += alphabet[(n >>> 18) & 63] + alphabet[(n >>> 12) & 63] + (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[n & 63] : '=')
  }
  notify({ sessionId, kind, audio, sampleRate })
}
