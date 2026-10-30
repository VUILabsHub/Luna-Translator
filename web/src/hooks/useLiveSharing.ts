import { normalizeLiveShareSnapshot, liveShareRequestError } from '@simultrans/core/liveShareSnapshot'
import { useEffect, useRef, useState } from 'react'
import { sharePCMLimits, subscribeSharePCM } from '@simultrans/core/liveShareAudio'
import { consumerFetch } from '@simultrans/ui-shared/src/lib/consumerSession'
import type { ConsumerHistoryInput } from '../lib/consumerHistory'

export type ShareSnapshot = Pick<ConsumerHistoryInput, 'sessionId' | 'sourceLanguage' | 'targetLanguage' | 'durationMs' | 'sourceText' | 'translationText' | 'units'> & { targetLanguages?: string[] }
export type LivePublishStatus = 'live' | 'paused' | 'ended'
export type ShareLink = { token: string; url: string; expiresAt?: string }
const links = new Map<string, ShareLink>()
export const existingLiveShare = (sessionId: string) => links.get(sessionId)
export function forgetLiveShare(token: string) {
  for (const [sessionId, link] of links) if (link.token === token) links.delete(sessionId)
}
function publicSnapshot(v: ShareSnapshot) {
  return normalizeLiveShareSnapshot({ sessionId: v.sessionId, sourceLanguage: v.sourceLanguage, targetLanguage: v.targetLanguage, durationMs: v.durationMs,
    sourceText: v.sourceText, translationText: v.translationText, units: v.units,
    targetLanguages: v.targetLanguages || [...new Set([v.targetLanguage, ...v.units.flatMap(u => Object.keys(u.translations || {}))].filter(Boolean))] })
}
export function useLiveSharing(snapshot: ShareSnapshot | undefined, status: LivePublishStatus) {
  const latest = useRef({ snapshot, status }); latest.current = { snapshot, status }
  const [link, setLink] = useState<ShareLink>()
  const [stopped, setStopped] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const finishRef = useRef<(() => Promise<void>) | null>(null)
  const sessionId = snapshot?.sessionId || ''
  useEffect(() => { setLink(undefined); setStopped(false); setError('') }, [sessionId])
  useEffect(() => {
    if (!link || !sessionId) return
    let disposed = false, running = false, ended = false, seq = 0
    let queue: { sessionId: string; language: string; sampleRate: number; audio: string }[] = []
    let ending = false
    let endingSnapshot: ShareSnapshot | undefined
    let endingLimits: ReturnType<typeof sharePCMLimits> | undefined
    let pending: object | null = null
    let lastSnapshot = latest.current.snapshot
    const ids = sessionId.split(':')
    let lastLimits = sharePCMLimits(ids)
    const unsubscribe = subscribeSharePCM(chunk => {
      if (ended || !ids.includes(chunk.sessionId)) return
      const language = chunk.kind.startsWith('output-') ? chunk.kind.slice(7) : latest.current.snapshot?.targetLanguage || ''
      queue.push({ sessionId: chunk.sessionId, language, sampleRate: chunk.sampleRate, audio: chunk.audio })
      // A stalled uplink must never accumulate an entire recording.
      while (queue.reduce((n, item) => n + item.audio.length, 0) > 700_000) queue.shift()
    })
    const publish = async () => {
      if (running || ended || !latest.current.snapshot) return
      running = true
      if (!pending) {
        const current = latest.current
        lastSnapshot = endingSnapshot || current.snapshot
        lastLimits = endingLimits || sharePCMLimits(ids)
        pending = { snapshot: publicSnapshot(lastSnapshot!), status: ending ? 'ended' : current.status,
          publishSeq: ++seq, audio: queue, audioLimits: lastLimits }
        queue = []
      }
      try {
        const response = await consumerFetch(`/api/consumer/live-shares/${link.token}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), signal: AbortSignal.timeout(8000) })
        if (!response.ok) throw new Error(response.status === 410 ? '分享链接已失效' : '分享连接中断，正在重试')
        const result = await response.json() as { status: string }
        pending = null
        if (!disposed) setError('')
        if (result.status === 'ended') { ended = true; if (!disposed) setStopped(true); unsubscribe() }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '分享暂时不可用') }
      finally { running = false }
    }
    finishRef.current = async () => {
      if (!ending) {
        endingSnapshot = latest.current.snapshot
        endingLimits = sharePCMLimits(ids)
        unsubscribe()
      }
      ending = true
      const deadline = Date.now() + 10000
      while (!ended && !disposed && Date.now() < deadline) {
        await publish()
        if (!ended) await new Promise<void>(resolve => setTimeout(resolve, 100))
      }
    }
    const timer = setInterval(() => { void publish() }, 500)
    void publish()
    return () => {
      disposed = true; clearInterval(timer); unsubscribe(); finishRef.current = null
      // A route change or an empty-session reset must close the old share too.
      // The monotonic sequence makes an older in-flight heartbeat harmless.
      if (!ended && lastSnapshot) void consumerFetch(`/api/consumer/live-shares/${link.token}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot: publicSnapshot(endingSnapshot || lastSnapshot), status: 'ended', publishSeq: ++seq, audio: [], audioLimits: endingLimits || lastLimits }),
      }).catch(() => undefined)
    }
  }, [link, sessionId])
  const create = async () => {
    if (link) return link
    if (!snapshot || busy) return undefined
    setBusy(true); setError('')
    try {
      const response = await consumerFetch('/api/consumer/live-shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: publicSnapshot(snapshot), audioLimits: sharePCMLimits(sessionId.split(':')) }) })
      if (!response.ok) throw await liveShareRequestError(response)
      const data = await response.json() as { token: string; path: string; expiresAt: string }
      const next = { token: data.token, url: new URL(data.path, window.location.origin).href, expiresAt: data.expiresAt }
      links.set(sessionId, next); setLink(next); return next
    } catch (e) { setError(e instanceof Error ? e.message : '无法创建分享'); return undefined }
    finally { setBusy(false) }
  }
  return { link, stopped, error, busy, create, finish: () => finishRef.current?.() }
}
