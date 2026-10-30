import { analyticsAccountId } from '@simultrans/ui-shared/src/lib/analyticsConsent'
import { getConsumerSessionRevision, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'

export const AI_CONSENT_VERSION = '2026-09-21'
export const AI_PROCESSOR = '此部署管理员配置的模型服务商（Luna / 阿里云百炼）'
const PREFIX = 'simultrans.ai-consent.v1:'
const CHANNEL = 'simultrans.ai-consent.v1'
type Receipt = { version: string; timestamp: number }
export type AIConsentSnapshot = { kind: 'request' | 'settings'; owner: string; id: number } | null
let guestId = ''
let generation = 0
let nextId = 0
let hosts = 0
let snapshot: AIConsentSnapshot = null
let pending: { owner: string; identity: string; resolve: (value: boolean) => void; promise: Promise<boolean> } | null = null
const fallback = new Map<string, Receipt | null>()
const listeners = new Set<() => void>()
const invalidations = new Set<() => void>()
let broadcast: BroadcastChannel | null = null
const emit = () => listeners.forEach(listener => listener())

export function aiConsentOwner(): string {
  const account = analyticsAccountId()
  if (account) return `account:${account}`
  if (!guestId) {
    try { guestId = localStorage.getItem('simultrans.ai-consent.guest-identity') || '' } catch { /* In-memory guest remains isolated from accounts. */ }
    if (!guestId) {
      guestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`
      try { localStorage.setItem('simultrans.ai-consent.guest-identity', guestId) } catch { /* This visit only. */ }
    }
  }
  return `guest:${guestId}`
}
const identity = () => `${aiConsentOwner()}:${getConsumerSessionRevision()}`
export const aiConsentStorageKey = (owner = aiConsentOwner()) => `${PREFIX}${encodeURIComponent(owner)}`
export function hasAIConsent(): boolean {
  const owner = aiConsentOwner()
  let receipt: Receipt | null = null
  if (fallback.has(owner)) receipt = fallback.get(owner) || null
  else try { receipt = JSON.parse(localStorage.getItem(aiConsentStorageKey(owner)) || 'null') } catch { /* No persisted receipt. */ }
  return receipt?.version === AI_CONSENT_VERSION && Number.isFinite(receipt.timestamp) && receipt.timestamp > 0
}
export const getAIConsentSnapshot = () => snapshot
export function subscribeAIConsent(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
const denyPending = () => {
  const request = pending
  pending = null
  snapshot = null
  request?.resolve(false)
}
const invalidate = () => { generation++; invalidations.forEach(listener => listener()) }

/** No content, microphone or AI session is permitted while this promise is pending. */
export function ensureAIConsent(): Promise<boolean> {
  if (!hosts) return Promise.resolve(false)
  if (hasAIConsent()) return Promise.resolve(true)
  const owner = aiConsentOwner(), currentIdentity = identity()
  if (pending?.identity === currentIdentity) return pending.promise
  denyPending()
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(done => { resolve = done })
  pending = { owner, identity: currentIdentity, resolve, promise }
  snapshot = { kind: 'request', owner, id: ++nextId }
  emit()
  return promise
}
export function answerAIConsent(accepted: boolean): void {
  const request = pending
  if (!request || request.identity !== identity() || request.owner !== aiConsentOwner()) { denyPending(); emit(); return }
  if (accepted) {
    const receipt = { version: AI_CONSENT_VERSION, timestamp: Date.now() }
    try { localStorage.setItem(aiConsentStorageKey(request.owner), JSON.stringify(receipt)); fallback.delete(request.owner) } catch { fallback.set(request.owner, receipt) }
  }
  pending = null; snapshot = null
  request.resolve(accepted)
  emit()
}
export function openAIConsentSettings(): void {
  if (pending || !hosts) return
  snapshot = { kind: 'settings', owner: aiConsentOwner(), id: ++nextId }
  emit()
}
export function closeAIConsentSettings(): void { if (snapshot?.kind === 'request') answerAIConsent(false); else { snapshot = null; emit() } }
/** False means sending stopped for this visit, but durable revocation failed. */
export function revokeAIConsent(): boolean {
  const owner = aiConsentOwner()
  // Synchronous tombstone and lease invalidation precede any async RTC/WS cleanup.
  fallback.set(owner, null)
  denyPending(); invalidate()
  let persisted = false
  try { localStorage.setItem(aiConsentStorageKey(owner), 'null'); persisted = true }
  catch {
    // Quota-exceeded stores may still permit deletion of the old grant.
    try { localStorage.removeItem(aiConsentStorageKey(owner)); persisted = true }
    catch { /* The in-memory tombstone still invalidates every active lease. */ }
  }
  if (!persisted && hosts) snapshot = { kind: 'settings', owner, id: ++nextId }
  try { broadcast?.postMessage({ type: 'revoke', owner, version: AI_CONSENT_VERSION }) } catch { /* Current-page fencing and durable-save result remain truthful. */ }
  emit()
  return persisted
}

/** Existing leases never revive when the same account later accepts again. */
export const canaryAIPrivacyGate = {
  ensureAuthorized: ensureAIConsent,
  captureAuthorization(): () => boolean {
    // May be captured before the consent prompt so async callers retain their
    // original owner. It is false until approval; revocation never revives it.
    const issued = generation, issuedIdentity = identity()
    return () => issued === generation && issuedIdentity === identity() && hasAIConsent()
  },
  subscribeInvalidated(listener: () => void) { invalidations.add(listener); return () => { invalidations.delete(listener) } },
}

/** A missing prompt host fails closed. Also observe other tabs and replacement logins. */
export function mountAIConsentHost(): () => void {
  hosts++
  if (!broadcast && typeof BroadcastChannel === 'function') {
    try {
      broadcast = new BroadcastChannel(CHANNEL)
      broadcast.onmessage = event => {
        const data = event.data as { type?: unknown; owner?: unknown; version?: unknown } | null
        if (!data || data.type !== 'revoke' || data.owner !== aiConsentOwner() || data.version !== AI_CONSENT_VERSION) return
        // Works even when the sender cannot write localStorage. This is a
        // denial only; a broadcast can never grant permission or revive a lease.
        fallback.set(aiConsentOwner(), null)
        denyPending(); invalidate(); emit()
      }
    } catch { broadcast = null }
  }
  let previousIdentity = identity()
  const changed = () => {
    const next = identity()
    if (next !== previousIdentity) {
      previousIdentity = next
      denyPending(); invalidate(); emit()
    } else if (!hasAIConsent()) { invalidate(); emit() }
  }
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === aiConsentStorageKey()) {
      // A real cross-tab write supersedes a local storage-failure fallback.
      // Every receipt change fences old sessions, including later re-approval.
      if (event.key === null) fallback.clear()
      else fallback.delete(aiConsentOwner())
      denyPending(); invalidate(); emit()
      return
    }
    if (event.key === 'consumer_access_token' || event.key === 'consumer_session_identity') changed()
  }
  const unsubscribe = subscribeConsumerSession(changed)
  window.addEventListener('storage', storage)
  window.addEventListener('consumer:session-changed', changed)
  window.addEventListener('consumer:session-expired', changed)
  return () => {
    hosts--
    unsubscribe()
    window.removeEventListener('storage', storage)
    window.removeEventListener('consumer:session-changed', changed)
    window.removeEventListener('consumer:session-expired', changed)
    if (!hosts) {
      try { broadcast?.close() } catch { /* Already unavailable. */ }
      broadcast = null
      denyPending(); invalidate(); emit()
    }
  }
}
