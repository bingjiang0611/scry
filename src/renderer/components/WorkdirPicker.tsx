// Composer 工作目录选择器：当前绑定、最近使用、解绑与移除历史。
import { useEffect, useId, useRef } from 'react'
import { usePickerOpen, type PickerOpenProps } from './picker-state'
import { basename } from '../format'
import { WORKDIR_PICKER_COPY } from '../constants/copy'
import { Icon } from './primitives/Icon'

// Arrow/Home/End move between enabled menu buttons. Shared by composer context menus.
export function moveMenuFocus(event: { key: string; preventDefault: () => void }, menu: HTMLElement | null): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const actions = Array.from(menu?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
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
}

export function WorkdirPicker({
  cwd,
  recent,
  onChoose,
  onUnbind,
  onPick,
  onRemove,
  open: controlledOpen,
  onOpenChange
}: {
  cwd: string | null
  recent: string[]
  onChoose: () => void
  onUnbind: () => void
  onPick: (d: string) => void
  onRemove: (d: string) => void
} & PickerOpenProps) {
  const [open, setOpen] = usePickerOpen(controlledOpen, onOpenChange)
  const menuId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), 0)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      buttonRef.current?.focus()
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
    <div className="wdpick" ref={pickerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="wdbtn"
        title={cwd ?? '不绑定项目'}
        aria-label={`工作目录：${cwd ?? '不绑定项目'}`}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      >
        <Icon name="folder" />
        <span className="workdir-label">{cwd ? basename(cwd) : '不绑定项目'}</span>
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          className="menu wdmenu"
          role="dialog"
          aria-label="选择工作目录"
          onKeyDown={(event) => moveMenuFocus(event, menuRef.current)}
        >
          <WorkdirMenuItems
            cwd={cwd}
            recent={recent}
            onClose={() => setOpen(false)}
            onChoose={onChoose}
            onUnbind={onUnbind}
            onPick={onPick}
            onRemove={onRemove}
          />
        </div>
      )}
    </div>
  )
}

// Local workdir choices. `cwd` is the current local binding; pass `current={false}`
// when the composer currently targets another machine so nothing is marked current.
export function WorkdirMenuItems({
  cwd,
  recent,
  current = true,
  onClose,
  onChoose,
  onUnbind,
  onPick,
  onRemove
}: {
  cwd: string | null
  recent: string[]
  current?: boolean
  onClose: () => void
  onChoose: () => void
  onUnbind: () => void
  onPick: (d: string) => void
  onRemove: (d: string) => void
}) {
  const listed = current ? recent.filter((dir) => dir !== cwd) : recent
  return (
    <>
      <button
        type="button"
        className="mitem"
        onClick={() => {
          onClose()
          onUnbind()
        }}
      >
        <Icon name="message" /> 不绑定项目
        {current && !cwd && <span className="ck"><Icon name="check" /> 当前</span>}
      </button>
      <button
        type="button"
        className="mitem"
        onClick={() => {
          onClose()
          onChoose()
        }}
      >
        <Icon name="folder" /> 选择文件夹
      </button>
      {listed.length > 0 && <div className="mhdr">最近使用</div>}
      <div className="wdrecent-list">
        {listed.map((d) => (
          <div key={d} className="wdrecent-row">
            <button
              type="button"
              className="mitem wdrecent-pick"
              title={d}
              onClick={() => {
                onClose()
                onPick(d)
              }}
            >
              <Icon name="clock" />
              <span className="wdrecent-copy">
                <b>{basename(d)}</b>
                <code>{d}</code>
              </span>
            </button>
            <button
              type="button"
              className="wdrecent-remove"
              title={WORKDIR_PICKER_COPY.removeRecentTitle}
              aria-label={WORKDIR_PICKER_COPY.removeRecentLabel(d)}
              onClick={() => onRemove(d)}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
