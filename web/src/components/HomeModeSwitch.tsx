import { canaryDesignEnabled } from '../lib/canaryDesign'
import { useRef, useState, useEffect, type KeyboardEvent } from 'react'
import { HOME_MODE_OPTIONS, type WebHomeMode } from '../lib/homeModes'
import '../styles/home-modes.css'

export function HomeModeSwitch({ value, disabled = false, meetingAvailable, onChange }: {
  value: WebHomeMode
  disabled?: boolean
  meetingAvailable: boolean
  onChange: (mode: WebHomeMode) => void
}) {
  const canary = canaryDesignEnabled()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape) }
  }, [open])
  const buttons = useRef<Partial<Record<WebHomeMode, HTMLButtonElement | null>>>({})
  const choices = HOME_MODE_OPTIONS.filter(option => !canary || (option.value !== value && (option.value !== 'meeting' || meetingAvailable)))
  const available = choices.filter(option => !disabled && (option.value !== 'meeting' || meetingAvailable))
  const tabStop = available.some(option => option.value === value) ? value : available[0]?.value
  const move = (event: KeyboardEvent<HTMLButtonElement>, current: WebHomeMode) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !available.length) return
    event.preventDefault()
    const index = available.findIndex(option => option.value === current)
    const next = available[event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + available.length) % available.length].value
    buttons.current[next]?.focus()
    // Tabs activate while moving; the popover keeps focus in its choices until
    // Enter/Space selects one and restores focus to the persistent opener.
    if (!canary && next !== value) onChange(next)
  }

  if (canary) return <div ref={root} className="canary-home-mode-picker">
    <button ref={trigger} type="button" aria-label="选择同传模式" aria-expanded={open} disabled={disabled} onClick={() => { if (!disabled) setOpen(!open) }}><img src="/showcase/canary-figma/plus.svg" alt="" /></button>
    {open && <div className="canary-mode-popover" role="group" aria-label="同传模式">
      {choices.map(option => <button key={option.value} type="button" ref={element => { buttons.current[option.value] = element }} aria-pressed={value === option.value} disabled={disabled} onKeyDown={event => move(event, option.value)} onClick={() => { if (disabled || (option.value === 'meeting' && !meetingAvailable)) return; setOpen(false); trigger.current?.focus({ preventScroll: true }); onChange(option.value) }}><img src={`/showcase/canary-figma/${option.icon}.png`} alt="" /><span>{option.label}</span></button>)}
    </div>}
  </div>
  return <div className="home-mode-switch" role="tablist" aria-label="同传模式">
    {HOME_MODE_OPTIONS.map(option => {
      const blocked = disabled || (option.value === 'meeting' && !meetingAvailable)
      return <button key={option.value} type="button" role="tab"
        ref={element => { buttons.current[option.value] = element }}
        data-mode={option.value} aria-label={option.label} aria-selected={value === option.value}
        disabled={blocked} tabIndex={tabStop === option.value ? 0 : -1}
        title={option.value === 'meeting' && !meetingAvailable ? '会议暂不可用，请登录后重试或稍后再试。' : undefined}
        onKeyDown={event => move(event, option.value)}
        onClick={() => { if (!blocked && value !== option.value) onChange(option.value) }}>
        {option.value === 'solo' && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg>}
        <span>{option.label}</span>
      </button>
    })}
  </div>
}
