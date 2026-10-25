import { useId, useRef, useState } from 'react'
import type { McpStatus } from '../format'
import type { SkillMeta, McpMeta } from '../env'
import type { McpLiveStatus } from '@shared/trace'
import type { CapabilityEnvelope, McpSnapshot } from '@shared/provider'
import { Icon } from './primitives/Icon'
import { ModalCloseButton } from './primitives/ModalCloseButton'
import { MODAL_COPY, LOADING_COPY } from '../constants/copy'
import { useDelayedFlag } from '../hooks/useDelayedFlag'
import { useFirstReadyList } from '../hooks/useFirstReadyList'
import { DelayedLoadingStatus } from './LoadingStatus'


import './archived-sessions.css'





import { ModalFrame, requestModalClose } from './ModalFrame'
import { EvidenceState, type EvidenceValue, useReadStarted, evidenceForRuntime } from './CapabilityEvidence'
type CapabilityView = 'skills' | 'mcp'
type CapabilitySource = 'all' | 'project' | 'user'

function CapabilitySourceTabs({
  source,
  onChange,
  label
}: {
  source: CapabilitySource
  onChange: (source: CapabilitySource) => void
  label: string
}) {
  return (
    <div className="capability-source-tabs" role="tablist" aria-label={label}>
      {(['all', 'project', 'user'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={source === value}
          className={source === value ? 'active' : ''}
          onClick={() => onChange(value)}
        >
          {value === 'all' ? '全部' : value === 'project' ? '项目' : '用户'}
        </button>
      ))}
    </div>
  )
}

