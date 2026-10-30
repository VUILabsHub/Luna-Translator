import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import '../styles/showcase-language-picker.css'

export type LanguagePickerOption = { code: string; label: string; name: string; disabled?: boolean; ariaLabel?: string }
const names: Record<string, [string, string]> = {
  auto: ['自动', '自动识别'], zh: ['中', '中文'], en: ['英', '英语'], ja: ['日', '日语'], ko: ['韩', '韩语'], de: ['德', '德语'], fr: ['法', '法语'], ru: ['俄', '俄语'], pt: ['葡', '葡萄牙语'], es: ['西', '西班牙语'], it: ['意', '意大利语'], ar: ['阿', '阿拉伯语'], id: ['印', '印尼语'], vi: ['越', '越南语'], th: ['泰', '泰语'], ms: ['马', '马来语'], ur: ['乌', '乌尔都语'], tr: ['土', '土耳其语'], sw: ['斯', '斯瓦希里语'],
}
export function showcaseLanguageOption(code: string, name?: string): LanguagePickerOption {
  return { code, label: names[code]?.[0] || code, name: name || names[code]?.[1] || code }
}

/** Shared Quick Start language selector. Menus escape drawer scrolling while staying inside a native dialog's top layer. */
export function ShowcaseLanguagePicker({ ariaLabel, value, options, multiple = false, disabled = false, open, onOpenChange, onSelect, variant = 'source', canary = true, hint }: {
  ariaLabel: string; value: readonly string[]; options: readonly LanguagePickerOption[]; multiple?: boolean; disabled?: boolean; open: boolean; onOpenChange: (open: boolean) => void; onSelect: (code: string) => void; variant?: 'source' | 'target'; canary?: boolean; hint?: ReactNode
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0, width: 270, maxHeight: 320 })
  const [container, setContainer] = useState<Element | null>(null)
  const pendingFocus = useRef(false)
  const restore = () => { pendingFocus.current = true; onOpenChange(false) }
  useLayoutEffect(() => {
    if (open) { pendingFocus.current = false; return }
    if (!pendingFocus.current || disabled || !trigger.current?.isConnected) return
    const dialog = trigger.current.closest('dialog')
    if (dialog && !dialog.open) { pendingFocus.current = false; return }
    if (!trigger.current.getClientRects().length) return
    trigger.current.focus({ preventScroll: true })
    pendingFocus.current = false
  }, [open, disabled])
  useLayoutEffect(() => {
    if (!open) return
    setContainer(trigger.current?.closest('dialog') || document.body)
    const locate = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 270), innerWidth - 24)
      const expected = Math.min(320, options.length * (canary ? 47 : 44) + (hint ? 44 : 0) + 12)
      const below = innerHeight - rect.bottom - 16, above = rect.top - 16
      const flipped = below < expected && above > below
      const maxHeight = Math.max(44, Math.min(expected, flipped ? above : below))
      const next = { width, maxHeight, left: Math.max(12, Math.min(rect.left, innerWidth - width - 12)), top: flipped ? rect.top - maxHeight - 6 : rect.bottom + 6 }
      setPosition(previous => Object.keys(next).every(key => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next)
    }
    locate()
    window.addEventListener('resize', locate)
    window.addEventListener('scroll', locate, true)
    return () => { window.removeEventListener('resize', locate); window.removeEventListener('scroll', locate, true) }
  }, [open, options.length, Boolean(hint)])
  useEffect(() => {
    if (!open) return
    if (disabled) { onOpenChange(false); return }
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) onOpenChange(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, disabled, onOpenChange])
  useEffect(() => {
    if (!open || !container) return
    const selected = menu.current?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]:not(:disabled)')
    ;(selected || menu.current?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)'))?.focus({ preventScroll: true })
  }, [open, container])
  const portal = (node: ReactNode) => typeof document === 'undefined' ? node : container ? createPortal(node, container) : null
  return <div ref={root} className={`showcase-language-picker showcase-language-picker--${variant}${open ? ' is-open' : ''}`}>
    <button type="button" ref={trigger} className="showcase-language-picker-trigger" data-language-codes={value.join(',')} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
      onClick={() => onOpenChange(!open)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); onOpenChange(true) } if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); restore() } }}>
      <strong>{value.map(code => options.find(option => option.code === code)?.label || code).join(' \\ ')}</strong><img src="/showcase/chevron-down.svg" alt="" aria-hidden="true" />
    </button>
    {open && !disabled && portal(<div id={id} ref={menu} className={`showcase-language-picker-menu showcase-duo-language-list showcase-${variant}-language-list${!multiple ? ' is-single-select' : ''}${canary ? ' is-canary' : ''}`} role="listbox" aria-label={`${ariaLabel}选项`} aria-multiselectable={multiple || undefined} style={{ ...position, position: 'fixed', transform: 'none', zIndex: 10020 }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); return }
        const buttons = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index + buttons.length - 1) % buttons.length : -1
        if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); return }
        if (event.key === 'Tab') {
          event.preventDefault()
          const scope = trigger.current?.closest('dialog') || document
          const focusable = [...scope.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]')].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !menu.current?.contains(node) && node.getClientRects().length > 0)
          const current = focusable.indexOf(trigger.current!)
          onOpenChange(false)
          focusable[(current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length]?.focus()
        }
      }}>
      {hint}
      {options.map(option => <button key={option.code} type="button" role="option" data-language-code={option.code} aria-label={option.ariaLabel} aria-selected={value.includes(option.code)} disabled={option.disabled} tabIndex={-1} className={value.includes(option.code) ? 'is-selected' : ''}
        onClick={() => { if (option.disabled) return; onSelect(option.code); if (!multiple) restore() }}>
        <span><b>{option.label}</b><em>{option.name}</em></span><i aria-hidden="true" />
      </button>)}
    </div>)}
  </div>
}
