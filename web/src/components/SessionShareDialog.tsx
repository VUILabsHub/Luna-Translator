import { trackProduct } from '@simultrans/ui-shared/src/lib/productAnalytics'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ShareLink } from '../hooks/useLiveSharing'
import { useActionToast } from './ActionToast'
import '../styles/session-share-dialog.css'

/** 二维码的替代文字与保存的文件名：会议记录写「会议记录分享」，其余（含实时同传）仍是「同传分享」。 */
export const shareQRCopy = (meeting: boolean) => {
  const subject = meeting ? '会议记录分享' : '同传分享'
  return { alt: `打开本次${subject}的二维码`, filename: `Luna-${subject}.png` }
}

/** meeting：会议记录只有文字，标题写「分享会议记录」、不许诺回听译音（分享前的提醒由 FinishedSessionView 先弹）。 */
export function SessionShareDialog({ link, live = false, meeting = false, onClose, onFinish, initialView, canary = false, revoked = false, revoking = false, onRevoke, revokeNotice = '' }: { canary?: boolean; initialView?: 'qr' | 'link'; link?: ShareLink; live?: boolean; meeting?: boolean; onClose: () => void; onFinish?: () => void; revoked?: boolean; revoking?: boolean; onRevoke?: () => void; revokeNotice?: string }) {
  const [qr, setQR] = useState('')
  const [notice, setNotice] = useState('')
  const [actionPending, setActionPending] = useState(false)
  const actionRequest = useRef(0)
  const { toast, showToast, clearToast } = useActionToast()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    actionRequest.current++
    setActionPending(false)
    clearToast()
    if (!link) return
    let cancelled = false
    setNotice(''); setQR('')
    void import('qrcode').then(m => m.toDataURL(link.url, { width: 288, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#0a0f0a', light: '#ffffff' } })).then(url => { if (!cancelled) setQR(url) }).catch(() => { if (!cancelled) setNotice('二维码生成失败，请使用链接') })
    const previous = document.activeElement as HTMLElement | null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { cancelled = true; actionRequest.current++; previous?.focus() }
  }, [link?.token, link?.url, clearToast])
  useEffect(() => {
    if (!revoked) return
    actionRequest.current++
    setActionPending(false); clearToast()
    panel.current?.querySelector<HTMLButtonElement>('.session-share-close')?.focus()
  }, [revoked, clearToast])
  if (!link) return null
  const copy = async () => {
    if (revoked || revoking) return
    const request = ++actionRequest.current
    clearToast(); setActionPending(true)
    try {
      await navigator.clipboard.writeText(link.url)
      if (request !== actionRequest.current) return
      trackProduct('share_link_copied', { result: 'success' })
      showToast('已复制分享链接')
    } catch { if (request === actionRequest.current) showToast('复制未成功，请长按下方链接复制', true) }
    finally { if (request === actionRequest.current) setActionPending(false) }
  }
  const share = async () => {
    if (revoked || revoking) return
    if (!navigator.share) { await copy(); return }
    const request = ++actionRequest.current
    clearToast(); setActionPending(true)
    try {
      await navigator.share({ title: live ? 'Luna 实时同传' : meeting ? 'Luna 会议记录' : 'Luna 同传记录', url: link.url })
      if (request === actionRequest.current) showToast('已交给系统分享')
    } catch (error) {
      if (request === actionRequest.current && !(error instanceof Error && error.name === 'AbortError')) {
        showToast('分享未完成，请重试或复制链接', true)
      }
    } finally { if (request === actionRequest.current) setActionPending(false) }
  }
  const heading = live ? '分享实时同传' : meeting ? '分享会议记录' : '分享同传记录'
  const qrCopy = shareQRCopy(meeting && !live)
  return createPortal(<div className="session-share-overlay" onClick={onClose} onKeyDown={event => {
    if (event.key === 'Escape') onClose()
    if (event.key === 'Tab') {
      const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]'); if (!items?.length) return
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }}>
    <div className={`session-share-dialog${canary ? live ? ' canary-share-panel' : ' canary-record-share-panel' : ''}${revoked ? ' is-revoked' : ''}`} ref={panel} role="dialog" aria-modal="true" aria-label={heading} onClick={event => event.stopPropagation()}>
      <button className="session-share-close" aria-label="关闭分享" onClick={onClose}>{canary && live ? <img src="/showcase/canary-figma/share-close.svg" alt="" /> : '×'}</button>
      <h2>{heading}</h2>
      <p>{initialView === 'link' ? '把链接发给听众，即可查看字幕、收听译音' : live ? canary ? '扫码或打开链接，无需登录即可收听译音、查看字幕' : '可用微信、浏览器扫码，收听译音、查看字幕' : meeting ? '可用微信、浏览器扫码，查看会议文字记录' : '可用微信、浏览器扫码，查看文字与回听译音'}</p>
      {initialView !== 'link' && (revoked ? <div className="session-share-qr session-share-revoked-qr">链接已撤销</div> : qr ? <img className="session-share-qr" src={qr} alt={qrCopy.alt} /> : <div className="session-share-qr">正在生成二维码…</div>)}
      {revoked ? <span className="session-share-url">{link.url}</span> : <a className="session-share-url" href={link.url} target="_blank" rel="noreferrer">{link.url}</a>}
      <div className="session-share-options"><button disabled={actionPending || revoked || revoking} onClick={() => { void copy() }}>复制链接</button>{initialView !== 'link' && (revoked || revoking ? <button disabled>保存二维码</button> : qr && <a href={qr} download={qrCopy.filename} onClick={() => showToast('已发起二维码下载，请查看浏览器下载记录')}>保存二维码</a>)}<button disabled={actionPending || revoked || revoking} onClick={() => { void share() }}>{canary && live ? <><img src="/showcase/canary-figma/share-more.svg" alt="" />更多</> : '更多分享'}</button></div>
      <p>{revoked ? '原链接已失效，访问者将无法打开' : '获得链接的人可以访问本次分享内容'}</p>
      {onRevoke && <button className="session-share-finish" disabled={revoked || revoking || actionPending} onClick={onRevoke}>{revoked ? '已撤销' : revoking ? '正在撤销…' : '撤销分享'}</button>}
      {live && onFinish && <button className="session-share-finish" onClick={onFinish}>结束实时分享</button>}
      <span role="status">{revokeNotice || notice}</span>
      {toast}
    </div>
  </div>, document.body)
}
