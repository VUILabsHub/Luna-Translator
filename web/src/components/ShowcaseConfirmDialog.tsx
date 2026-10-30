// 通用确认弹窗：原生 <dialog> + showModal，样式沿用「配置回声消除」弹窗那一套
// （showcase-confirm-dialog，见 styles/showcase-multilingual.css）。手机浏览器的
// 环境提示 / 连接麦克风 / 内测提示，以及桌面的回声消除引导都基于它渲染。
import { useEffect, useRef, type ReactNode } from 'react'

export type ShowcaseConfirmDialogAction = {
  label: string
  /** 主按钮：实心样式并在打开时获得焦点；缺省时第一个按钮获得焦点。 */
  primary?: boolean
  onClick: () => void
}

export function ShowcaseConfirmDialog({
  open,
  title,
  titleId,
  className,
  children,
  actions,
  onDismiss,
}: {
  open: boolean
  title: string
  titleId: string
  className?: string
  children?: ReactNode
  actions: ShowcaseConfirmDialogAction[]
  /** Esc 关闭时的回调；不传则 Esc 无效，只能点按钮。 */
  onDismiss?: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const focusRef = useRef<HTMLButtonElement>(null)
  const focusIndex = Math.max(0, actions.findIndex((action) => action.primary))

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
      focusRef.current?.focus()
    }
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      className={['showcase-confirm-dialog', className].filter(Boolean).join(' ')}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onDismiss?.()
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="showcase-confirm-dialog__content">
        <h2 id={titleId}>{title}</h2>
        {children}
        <div className="showcase-confirm-dialog__actions">
          {actions.map((action, index) => (
            <button
              key={action.label}
              ref={index === focusIndex ? focusRef : undefined}
              type="button"
              className={action.primary ? 'is-primary' : ''}
              onClick={action.onClick}
            >{action.label}</button>
          ))}
        </div>
      </div>
    </dialog>
  )
}
