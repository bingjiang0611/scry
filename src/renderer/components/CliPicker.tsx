// Composer Agent 选择器：本机检测到的 Provider，以及 Pi Profile 的增删。
import { useEffect, useId, useRef } from 'react'
import { useMenuDismiss, usePickerOpen, type PickerOpenProps } from './picker-state'
import { providerIdForAgentId } from '@shared/runtime'
import { AGENT_PICKER_COPY, PI_PICKER_COPY } from '../constants/copy'
import { basename } from '../format'
import type { DetectedAgent } from '../env'
import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import { MenuCheck } from './menu-parts'
import { moveMenuFocus } from './WorkdirPicker'

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
  const pickerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
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
  // 关闭菜单时把焦点从即将卸载的选项退回触发器，避免焦点落到 body。
  const dismissMenu = (): void => {
    if (pickerRef.current?.contains(document.activeElement)) buttonRef.current?.focus()
    setOpen(false)
  }
  useMenuDismiss({ open: open && !disabled, close: dismissMenu, rootRef: pickerRef, triggerRef: buttonRef, menuRef })
  return (
    <div className="clipick" ref={pickerRef}>
      <button
        ref={buttonRef}
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
        <div
          id={menuId}
          ref={menuRef}
          className="menu climenu"
          role="menu"
          aria-label={AGENT_PICKER_COPY.menuLabel}
          onMouseLeave={dismissMenu}
          onKeyDown={(event) => moveMenuFocus(event, menuRef.current)}
        >
          <div className="cltitle" role="none">
            {scopeLabel}
            <div className="dim">{sel?.name ?? '未检测到'}</div>
          </div>
          <div className="mhdr" role="none">Provider</div>
          {agents.length === 0 && <div className="dim pad" role="none">{AGENT_PICKER_COPY.empty}</div>}
          {codeAgents.map((a) => (
            <button
              type="button"
              role="menuitemradio"
              key={a.id}
              className="mitem"
              data-agent-id={a.id}
              aria-checked={a.id === selectedId}
              title={`${a.path}${a.version ? ' · ' + a.version : ''}`}
              disabled={unavailableIds?.has(a.id)}
              onClick={() => {
                onSelect(a.id)
                dismissMenu()
              }}
            >
              <MenuCheck selected={a.id === selectedId} />
              <span className="agicon">
                <ProviderGlyph provider={agentGlyphProvider(a.id) ?? 'claude'} />
              </span>
              <span className="agent-option-name">{a.name}{unavailableIds?.has(a.id) && a.id !== selectedId ? ' · 不可用' : ''}</span>
            </button>
          ))}
          {piAgents.length > 0 && <div className="mhdr" role="none">Pi · Profiles</div>}
          {piAgents.map((agent) => (
            <div className="agent-option-row" key={agent.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                className="mitem agent-option-pick"
                data-agent-id={agent.id}
                aria-checked={agent.id === selectedId}
                title={agent.path}
                disabled={unavailableIds?.has(agent.id)}
                onClick={() => {
                  onSelect(agent.id)
                  dismissMenu()
                }}
              >
                <MenuCheck selected={agent.id === selectedId} />
                <span className="agicon"><ProviderGlyph provider="pi" /></span>
                <span className="agent-option-copy">
                  <b>{piProfileName(agent)}</b>
                  <small>{PI_PICKER_COPY.detail(isDetectedPiProfile(agent.id), agent.version)}</small>
                </span>
              </button>
              {!isDetectedPiProfile(agent.id) && onRemovePi && (
                <button
                  type="button"
                  role="menuitem"
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
          {(onAddPi || onRescan) && <div className="mdiv" role="separator" />}
          {onAddPi && (
            <button type="button" role="menuitem" className="mitem" onClick={() => { onAddPi(); dismissMenu() }}>
              <Icon name="plus" /> 添加 Pi Agent…
            </button>
          )}
          {onRescan && (
            <button type="button" role="menuitem" className="mitem" onClick={() => onRescan()}>
              <Icon name="refresh" /> 重新扫描 PATH
            </button>
          )}
        </div>
      )}
    </div>
  )
}
