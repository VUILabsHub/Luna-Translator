import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createConsumerSessionGuard, getConsumerSessionRevision, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'
import { formatMeetingCode } from '@simultrans/core/meeting'
import { consumerHistoryCheckpointOwner, findActiveMeeting, type ActiveMeetingLookup } from '../lib/consumerHistory'
import { loadRejoinableMeetings, REJOINABLE_CHECK_FAILED, REJOINABLE_MEETING_GONE, type RejoinableMeeting } from '../lib/rejoinableMeetings'
import { historyLanguageName } from '../pages/SharedSessionPage'

function subscribeAccount(listener: () => void) {
  const unsubscribe = subscribeConsumerSession(listener)
  window.addEventListener('consumer:session-changed', listener)
  window.addEventListener('consumer:session-expired', listener)
  return () => { unsubscribe(); window.removeEventListener('consumer:session-changed', listener); window.removeEventListener('consumer:session-expired', listener) }
}
const accountSnapshot = () => JSON.stringify([consumerHistoryCheckpointOwner(), getConsumerSessionRevision()])

export function ConsumerHistoryRejoinableMeetings(props: { ongoing: ActiveMeetingLookup | null; refreshKey: string }) {
  const account = useSyncExternalStore(subscribeAccount, accountSnapshot, () => '')
  return consumerHistoryCheckpointOwner() ? <RejoinableCards key={account} {...props} /> : null
}

function RejoinableCards({ ongoing, refreshKey }: { ongoing: ActiveMeetingLookup | null; refreshKey: string }) {
  const [meetings, setMeetings] = useState<RejoinableMeeting[]>([])
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState('')
  const request = useRef(0)
  const checking = useRef(false)
  const actionController = useRef<AbortController | null>(null)
  const ongoingRef = useRef(ongoing)
  ongoingRef.current = ongoing
  useEffect(() => {
    checking.current = false; setPending('')
    let disposed = false
    const controllers = new Set<AbortController>()
    const refresh = async () => {
      if (checking.current || document.visibilityState === 'hidden') return
      const revision = ++request.current
      const current = createConsumerSessionGuard()
      const controller = new AbortController(); controllers.add(controller)
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const next = await loadRejoinableMeetings(undefined, controller.signal)
        if (!disposed && revision === request.current && current()) setMeetings(next)
      } catch { if (!disposed && revision === request.current && current()) setMeetings([]) }
      finally { clearTimeout(timeout); controllers.delete(controller) }
    }
    const foreground = () => { void refresh() }
    void refresh()
    const timer = setInterval(foreground, 30_000)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      disposed = true; request.current++; clearInterval(timer)
      actionController.current?.abort()
      controllers.forEach(controller => controller.abort())
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [refreshKey])
  // Remove expired evidence immediately, even while the next server refresh is pending.
  useEffect(() => {
    if (!meetings.length) return
    const expiry = Math.min(...meetings.map(meeting => Date.parse(meeting.expiresAt)))
    const timer = setTimeout(() => setMeetings(previous => previous.filter(meeting => Date.parse(meeting.expiresAt) > Date.now())), Math.min(2_147_483_647, Math.max(0, expiry - Date.now()) + 20))
    return () => clearTimeout(timer)
  }, [meetings])

  const rejoin = async (id: string) => {
    const currentMeetingNotice = '请先离开当前会议，再重新加入这场会议'
    if (ongoingRef.current) { setNotice(currentMeetingNotice); return }
    if (checking.current) return
    checking.current = true
    const revision = ++request.current
    const current = createConsumerSessionGuard()
    setPending(id); setNotice('')
    const controller = new AbortController()
    actionController.current = controller
    const timeout = setTimeout(() => controller.abort(), 8000)
    try {
      // Presence discovery can still be pending when the history card is first clicked.
      const [next, currentMeeting] = await Promise.all([
        loadRejoinableMeetings(undefined, controller.signal),
        findActiveMeeting(consumerHistoryCheckpointOwner()),
      ])
      if (revision !== request.current || !current()) return
      setMeetings(next)
      const selected = next.find(meeting => meeting.id === id)
      if (!selected) { setNotice(REJOINABLE_MEETING_GONE); return }
      if (ongoingRef.current || currentMeeting) { setNotice(currentMeetingNotice); return }
      // Pre-fill the existing join confirmation. This neither joins nor opens the microphone.
      window.location.assign(`/meeting?join=${encodeURIComponent(selected.code)}`)
    } catch {
      if (revision === request.current && current()) { setMeetings([]); setNotice(REJOINABLE_CHECK_FAILED) }
    } finally {
      clearTimeout(timeout)
      if (actionController.current === controller) actionController.current = null
      if (revision === request.current && current()) { checking.current = false; setPending('') }
    }
  }
  const visible = meetings.filter(meeting => meeting.code !== ongoing?.presence.code && Date.parse(meeting.expiresAt) > Date.now())
  if (!visible.length && !notice) return null
  return <section className="consumer-history-section consumer-history-rejoinable" aria-label="可重新加入的会议">
    {visible.length > 0 && <ol className="consumer-history-entries">
      {visible.map(meeting => <li className="consumer-history-entry" key={meeting.id}>
        <button type="button" className="consumer-history-entry-link consumer-history-rejoin-button" disabled={Boolean(pending)} aria-busy={pending === meeting.id}
          aria-label={`重新加入会议，会议码 ${formatMeetingCode(meeting.code)}`} onClick={() => { void rejoin(meeting.id) }}>
          <strong className="consumer-history-entry-title">会议同传 {formatMeetingCode(meeting.code)}</strong>
          <span className="consumer-history-rejoin-description">会议仍在进行</span>
          <span className="consumer-history-entry-foot">
            <span className="consumer-history-rejoin-action">{pending === meeting.id ? '正在确认…' : '重新加入'}</span>
            {meeting.targetLanguage && <span className="consumer-history-entry-languages">{historyLanguageName(meeting.targetLanguage, true)}</span>}
          </span>
        </button>
      </li>)}
    </ol>}
    {notice && <p className="consumer-history-rejoin-notice" role="status">{notice}</p>}
  </section>
}
