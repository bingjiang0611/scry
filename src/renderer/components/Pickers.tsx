// Composer 选择器：工作目录（含 recent）/ 本地 CLI（local·api 后端 + rescan）。
import { useEffect, useId, useRef, useState } from 'react'
import { AGENT_ICON, basename } from '../format'
import { Icon, type IconName } from './primitives/Icon'
import type { DetectedAgent } from '../env'

export function WorkdirPicker({
  cwd,
  recent,
  onChoose,
  onUnbind,
  onPick,
  onRemove
}: {
  cwd: string | null
  recent: string[]
  onChoose: () => void
  onUnbind: () => void
  onPick: (d: string) => void
  onRemove: (d: string) => void
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const otherRecent = recent.filter((dir) => dir !== cwd)
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
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const actions = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
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
          <button
            type="button"
            className="mitem"
            onClick={() => {
              setOpen(false)
              onUnbind()
            }}
          >
            <Icon name="message" /> 不绑定项目
            {!cwd && <span className="ck"><Icon name="check" /> 当前</span>}
          </button>
          <button
            type="button"
            className="mitem"
            onClick={() => {
              setOpen(false)
              onChoose()
            }}
          >
            <Icon name="folder" /> 选择文件夹
          </button>
          {otherRecent.length > 0 && <div className="mhdr">最近使用</div>}
          <div className="wdrecent-list">
            {otherRecent.map((d) => (
              <div key={d} className="wdrecent-row">
                <button
                  type="button"
                  className="mitem wdrecent-pick"
                  title={d}
                  onClick={() => {
                    setOpen(false)
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
                  title="Remove from recent folders"
                  aria-label={`Remove ${d} from recent folders`}
                  onClick={() => onRemove(d)}
                >
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function CliPicker({
  agents,
  selectedId,
  onSelect,
  onRescan,
  disabled = false
}: {
  agents: DetectedAgent[]
  selectedId: string
  onSelect: (id: string) => void
  onRescan: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const sel = agents.find((a) => a.id === selectedId)
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  return (
    <div className="clipick">
      <button
        className="clibtn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? '同一会话不能切换 Agent；请新建会话后重新选择' : undefined}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
      >
        <span className="agicon">
          <Icon name={(AGENT_ICON[selectedId] ?? 'cube') as IconName} />
        </span>
        <span>{sel?.name ?? 'Agent'}</span>
        <Icon name={disabled ? 'lock' : 'chevronDown'} className="chev" />
      </button>
      {open && !disabled && (
        <div id={menuId} className="menu climenu" onMouseLeave={() => setOpen(false)}>
          <div className="cltitle">
            Local CLI
            <div className="dim">{sel?.name ?? '未检测到'}</div>
          </div>
          <div className="mhdr">CODE AGENT</div>
          {agents.length === 0 && <div className="dim pad">未检测到 agent CLI</div>}
          {agents.map((a) => (
            <button
              type="button"
              key={a.id}
              className="mitem"
              title={`${a.path}${a.version ? ' · ' + a.version : ''}`}
              onClick={() => {
                onSelect(a.id)
                setOpen(false)
              }}
            >
              <span className="agicon">
                <Icon name={(AGENT_ICON[a.id] ?? 'cube') as IconName} />
              </span>{' '}
              <span className="agent-option-name">{a.name}</span>
              {a.id === selectedId && <span className="ck"><Icon name="check" /> selected</span>}
            </button>
          ))}
          <div className="mdiv" />
          <button type="button" className="mitem" onClick={() => onRescan()}>
            <Icon name="refresh" /> Rescan PATH
          </button>
        </div>
      )}
    </div>
  )
}

export interface RunControlSelectOption {
  value: string
  label: string
  description?: string
}

export function RunControlSelect({
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  loading = false,
  tone
}: {
  ariaLabel: string
  value: string
  options: RunControlSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  loading?: boolean
  tone?: 'warning' | 'danger'
}) {
  const selected = options.find((option) => option.value === value)
  return (
    <label className={`run-control-select ${tone ?? ''}`} title={selected?.description}>
      <select
        aria-label={ariaLabel}
        aria-busy={loading}
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value} title={option.description}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" className="chev" />
    </label>
  )
}
