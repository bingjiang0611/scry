// Composer 选择器：工作目录（含 recent）/ 本地 CLI（local·api 后端 + rescan）。
import { useEffect, useId, useRef } from 'react'
import { usePickerOpen, type PickerOpenProps, type RunControlSelectOption } from './picker-state'
export { ModelEffortPicker } from './ModelEffortPicker'
export type { RunControlSelectOption } from './picker-state'
import { providerIdForAgentId } from '@shared/runtime'
import { basename } from '../format'
import { PI_PICKER_COPY } from '../constants/copy'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import type { DetectedAgent } from '../env'

export interface AgentProviderGroup {
  id: string
  agents: DetectedAgent[]
}

export function groupAgentsByProvider(agents: DetectedAgent[]): AgentProviderGroup[] {
  const groups = new Map<string, DetectedAgent[]>()
  for (const agent of agents) {
    const id = providerIdForAgentId(agent.id) ?? agent.id
    groups.set(id, [...(groups.get(id) ?? []), agent])
  }
  return [...groups].map(([id, groupedAgents]) => ({ id, agents: groupedAgents }))
}

function isDetectedPiProfile(id: string): boolean {
  return id === 'pi' || id === 'pi:default' || id === 'pi:rotom'
}

export function piProfileName(agent: DetectedAgent): string {
  if (agent.id === 'pi:default') return PI_PICKER_COPY.nativePi
  return agent.name.replace(/^Pi\s*·\s*/, '') || basename(agent.path)
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
              title="Remove from recent folders"
              aria-label={`Remove ${d} from recent folders`}
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

// Remote agents use `${providerId}:${profile}` ids; the prefix still names the Provider.
function agentGlyphProvider(agentId: string) {
  return providerIdForAgentId(agentId) ?? providerIdForAgentId(agentId.split(':')[0])
}

export function CliPicker({
  agents,
  selectedId,
  onSelect,
  onAddPi,
  onRemovePi,
  onRescan,
  scopeLabel = '本机 Agent',
  unavailableIds,
  disabled = false,
  open: controlledOpen,
  onOpenChange
}: {
  agents: DetectedAgent[]
  selectedId: string
  onSelect: (id: string) => void
  // Local-only management actions. A remote host owns its own Provider install,
  // so the remote composer omits them instead of offering actions that cannot apply.
  onAddPi?: () => void
  onRemovePi?: (id: string) => void
  onRescan?: () => void
  scopeLabel?: string
  // Listed but not selectable, e.g. a remote Provider the host reports unavailable.
  unavailableIds?: ReadonlySet<string>
  disabled?: boolean
} & PickerOpenProps) {
  const [open, setOpen] = usePickerOpen(controlledOpen, onOpenChange)
  const menuId = useId()
  const sel = agents.find((a) => a.id === selectedId)
  const selectedProvider = agentGlyphProvider(sel?.id ?? selectedId)
  const piProfiles = agents.filter((agent) => providerIdForAgentId(agent.id) === 'pi')
  const detectedPiByPath = new Map(piProfiles
    .filter((agent) => agent.id === 'pi:default' || agent.id === 'pi:rotom')
    .map((agent) => [agent.path, agent]))
  const selectedPi = piProfiles.find((agent) => agent.id === selectedId)
  // Main supplies canonical paths. Collapse only detected/saved launcher aliases;
  // keep a selected historical ID visible without silently switching the session.
  const piAgents = piProfiles.filter((agent) => {
    const detected = detectedPiByPath.get(agent.path)
    if (!detected) return true
    const representative = selectedPi?.path === agent.path ? selectedPi : detected
    return agent.id === representative.id
  })
  const codeAgents = agents.filter((agent) => providerIdForAgentId(agent.id) !== 'pi')
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  return (
    <div className="clipick">
      <button
        className="clibtn"
        data-agent-id={selectedId}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? '当前状态暂不能切换 Agent' : '选择下一条消息使用的 Agent'}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="menu"
      >
        <span className="agicon">
          {selectedProvider ? <ProviderGlyph provider={selectedProvider} /> : <Icon name="cube" />}
        </span>
        <span>{sel?.name ?? 'Agent'}</span>
        <Icon name={disabled ? 'lock' : 'chevronDown'} className="chev" />
      </button>
      {open && !disabled && (
        <div id={menuId} className="menu climenu" onMouseLeave={() => setOpen(false)}>
          <div className="cltitle">
            {scopeLabel}
            <div className="dim">{sel?.name ?? '未检测到'}</div>
          </div>
          <div className="mhdr">Provider</div>
          {agents.length === 0 && <div className="dim pad">未检测到 agent CLI</div>}
          {codeAgents.map((a) => (
            <button
              type="button"
              key={a.id}
              className="mitem"
              data-agent-id={a.id}
              title={`${a.path}${a.version ? ' · ' + a.version : ''}`}
              disabled={unavailableIds?.has(a.id)}
              onClick={() => {
                onSelect(a.id)
                setOpen(false)
              }}
            >
              <span className="agicon">
                <ProviderGlyph provider={agentGlyphProvider(a.id) ?? 'claude'} />
              </span>{' '}
              <span className="agent-option-name">{a.name}{unavailableIds?.has(a.id) && a.id !== selectedId ? ' · 不可用' : ''}</span>
              {a.id === selectedId && <span className="ck"><Icon name="check" /> 当前</span>}
            </button>
          ))}
          {piAgents.length > 0 && <div className="mhdr">Pi · Profiles</div>}
          {piAgents.map((agent) => (
            <div className="agent-option-row" key={agent.id}>
              <button
                type="button"
                className="mitem agent-option-pick"
                data-agent-id={agent.id}
                title={agent.path}
                disabled={unavailableIds?.has(agent.id)}
                onClick={() => {
                  onSelect(agent.id)
                  setOpen(false)
                }}
              >
                <span className="agicon"><ProviderGlyph provider="pi" /></span>
                <span className="agent-option-copy">
                  <b>{piProfileName(agent)}</b>
                  <small>{PI_PICKER_COPY.detail(isDetectedPiProfile(agent.id), agent.version)}</small>
                </span>
                {agent.id === selectedId && <span className="ck"><Icon name="check" /> 当前</span>}
              </button>
              {!isDetectedPiProfile(agent.id) && onRemovePi && (
                <button
                  type="button"
                  className="agent-option-remove"
                  title={PI_PICKER_COPY.removeTitle}
                  aria-label={PI_PICKER_COPY.removeLabel(piProfileName(agent))}
                  onClick={() => onRemovePi(agent.id)}
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
          ))}
          {(onAddPi || onRescan) && <div className="mdiv" />}
          {onAddPi && (
            <button type="button" className="mitem" onClick={() => { onAddPi(); setOpen(false) }}>
              <Icon name="plus" /> 添加 Pi Agent…
            </button>
          )}
          {onRescan && (
            <button type="button" className="mitem" onClick={() => onRescan()}>
              <Icon name="refresh" /> 重新扫描 PATH
            </button>
          )}
        </div>
      )}
    </div>
  )
}

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
