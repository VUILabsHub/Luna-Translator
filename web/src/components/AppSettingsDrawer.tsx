import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useBoundedDialog } from '../hooks/useBoundedDialog'
import '../styles/app-settings-drawer.css'

type AppSettingsDrawerProps = {
  id: string
  title: string
  open: boolean
  onClose: () => void
  containerSelector?: string
  dialogRef?: RefObject<HTMLDialogElement | null>
  contentRef?: RefObject<HTMLDivElement | null>
  bodyClassName?: string
  mountWhenClosed?: boolean
  children: ReactNode
}

/** A native modal whose shade and right panel both stay inside the portrait App. */
export function AppSettingsDrawer({
  id, title, open, onClose, containerSelector = '.realtime-showcase-device',
  dialogRef, contentRef, bodyClassName, mountWhenClosed = false, children,
}: AppSettingsDrawerProps) {
  const ownDialog = useRef<HTMLDialogElement>(null)
  const ownContent = useRef<HTMLDivElement>(null)
  const dialog = dialogRef ?? ownDialog
  const content = contentRef ?? ownContent
  const openRef = useRef(open)
  const onCloseRef = useRef(onClose)
  const closeNotified = useRef(false)
  openRef.current = open
  onCloseRef.current = onClose
  const measureBounds = useBoundedDialog(dialog, containerSelector, open)

  const notifyClose = () => {
    if (!openRef.current || closeNotified.current) return
    closeNotified.current = true
    onCloseRef.current()
  }
  const dismiss = () => {
    // Native close preserves the browser's modal focus restoration.
    if (dialog.current?.open) dialog.current.close()
    notifyClose()
  }

  useLayoutEffect(() => {
    const node = dialog.current
    if (!node) return
    if (!open) {
      if (node.open) node.close()
      return
    }
    closeNotified.current = false
    // Top-layer dialogs are viewport-relative, even inside a positioned App.
    // Set their App bounds before opening to avoid a frame at the browser edge.
    measureBounds()
    if (!node.open) node.showModal()
    // A closed native dialog has display:none: its scroll box cannot be reset
    // until showModal restores layout. Keep this in the same pre-paint effect.
    if (content.current) content.current.scrollTop = 0
  }, [open, dialog, content, measureBounds])

  useLayoutEffect(() => {
    const node = dialog.current
    return () => { if (node?.open) node.close() }
  }, [dialog])

  return <dialog
    id={id}
    ref={dialog}
    className="app-settings-drawer"
    aria-label={title}
    aria-labelledby={`${id}-title`}
    onClose={event => {
      // A queued native close from an earlier open must not close a reopened drawer.
      if (!event.currentTarget.open) notifyClose()
    }}
    onCancel={event => {
      // Nested language/device controls consume Escape before the modal cancels.
      if (event.defaultPrevented) return
      event.preventDefault()
      dismiss()
    }}
    onClick={event => { if (event.target === event.currentTarget) dismiss() }}
  >
    <div className="app-settings-drawer-panel">
      <header className="app-settings-drawer-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <button type="button" aria-label="关闭更多设置" onClick={dismiss}>×</button>
      </header>
      <div ref={content} className={`app-settings-drawer-body${bodyClassName ? ` ${bodyClassName}` : ''}`}>
        {(open || mountWhenClosed) && children}
      </div>
    </div>
  </dialog>
}
