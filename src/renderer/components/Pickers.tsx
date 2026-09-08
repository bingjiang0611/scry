// Composer 选择器：工作目录（含 recent）/ 本地 CLI（local·api 后端 + rescan）。
import { useEffect, useId, useRef, useState } from 'react'
import { providerIdForAgentId } from '@shared/runtime'
import { AGENT_ICON, basename } from '../format'
import { Icon, type IconName } from './primitives/Icon'
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

export function piProfileName(agent: DetectedAgent): string {
  if (agent.id === 'pi:default') return '原生 Pi'
  return agent.name.replace(/^Pi\s*·\s*/, '') || basename(agent.path)
}

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
  onAddPi,
  onRemovePi,
  onRescan,
  disabled = false
}: {
  agents: DetectedAgent[]
  selectedId: string
  onSelect: (id: string) => void
  onAddPi: () => void
  onRemovePi: (id: string) => void
  onRescan: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const sel = agents.find((a) => a.id === selectedId)
  const piAgents = agents.filter((agent) => providerIdForAgentId(agent.id) === 'pi')
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
            本机 Agent
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
              onClick={() => {
                onSelect(a.id)
                setOpen(false)
              }}
            >
              <span className="agicon">
                <Icon name={(AGENT_ICON[a.id] ?? 'cube') as IconName} />
              </span>{' '}
              <span className="agent-option-name">{a.name}</span>
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
                onClick={() => {
                  onSelect(agent.id)
                  setOpen(false)
                }}
              >
                <span className="agicon"><Icon name="cube" /></span>
                <span className="agent-option-copy">
                  <b>{piProfileName(agent)}</b>
                  <small>{agent.id === 'pi:default' ? '系统检测' : '自定义 Profile'} · {agent.version ?? '版本未知'}</small>
                </span>
                {agent.id === selectedId && <span className="ck"><Icon name="check" /> 当前</span>}
              </button>
              {agent.id !== 'pi:default' && (
                <button
                  type="button"
                  className="agent-option-remove"
                  title="从 Scry 移除；不会删除启动器文件"
                  aria-label={`移除 Pi Profile：${piProfileName(agent)}`}
                  onClick={() => onRemovePi(agent.id)}
                >
                  <Icon name="x" />
                </button>
              )}
            </div>
          ))}
          <div className="mdiv" />
          <button type="button" className="mitem" onClick={() => { onAddPi(); setOpen(false) }}>
            <Icon name="plus" /> 添加 Pi Agent…
          </button>
          <button type="button" className="mitem" onClick={() => onRescan()}>
            <Icon name="refresh" /> 重新扫描 PATH
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
  disabled?: boolean
}

export function ModelEffortPicker({
  modelValue,
  modelOptions,
  effortValue,
  effortOptions,
  onModelChange,
  onEffortChange,
  loading = false
}: {
  modelValue: string
  modelOptions: RunControlSelectOption[]
  effortValue: string
  effortOptions: RunControlSelectOption[]
  onModelChange: (value: string) => void
  onEffortChange: (value: string) => void
  loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)
  const modelListRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  const selectedModel = modelOptions.find((option) => option.value === modelValue) ?? modelOptions[0]
  const selectedEffort = effortOptions.find((option) => option.value === effortValue) ?? effortOptions[0]

  useEffect(() => {
    if (!loading) return
    setOpen(false)
    setModelsOpen(false)
  }, [loading])

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => {
      if (modelsOpen) {
        const options = Array.from(modelListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const selectedOption = options.find((option) => option.getAttribute('aria-selected') === 'true') ?? options[0]
        selectedOption?.focus()
      } else currentRef.current?.focus()
    }, 0)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || pickerRef.current?.contains(event.target)) return
      setOpen(false)
      setModelsOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setModelsOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [modelsOpen, open])

  return (
    <div className="model-effort-picker" ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-effort-trigger"
        disabled={loading}
        aria-label="选择 Model 与 Effort"
        aria-description={`当前 ${selectedModel?.label ?? '自动模型'}，${selectedEffort?.label ?? '默认'}`}
        aria-busy={loading}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        title={[selectedModel?.description, selectedEffort?.description].filter(Boolean).join(' · ')}
        onClick={() => setOpen((current) => {
          if (current) setModelsOpen(false)
          return !current
        })}
      >
        <span className="model-effort-model">{selectedModel?.label ?? '自动模型'}</span>
        <span className="model-effort-effort">{selectedEffort?.label ?? '默认'}</span>
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div id={popoverId} className="model-effort-popover" role="dialog" aria-label="Model 与 Effort">
          {!modelsOpen ? (
            <>
              <button
                ref={currentRef}
                type="button"
                className="model-effort-current"
                aria-label={`选择 Model，当前 ${selectedModel?.label ?? '自动模型'}`}
                aria-expanded={false}
                onClick={() => setModelsOpen(true)}
              >
                <span>{selectedModel?.label ?? '自动模型'}</span>
                <span className="model-effort-current-effort">{selectedEffort?.label ?? '默认'}</span>
                <Icon name="chevronRight" className="chev" />
              </button>
              <div className="model-effort-scale" role="group" aria-label="推理强度">
                {effortOptions.map((option) => (
                  <button
                    type="button"
                    className={option.value === effortValue ? 'selected' : ''}
                    aria-pressed={option.value === effortValue}
                    disabled={option.disabled}
                    title={option.description}
                    key={option.value}
                    onClick={() => {
                      onEffortChange(option.value)
                      setOpen(false)
                      setModelsOpen(false)
                      window.setTimeout(() => triggerRef.current?.focus(), 0)
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div
              ref={modelListRef}
              className="model-effort-list"
              role="listbox"
              aria-label="选择 Model"
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                const options = Array.from(modelListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
                if (options.length === 0) return
                event.preventDefault()
                const current = options.indexOf(document.activeElement as HTMLButtonElement)
                const next = event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : event.key === 'ArrowUp'
                      ? (current <= 0 ? options.length - 1 : current - 1)
                      : (current + 1) % options.length
                options[next]?.focus()
              }}
            >
              {modelOptions.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === modelValue}
                  disabled={option.disabled}
                  title={option.description}
                  key={option.value}
                  onClick={() => {
                    if (option.value !== modelValue) onModelChange(option.value)
                    setModelsOpen(false)
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === modelValue && <Icon name="check" />}
                </button>
              ))}
            </div>
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
  tone
}: {
  ariaLabel: string
  prefix?: string
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
      {prefix && <span className="rc-prefix" aria-hidden="true">{prefix}</span>}
      {/* 可见值：让整块宽度贴合当前选中项。原生 select 的宽度由最长选项决定，
          直接显示它会在短值和箭头之间留一大段空白。 */}
      <span className="rc-value" aria-hidden="true">{selected?.label ?? ''}</span>
      <select
        aria-label={ariaLabel}
        aria-busy={loading}
        value={value}
        disabled={disabled || loading}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option value={option.value} key={option.value} title={option.description} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" className="chev" />
    </label>
  )
}
