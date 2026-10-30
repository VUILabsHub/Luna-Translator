import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createConsumerSessionGuard, getConsumerSessionRevision, subscribeConsumerSession } from '@simultrans/ui-shared/src/lib/consumerSession'
import { activeConsumerHistoryShare, consumerHistoryCheckpointOwner, createConsumerShareLink, loadConsumerHistory, lookupConsumerHistoryId, retryConsumerHistoryCheckpoints, revokeConsumerShareLink } from '../lib/consumerHistory'
import { forgetLiveShare, type ShareLink } from '../hooks/useLiveSharing'
import { SessionShareDialog } from './SessionShareDialog'
import { ShowcaseConfirmDialog } from './ShowcaseConfirmDialog'

type RecordShareProps = { historyId: string; sessionId: string; saving: boolean; onResolved: (id: string) => void }
function subscribeAccount(listener: () => void) {
  const unsubscribe = subscribeConsumerSession(listener)
  window.addEventListener('consumer:session-changed', listener)
  window.addEventListener('consumer:session-expired', listener)
  return () => { unsubscribe(); window.removeEventListener('consumer:session-changed', listener); window.removeEventListener('consumer:session-expired', listener) }
}
const accountSnapshot = () => JSON.stringify([consumerHistoryCheckpointOwner(), getConsumerSessionRevision()])

/** Canary record sharing uses the owner's server state, never a stale live-share cache. */
export function ConsumerRecordShare(props: RecordShareProps) {
  const account = useSyncExternalStore(subscribeAccount, accountSnapshot, () => '')
  return <RecordShareControls key={`${account}:${props.sessionId || props.historyId}`} {...props} />
}

function RecordShareControls({ historyId, sessionId, saving, onResolved }: RecordShareProps) {
  const [link, setLink] = useState<ShareLink>()
  const [revokedLink, setRevokedLink] = useState<ShareLink>()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [notice, setNotice] = useState('')
  const request = useRef(0)
  const operationPending = useRef(false)
  const openRef = useRef(open); openRef.current = open
  const resolvedId = useRef(historyId)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const begin = () => {
    const version = ++request.current
    const sessionCurrent = createConsumerSessionGuard()
    return () => request.current === version && sessionCurrent()
  }
  const fromRecord = (record: Awaited<ReturnType<typeof loadConsumerHistory>>) => {
    const share = activeConsumerHistoryShare(record.share)
    return share ? { token: share.token, url: `${window.location.origin}${share.path}`, expiresAt: share.expiresAt } : undefined
  }
  useEffect(() => () => { request.current++ }, [])
  useEffect(() => {
    if (!historyId) return
    resolvedId.current = historyId
    if (operationPending.current) return
    const current = begin()
    void loadConsumerHistory(historyId).then(record => { if (current()) setLink(fromRecord(record)) }).catch(() => undefined)
  }, [historyId])

  const show = async () => {
    if (operationPending.current) return
    operationPending.current = true
    const current = begin()
    setBusy(true); setNotice(''); setRevokedLink(undefined)
    try {
      let id = historyId || resolvedId.current
      if (!id && !saving && sessionId) {
        await retryConsumerHistoryCheckpoints().catch(() => undefined)
        id = await lookupConsumerHistoryId(sessionId)
      }
      if (!current()) return
      if (!id) { setNotice('保存中，请稍等几秒钟'); return }
      resolvedId.current = id
      // Re-read on each opening: a different device may have revoked or created it.
      const existing = fromRecord(await loadConsumerHistory(id))
      if (!current()) return
      setLink(existing)
      if (existing) setOpen(true)
      else setConfirm(true)
      setBusy(false)
      if (!historyId) onResolved(id)
    } catch { if (current()) setNotice('无法读取分享状态，请检查网络后重试') }
    finally { if (current()) { operationPending.current = false; setBusy(false) } }
  }
  const create = async () => {
    if (operationPending.current) return
    operationPending.current = true
    const current = begin()
    setConfirm(false); setBusy(true); setNotice('')
    try {
      const created = await createConsumerShareLink(resolvedId.current, window.location.origin)
      if (current()) { setLink(created); setOpen(true) }
    } catch { if (current()) setNotice('无法生成分享链接，请重试') }
    finally { if (current()) { operationPending.current = false; setBusy(false) } }
  }
  const revoke = async () => {
    if (!link || operationPending.current) return
    operationPending.current = true
    const current = begin()
    const previous = link
    setRevoking(true); setNotice('')
    try {
      await revokeConsumerShareLink(previous.token)
      if (current()) {
        forgetLiveShare(previous.token)
        setRevokedLink(previous); setLink(undefined)
        setNotice('分享链接已撤销，原链接立即失效')
      }
    } catch { if (current()) setNotice('撤销未完成，请重试；暂时不要继续转发此链接') }
    finally { if (current()) { operationPending.current = false; setRevoking(false); if (!openRef.current) requestAnimationFrame(() => trigger.current?.focus()) } }
  }
  return <div className="showcase-session-share">
    <ShowcaseConfirmDialog open={confirm} title="确认分享本次会话" titleId={titleId}
      onDismiss={() => { setConfirm(false); requestAnimationFrame(() => trigger.current?.focus()) }}
      actions={[
        { label: '取消', onClick: () => { setConfirm(false); requestAnimationFrame(() => trigger.current?.focus()) } },
        { label: '确认分享', primary: true, onClick: () => { void create() } },
      ]}>
      <p>分享后任何人可通过链接查看本次原文与译文，并播放录音原音和译文音频，链接 30 天后自动失效。</p>
    </ShowcaseConfirmDialog>
    <SessionShareDialog canary link={open ? link || revokedLink : undefined} revoked={Boolean(revokedLink)}
      revoking={revoking} onRevoke={() => { void revoke() }} revokeNotice={notice}
      onClose={() => { setOpen(false); trigger.current?.focus() }} />
    <button ref={trigger} type="button" aria-label={link ? '分享中，点击分享' : '点击分享'} aria-busy={busy} disabled={busy || revoking}
      onClick={() => { void show() }}>
      {!saving && !busy && <img src="/showcase/share.svg" alt="" aria-hidden="true" />}
      {saving ? '保存中…' : busy ? '正在处理…' : link ? '分享中' : '分享'}
    </button>
    {notice && !open && <span className="showcase-session-share-toast" role="status">{notice}</span>}
  </div>
}