export function CapabilitiesModal({
  view,
  onViewChange,
  skills,
  skillCapability,
  skillsRefreshing = false,
  onRefreshSkills,
  mcps,
  status,
  live,
  mcpConfigRefreshing = false,
  mcpRefreshing,
  mcpCapability,
  onTestMcp,
  onReauthenticateMcp,
  onRefreshMcp,
  onClose
}: {
  view: CapabilityView
  onViewChange: (view: CapabilityView) => void
  skills: SkillMeta[]
  skillCapability?: CapabilityEnvelope<SkillMeta[]> | null
  skillsRefreshing?: boolean
  onRefreshSkills: () => void
  mcps: McpMeta[]
  status: Record<string, McpStatus>
  live: McpLiveStatus[]
  mcpConfigRefreshing?: boolean
  mcpRefreshing: boolean
  mcpCapability?: CapabilityEnvelope<McpSnapshot> | null
  onTestMcp: (targetId: string) => void
  onReauthenticateMcp?: (targetId: string) => void
  onRefreshMcp: () => void
  onClose: () => void
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const [source, setSource] = useState<CapabilitySource>('all')
  const [expandedMcp, setExpandedMcp] = useState<string | null>(null)
  const activeCapability = view === 'skills' ? skillCapability : mcpCapability
  const loadingMcpConfig = mcpConfigRefreshing && !mcpCapability
  const loadingMcp = loadingMcpConfig || mcpRefreshing
  const skillsReadStarted = useReadStarted(skillsRefreshing)
  const mcpReadStarted = useReadStarted(mcpConfigRefreshing)
  const skillsUnavailable = skillCapability === null && !skillsRefreshing && skillsReadStarted
  const mcpUnavailable = mcpCapability === null && !loadingMcp && mcpReadStarted
  const showMcpLoading = useDelayedFlag(loadingMcp)
  const authenticationInProgress = Object.values(status).some((item) => item.authenticating)
  const liveByName = new Map(live.map((item) => [item.name, item]))
  const visibleSkills = source === 'all' ? skills : skills.filter((skill) => skill.scope === source)
  const visibleMcps = source === 'all'
    ? mcps
    : mcps.filter((mcp) => (mcp.scope === 'user' ? 'user' : 'project') === source)
  const capabilityMotion = useFirstReadyList((view === 'skills' ? visibleSkills : visibleMcps).length > 0)

  const chooseView = (nextView: CapabilityView): void => {
    setSource('all')
    setExpandedMcp(null)
    onViewChange(nextView)
  }

  return (
    <ModalFrame
      labelledBy={titleId}
      initialFocusRef={closeRef}
      className={`capabilities-modal capabilities-modal--${view}`}
      onClose={onClose}
    >
      <div className="capabilities-head">
        <h2 id={titleId} className="inventory-sr-only">Capabilities</h2>
        <div className="capability-kind-tabs" role="tablist" aria-label="能力类型">
          <button type="button" role="tab" aria-selected={view === 'skills'} className={view === 'skills' ? 'active' : ''} onClick={() => chooseView('skills')}>Skills</button>
          <button type="button" role="tab" aria-selected={view === 'mcp'} className={view === 'mcp' ? 'active' : ''} onClick={() => chooseView('mcp')}>MCP</button>
        </div>
        <span className="capabilities-head__spacer" />
        {view === 'mcp' && (
          <button
            className="capabilities-refresh"
            type="button"
            onClick={onRefreshMcp}
            disabled={loadingMcp || authenticationInProgress}
            aria-label="刷新 MCP 运行状态"
          >
            {showMcpLoading && mcpRefreshing ? <span className="spinner" /> : <Icon name="refresh" />}
            <span>{showMcpLoading && mcpRefreshing ? LOADING_COPY.detecting : LOADING_COPY.refresh}</span>
          </button>
        )}
        <ModalCloseButton ref={closeRef} className="capabilities-close" onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeCapabilities} />
      </div>

      <div className="capabilities-source-bar">
        <CapabilitySourceTabs
          source={source}
          onChange={(nextSource) => {
            setSource(nextSource)
            setExpandedMcp(null)
          }}
          label={view === 'skills' ? 'Skill 来源' : 'MCP 来源'}
        />
      </div>

      {activeCapability && activeCapability.state !== 'ready' && (
        <div className="inventory-capability-note" role={activeCapability.state === 'unknown' ? 'alert' : 'status'}>
          {activeCapability.reason ?? activeCapability.state}
        </div>
      )}

      {view === 'skills' ? (
        <div className={`capabilities-body capabilities-skills ${capabilityMotion.className}`} role="tabpanel" aria-busy={skillsRefreshing}>
          {visibleSkills.length > 0 ? visibleSkills.map((skill, index) => (
            <article className="capability-skill motion-stagger-item" style={capabilityMotion.itemStyle(index)} key={skill.scope + ':' + skill.name}>
              <strong>{skill.name}</strong>
              <p title={skill.description}>{skill.description}</p>
            </article>
          )) : skillsUnavailable ? (
            <div className="capabilities-empty" role="status">
              <strong>{LOADING_COPY.skillsUnavailable}</strong>
              <button type="button" className="capabilities-refresh" onClick={onRefreshSkills}>{LOADING_COPY.refresh}</button>
            </div>
          ) : (skillsRefreshing || skillCapability === null) && skills.length === 0 ? <DelayedLoadingStatus loading={skillsRefreshing} title={LOADING_COPY.skills} /> : (
            <div className="capabilities-empty" role="status">
              <strong>{LOADING_COPY.skillsSourceEmpty}</strong>
            </div>
          )}
        </div>
      ) : (
        <div className={`capabilities-body capability-mcp-list ${capabilityMotion.className}`} role="tabpanel" aria-busy={loadingMcp}>
          {visibleMcps.length > 0 ? visibleMcps.map((mcp, index) => {
            const targetId = mcp.targetId ?? mcp.name
            const runtime = liveByName.get(mcp.name)
            const currentStatus = status[targetId]
            const runtimeValue: EvidenceValue = !mcp.enabled
              ? { state: 'disabled', label: '已关闭', detail: '配置文件中的当前值' }
              : evidenceForRuntime(runtime, mcpCapability)
            const toolNames = runtime?.toolNames ?? currentStatus?.toolNames
            const canLoadTools = mcp.enabled && runtime?.status === 'connected' && mcpCapability?.mode === 'manage'
            const expandable = Boolean(mcp.enabled && runtime?.status === 'connected' && (toolNames?.length || canLoadTools))
            const open = expandedMcp === targetId
            const canAuthenticate = Boolean(onReauthenticateMcp && mcpCapability?.data?.operations?.authenticate.includes(targetId))
            const needsAuth = runtime?.status === 'needs-auth'
            const authLabel = currentStatus?.authenticating
              ? '认证中…'
              : currentStatus?.authOk === false
                ? '认证失败，重试'
                : currentStatus?.authOk && currentStatus.authError
                  ? '认证待确认'
                  : '需要认证'

            const toggleTools = (): void => {
              const nextOpen = !open
              setExpandedMcp(nextOpen ? targetId : null)
              if (nextOpen && !toolNames?.length && canLoadTools && !currentStatus?.testing) onTestMcp(targetId)
            }

            return (
              <article className={`capability-mcp-row capability-mcp-row--${runtimeValue.state} motion-stagger-item`} style={capabilityMotion.itemStyle(index)} key={mcp.scope + ':' + targetId}>
                <div className="capability-mcp-row__summary">
                  <div className="capability-mcp-server">
                    <div className="capability-mcp-server__name">
                      {expandable ? (
                        <button type="button" className="capability-mcp-toggle" aria-expanded={open} onClick={toggleTools}>
                          <span aria-hidden="true">{open ? '⌄' : '›'}</span>
                          <strong>{mcp.name}</strong>
                        </button>
                      ) : (
                        <strong className="capability-mcp-static">{mcp.name}</strong>
                      )}
                      <span>{mcp.transport}</span>
                    </div>
                    <code title={mcp.detail}>{mcp.detail}</code>
                  </div>
                  <div className="capability-mcp-runtime">
                    {needsAuth && canAuthenticate ? (
                      <button
                        type="button"
                        className={`capability-auth capability-auth--${currentStatus?.authOk === false ? 'failed' : 'required'}`}
                        onClick={() => onReauthenticateMcp?.(targetId)}
                        disabled={authenticationInProgress}
                        title={currentStatus?.authError ?? runtimeValue.detail}
                      >
                        {currentStatus?.authenticating && <span className="spinner" />}
                        {!currentStatus?.authenticating && <i aria-hidden="true" />}
                        {authLabel}
                      </button>
                    ) : (
                      <EvidenceState value={runtimeValue} />
                    )}
                  </div>
                </div>
                {expandable && (
                  <div className={`capability-tools ${open ? 'open' : ''}`}>
                    <div className="capability-tools__inner">
                      {currentStatus?.testing ? (
                        <DelayedLoadingStatus loading title={LOADING_COPY.tools} className="capability-tools__message" />
                      ) : toolNames?.length ? (
                        <div className="capability-tools__list">{toolNames.map((tool) => <code key={tool}>{tool}</code>)}</div>
                      ) : currentStatus?.ok === false ? (
                        <span className="capability-tools__message capability-tools__message--error">工具明细读取失败 · {currentStatus.error}</span>
                      ) : (
                        <span className="capability-tools__message">Provider 未返回工具名称明细</span>
                      )}
                    </div>
                  </div>
                )}
              </article>
            )
          }) : mcpUnavailable ? <div className="capabilities-empty" role="status"><strong>{LOADING_COPY.mcpUnavailable}</strong></div>
            : loadingMcpConfig || mcpCapability === null ? <DelayedLoadingStatus loading={loadingMcp} title={LOADING_COPY.mcp} /> : (
            <div className="capabilities-empty" role="status">
              <strong>{LOADING_COPY.mcpSourceEmpty}</strong>
            </div>
          )}
        </div>
      )}
    </ModalFrame>
  )
}
