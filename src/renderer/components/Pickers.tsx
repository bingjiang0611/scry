// Agent 运行控件选择器（审批方式等）。
import { useEffect, useId, useRef } from 'react'
import { usePickerOpen, type PickerOpenProps, type RunControlSelectOption } from './picker-state'
export { ModelEffortPicker } from './ModelEffortPicker'
export type { RunControlSelectOption } from './picker-state'
import { Icon } from './primitives/Icon'

export function RunControlSelect({
  ariaLabel,
  prefix,
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  tone,
  open: controlledOpen,
  onOpenChange
}: {
  ariaLabel: string
  prefix?: string
  value: string
  options: RunControlSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  loading?: boolean
  tone?: 'warning' | 'danger'
} & PickerOpenProps) {
  const [open, setOpen] = usePickerOpen(controlledOpen, onOpenChange)
  const selected = options.find((option) => option.value === value)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionListRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const selectedIcon = value === 'full_access' ? 'alert' : value === 'auto_review' ? 'settings' : 'lock'
  const singleAvailableOption = options.filter((option) => !option.disabled).length === 1
  const displayedOptions = singleAvailableOption ? options.filter((option) => !option.disabled) : options

  useEffect(() => {
    if (loading || disabled) setOpen(false)
  }, [disabled, loading])

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => {
      const actions = Array.from(optionListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const current = actions.find((action) => action.getAttribute('aria-selected') === 'true') ?? actions[0]
      current?.focus()
    }, 0)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || pickerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [open])

  return (
    <div className={`run-control-select ${tone ?? ''}`} ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="permission-mode-trigger"
        title={selected?.description}
        aria-label={ariaLabel}
        aria-description={[selected?.label, selected?.description].filter(Boolean).join('：')}
        aria-busy={loading}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="listbox"
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Icon name={selectedIcon} className="rc-icon" />
        {prefix && <span className="rc-prefix" aria-hidden="true">{prefix}</span>}
        <span className="rc-value" aria-hidden="true">{selected?.label ?? ''}</span>
        <Icon name={singleAvailableOption ? 'info' : 'chevronDown'} className="chev" />
      </button>
      {open && (
        <div
          id={popoverId}
          ref={optionListRef}
          className={`permission-mode-popover${singleAvailableOption ? ' is-single-option' : ''}`}
          role="listbox"
          aria-label="Agent 操作审批方式"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const actions = Array.from(optionListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
            if (actions.length === 0) return
            event.preventDefault()
            const current = actions.indexOf(document.activeElement as HTMLButtonElement)
            const next = event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? actions.length - 1
                : event.key === 'ArrowUp'
                  ? (current <= 0 ? actions.length - 1 : current - 1)
                  : (current + 1) % actions.length
            actions[next]?.focus()
          }}
        >
          <div className="permission-mode-heading">
            {singleAvailableOption ? '当前 Agent 仅支持此权限模式' : '如何批准 Agent 操作？'}
          </div>
          {displayedOptions.map((option) => {
            const optionIcon = option.value === 'full_access' ? 'alert' : option.value === 'auto_review' ? 'settings' : 'lock'
            const isSelected = option.value === value
            return (
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`permission-mode-option${isSelected ? ' is-selected' : ''}${option.value === 'full_access' ? ' is-danger' : ''}`}
                key={option.value}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return
                  onChange(option.value)
                  setOpen(false)
                  triggerRef.current?.focus()
                }}
              >
                <Icon name={optionIcon} className="permission-mode-icon" />
                <span className="permission-mode-copy">
                  <strong>{option.label}</strong>
                  {option.description && <span>{option.description}</span>}
                </span>
                {isSelected && <Icon name="check" className="permission-mode-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
