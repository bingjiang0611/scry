// 顶部/底部选择器：工作目录选择（含 recent）/ 本地 CLI 选择（local·api 后端 + rescan）。
import { useState } from 'react'
import { AGENT_ICON, basename } from '../format'
import { Icon, type IconName } from './primitives/Icon'
import type { DetectedAgent } from '../env'

export function WorkdirPicker({
  cwd,
  recent,
  onChoose,
  onPick,
  onRemove
}: {
  cwd: string | null
  recent: string[]
  onChoose: () => void
  onPick: (d: string) => void
  onRemove: (d: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="wdpick">
      <button className="wdbtn" onClick={() => setOpen((o) => !o)}>
        <Icon name="folder" /> {cwd ? basename(cwd) : 'Select working directory'}{' '}
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div className="menu wdmenu" onMouseLeave={() => setOpen(false)}>
          <div
            className="mitem"
            onClick={() => {
              setOpen(false)
              onChoose()
            }}
          >
            <Icon name="folder" /> Choose folder
          </div>
          {recent.length > 0 && <div className="mhdr">Recent folders</div>}
          <div className="wdrecent-list">
            {recent.map((d) => (
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
                  <span>{basename(d)}</span>
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
  backend,
  onSelect,
  onBackend,
  onRescan,
  disabled = false
}: {
  agents: DetectedAgent[]
  selectedId: string
  backend: 'local' | 'api'
  onSelect: (id: string) => void
  onBackend: (b: 'local' | 'api') => void
  onRescan: () => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const sel = agents.find((a) => a.id === selectedId)
  return (
    <div className="clipick">
      <button className="clibtn" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        <span className="agicon">
          <Icon name={(AGENT_ICON[selectedId] ?? 'cube') as IconName} />
        </span>
        <span>{sel?.name ?? 'Agent'}</span>
        <Icon name="chevronDown" className="chev" />
      </button>
      {open && (
        <div className="menu climenu" onMouseLeave={() => setOpen(false)}>
          <div className="cltitle">
            Local CLI
            <div className="dim">{sel?.name ?? '未检测到'}</div>
          </div>
          <div className={`mitem ${backend === 'local' ? 'on' : ''}`} onClick={() => onBackend('local')}>
            <Icon name="tool" /> Use Local CLI {backend === 'local' && <span className="ck"><Icon name="check" /> active</span>}
          </div>
          <div className={`mitem ${backend === 'api' ? 'on' : ''}`} onClick={() => onBackend('api')}>
            <Icon name="lock" /> Use API · BYOK {backend === 'api' && <span className="ck"><Icon name="check" /> active</span>}
          </div>
          <div className="mhdr">CODE AGENT</div>
          {agents.length === 0 && <div className="dim pad">未检测到 agent CLI</div>}
          {agents.map((a) => (
            <div
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
              {a.name}
              {a.id === selectedId && <span className="ck"><Icon name="check" /> selected</span>}
            </div>
          ))}
          <div className="mdiv" />
          <div className="mitem" onClick={() => onRescan()}>
            <Icon name="refresh" /> Rescan PATH
          </div>
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
