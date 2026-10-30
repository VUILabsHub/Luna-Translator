import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
export function LiveShareConfirmation({ onResult }: { onResult: (accepted: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); return () => previous?.focus() }, [])
  return createPortal(<div className="session-share-overlay canary-share-confirm-overlay" onClick={() => onResult(false)} onKeyDown={event => {
    if (event.key === 'Escape') onResult(false)
    if (event.key === 'Tab') { const buttons = panel.current?.querySelectorAll('button'); if (!buttons?.length) return; const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() } }
  }}><div ref={panel} role="alertdialog" aria-modal="true" aria-labelledby="canary-share-confirm-title" aria-describedby="canary-share-confirm-note" className="canary-share-confirm" onClick={event => event.stopPropagation()}>
    <h2 id="canary-share-confirm-title">开始实时分享？</h2><p id="canary-share-confirm-note">获得链接的人无需登录即可查看本次同传字幕并收听分享的译文语音。后续字幕和译音会持续更新，您可在分享面板中结束实时分享。</p><div><button onClick={() => onResult(false)}>取消</button><button onClick={() => onResult(true)}>开始分享</button></div>
  </div></div>, document.body)
}
