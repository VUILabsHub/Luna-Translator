import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

export type ShowcaseComboboxOption = {
  value: string
  label: string
  disabled?: boolean
}

type ShowcaseComboboxProps = {
  ariaLabel: string
  className: string
  disabled?: boolean
  options: ShowcaseComboboxOption[]
  value: string
  onChange: (value: string) => void
  onOpen?: () => void
  renderTrigger: (option: ShowcaseComboboxOption | undefined, open: boolean) => ReactNode
  renderOption?: (option: ShowcaseComboboxOption, selected: boolean) => ReactNode
}

const selectableIndexes = (options: ShowcaseComboboxOption[]) => (
  options.flatMap((option, index) => option.disabled ? [] : [index])
)

export default function ShowcaseCombobox({
  ariaLabel,
  className,
  disabled = false,
  options,
  value,
  onChange,
  onOpen,
  renderTrigger,
  renderOption,
}: ShowcaseComboboxProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined
  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined

  useEffect(() => {
    if (!open) return undefined
    const selectable = selectableIndexes(options)
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : selectable[0] ?? -1)
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick)
  }, [open, options, selectedIndex])

  const openList = () => {
    onOpen?.()
    setOpen(true)
  }

  const moveActive = (direction: 1 | -1) => {
    const selectable = selectableIndexes(options)
    if (selectable.length === 0) return
    const current = selectable.indexOf(activeIndex)
    const next = current < 0
      ? (direction === 1 ? 0 : selectable.length - 1)
      : (current + direction + selectable.length) % selectable.length
    setActiveIndex(selectable[next])
  }

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        const selectable = selectableIndexes(options)
        setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled
          ? selectedIndex
          : (event.key === 'ArrowDown' ? selectable[0] : selectable.at(-1)) ?? -1)
        openList()
      } else {
        moveActive(event.key === 'ArrowDown' ? 1 : -1)
      }
      return
    }
    if (event.key === 'Home' && open) {
      event.preventDefault()
      setActiveIndex(selectableIndexes(options)[0] ?? -1)
      return
    }
    if (event.key === 'End' && open) {
      event.preventDefault()
      setActiveIndex(selectableIndexes(options).at(-1) ?? -1)
      return
    }
    if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault()
      choose(activeIndex)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={rootRef} className={`realtime-showcase-combobox ${className}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="realtime-showcase-combobox-trigger"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={activeOptionId}
        data-value={value}
        disabled={disabled || options.length === 0}
        onClick={() => { if (open) setOpen(false); else openList() }}
        onKeyDown={handleKeyDown}
      >
        {renderTrigger(selected, open)}
      </button>

      {open && (
        <div id={listboxId} className="realtime-showcase-combobox-list" role="listbox" aria-label={`${ariaLabel}选项`}>
          {options.map((option, index) => {
            const isSelected = option.value === value
            return (
              <div
                id={`${listboxId}-option-${index}`}
                key={option.value}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={`${isSelected ? 'is-selected ' : ''}${activeIndex === index ? 'is-active ' : ''}${option.disabled ? 'is-disabled' : ''}`.trim()}
                onClick={() => choose(index)}
                onPointerMove={() => { if (!option.disabled) setActiveIndex(index) }}
              >
                {renderOption ? renderOption(option, isSelected) : option.label}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
