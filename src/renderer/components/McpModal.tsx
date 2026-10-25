import { useId, useRef, useState } from 'react'
import type { McpStatus } from '../format'
import type { McpMeta } from '../env'
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
import { EvidenceState, type EvidenceValue, scopeClass, scopeShortLabel, InventoryContext, useReadStarted, MCP_SCOPE_LABEL, evidenceForRuntime, shortTestLabel, McpEvidenceCell } from './CapabilityEvidence'
export function McpModal({
  mcps,
  status,
  live,
  configRefreshing = false,
  refreshing,
  capability,
  onTest,
  onReauthenticate,
  onRefresh,
  onClose
}: {
  mcps: McpMeta[]
  status: Record<string, McpStatus>
  live: McpLiveStatus[]
  configRefreshing?: boolean
  refreshing: boolean
  capability?: CapabilityEnvelope<McpSnapshot> | null
  onTest: (targetId: string) => void
  onReauthenticate?: (targetId: string) => void
  onRefresh: () => void
  onClose: () => void
}) {
  const canManage = capability?.mode === 'manage'
  const readsRuntime = capability?.mode === 'read'
  const readsPiSnapshot = readsRuntime && capability?.providerId === 'pi'
  const refreshLabel = readsPiSnapshot ? '刷新快照' : '检测全部'
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const loadingConfig = configRefreshing && !capability
  const loading = loadingConfig || refreshing
  const readStarted = useReadStarted(configRefreshing)
  const mcpUnavailable = capability === null && !loading && readStarted
  const showMcpLoading = useDelayedFlag(loading)
  const authenticationInProgress = Object.values(status).some((item) => item.authenticating)
  const [expanded, setExpanded] = useState<string | null>(null)
  const mcpMotion = useFirstReadyList(mcps.length > 0)
  const liveByName = new Map(live.map((item) => [item.name, item]))
  const connectedCount = live.filter((item) => item.status === 'connected').length
  const testEvidenceCount = Object.values(status).filter((item) => item.ok != null || item.testing).length

  return (
    <ModalFrame labelledBy={titleId} initialFocusRef={closeRef} className="inventory-modal inventory-modal--mcp" onClose={onClose}>
      <div className="modal-head inventory-modal__head">
        <div className="inventory-modal__title">
          <span className="inventory-modal__eyebrow">Capability fleet</span>
          <div className="inventory-modal__title-line">
            <b id={titleId}>MCP</b>
            {capability?.providerId && <span className="inventory-provider">{capability.providerId}</span>}
          </div>
        </div>
        <div className="inventory-modal__head-actions">
          {showMcpLoading && <EvidenceState value={{ state: 'pending', label: loadingConfig ? LOADING_COPY.readingConfig : readsPiSnapshot ? LOADING_COPY.piSnapshot : LOADING_COPY.detectingMcp, role: 'status' }} quiet />}
          <button
            className={'modal-refresh' + (readsRuntime ? ' mcp-refresh-all' : '')}
            onClick={onRefresh}
            disabled={loading || authenticationInProgress}
            title={readsPiSnapshot
              ? '重新读取 Pi 脱敏后的有效配置与原生 lazy/runtime 状态；不会主动连接 lazy server'
              : readsRuntime
                ? '启动已授权 MCP，并刷新当前 Provider 的全部原生运行状态'
                : '重新读取当前 Provider 的原生 MCP 配置与运行状态'}
            aria-label={readsPiSnapshot ? '刷新 Pi MCP 快照' : readsRuntime ? '检测全部 MCP 运行状态' : '刷新 MCP 状态'}
          >
            {showMcpLoading && refreshing && readsRuntime ? <span className="spinner" /> : <Icon name="refresh" />}
            {readsRuntime && <span>{showMcpLoading && refreshing ? (readsPiSnapshot ? LOADING_COPY.refreshing : LOADING_COPY.detecting) : refreshLabel}</span>}
          </button>
          <ModalCloseButton ref={closeRef} onClick={() => requestModalClose()} aria-label={MODAL_COPY.closeMcp} />
        </div>
      </div>

      <InventoryContext
        capability={capability}
        kind="MCP"
        summary={loadingConfig || capability === null ? '' : LOADING_COPY.mcpSummary(mcps.length, connectedCount, live.length, testEvidenceCount)}
      />

      {capability && capability.state !== 'ready' && (
        <div className="inventory-capability-note" role={capability.state === 'unknown' ? 'alert' : 'status'}>
          {capability.reason ?? capability.state}
        </div>
      )}

      <div className="inventory-state-legend" aria-label="状态语义说明">
        <span>状态语义</span>
        <EvidenceState value={{ state: 'unknown', label: '未知：还没有证据' }} quiet />
        <EvidenceState value={{ state: 'unsupported', label: '不支持：能力不存在' }} quiet />
      </div>

      <div className="modal-body inventory-modal__body inventory-modal__body--mcp" aria-busy={loading}>
        {mcps.length === 0 && mcpUnavailable ? <div className="inventory-empty" role="status">{LOADING_COPY.mcpUnavailable}</div>
          : mcps.length === 0 && (loadingConfig || capability === null) ? <DelayedLoadingStatus loading={loading} title={LOADING_COPY.mcp} /> : mcps.length === 0 ? (
          <div className="inventory-empty" role="status">
            <strong>{LOADING_COPY.mcpEmpty}</strong>
            <p>{LOADING_COPY.mcpNoConfigEvidence}</p>
          </div>
        ) : (
          <div className="mcp-fleet-wrap">
            <table className={`mcp-fleet ${mcpMotion.className}`}>
              <caption className="inventory-sr-only">MCP Fleet：Provider 运行态与认证独立展示</caption>
              <thead>
                <tr>
                  <th scope="col">Server / 来源</th>
                  <th scope="col">Provider 运行态</th>
                  <th scope="col">认证</th>
                  <th scope="col"><span className="inventory-sr-only">操作</span></th>
                </tr>
              </thead>
              {mcps.map((mcp, index) => {
                const targetId = mcp.targetId ?? mcp.name
                const currentStatus = status[targetId]
                const runtime = liveByName.get(mcp.name)
                const runtimeValue = evidenceForRuntime(runtime, capability)
                const open = expanded === targetId
                const toolsId = titleId + '-tools-' + index
                const authLimited = currentStatus?.ok === false && /40[13]/.test(currentStatus.error ?? '')
                const canAuthenticate = Boolean(onReauthenticate && capability?.data?.operations?.authenticate.includes(targetId))
                const needsAuth = runtime?.status === 'needs-auth'
                const needsClientRegistration = runtime?.status === 'needs-client-registration'
                const hasTestEvidence = Boolean(currentStatus?.testing || currentStatus?.ok != null)

                let testValue: EvidenceValue
                if (currentStatus?.testing) {
                  testValue = { state: 'pending', label: '测试中', detail: '正在执行 initialize / tools/list…', role: 'status' }
                } else if (currentStatus?.ok === true) {
                  testValue = {
                    state: 'passed',
                    label: '通过',
                    detail: '本次测试成功' + (currentStatus.tools != null ? ' · ' + currentStatus.tools + ' tools' : ''),
                    role: 'status'
                  }
                } else if (currentStatus?.ok === false) {
                  testValue = authLimited
                    ? { state: 'needs-auth', label: '需认证（测试无 token）', detail: '测试握手没带 OAuth token；真实连接以当前 Provider 原生运行时为准', role: 'alert' }
                    : { state: 'failed', label: '失败', detail: '本次测试失败' + (currentStatus.error ? ' · ' + currentStatus.error : ''), role: 'alert' }
                } else if (canManage) {
                  testValue = { state: 'unknown', label: '未测试', detail: '尚未执行单项 initialize / tools/list' }
                } else if (readsRuntime || capability?.state === 'unsupported' || capability?.mode === 'none') {
                  testValue = { state: 'unsupported', label: '不支持单项直测', detail: '使用 Provider 原生运行态；Scry 不伪造测试结果' }
                } else {
                  testValue = { state: 'unknown', label: '未知', detail: '测试能力尚未确认' }
                }

                let authValue: EvidenceValue
                if (currentStatus?.authenticating) {
                  authValue = { state: 'pending', label: '认证中', detail: '等待浏览器完成授权…', role: 'status' }
                } else if (currentStatus?.authOk === true) {
                  authValue = currentStatus.authError
                    ? { state: 'pending', label: '已授权 · 待确认', detail: '授权流程已完成；运行状态未确认 · ' + currentStatus.authError, role: 'status' }
                    : { state: 'passed', label: '认证成功', detail: '认证成功，运行状态已刷新', role: 'status' }
                } else if (currentStatus?.authOk === false || currentStatus?.authError) {
                  authValue = { state: 'failed', label: '认证失败', detail: '认证失败' + (currentStatus.authError ? ' · ' + currentStatus.authError : ''), role: 'alert' }
                } else if (needsClientRegistration) {
                  authValue = { state: 'required', label: '需配置 OAuth Client', detail: '需在 Provider 中配置 OAuth Client ID' }
                } else if (needsAuth) {
                  authValue = { state: 'required', label: '需要认证', detail: canAuthenticate ? '可由 Scry 启动 Provider 原生 OAuth' : '请在 Provider 客户端完成认证' }
                } else if (capability?.data?.operations) {
                  authValue = capability.data.operations.authenticate.includes(targetId)
                    ? { state: 'unknown', label: '未执行', detail: '当前没有认证流程结果' }
                    : { state: 'unsupported', label: 'Scry 不支持', detail: 'Provider 未声明此目标可由 Scry 发起认证' }
                } else {
                  authValue = { state: 'unknown', label: '未知', detail: 'Provider 未返回认证能力证据' }
                }

                return (
                  <tbody key={mcp.scope + ':' + targetId}>
                    <tr className={'mcp-fleet__row mcp-fleet__row--' + runtimeValue.state + ' motion-stagger-item'} style={mcpMotion.itemStyle(index)}>
                      <th scope="row">
                        <div className="mcp-server-cell">
                          <div className="mcp-server-cell__name">
                            <strong>{mcp.name}</strong>
                            <span>{mcp.transport}</span>
                            <span className={'inventory-scope inventory-scope--' + scopeClass(mcp.scope)} title={MCP_SCOPE_LABEL[mcp.scope] ?? mcp.scope}>
                              {scopeShortLabel(mcp.scope)}
                            </span>
                            {!mcp.enabled && (
                              <span className="inventory-scope inventory-scope--off" title="配置文件中已关闭">已关闭</span>
                            )}
                          </div>
                          <code title={mcp.detail}>{mcp.detail}</code>
                          {currentStatus?.ok && currentStatus.toolNames && currentStatus.toolNames.length > 0 && (
                            <button
                              className="mcp-tools-toggle"
                              type="button"
                              aria-expanded={open}
                              aria-controls={toolsId}
                              onClick={() => setExpanded(open ? null : targetId)}
                            >
                              <span aria-hidden="true">{open ? '−' : '+'}</span>
                              {currentStatus.toolNames.length} tools
                            </button>
                          )}
                        </div>
                      </th>
                      <td><McpEvidenceCell label="运行态" value={runtimeValue} /></td>
                      <td><McpEvidenceCell label="认证" value={authValue} /></td>
                      <td className="mcp-fleet__actions">
                        {canManage && (
                          <button className="mcp-test" onClick={() => onTest(targetId)} disabled={currentStatus?.testing || authenticationInProgress}>
                            {currentStatus?.testing ? <><span className="spinner" /> 测试中…</> : '测试连接'}
                          </button>
                        )}
                        {needsAuth && canAuthenticate && (
                          <button
                            className="mcp-test"
                            onClick={() => onReauthenticate?.(targetId)}
                            disabled={authenticationInProgress}
                            aria-label={'重新认证 MCP ' + mcp.name}
                          >
                            {currentStatus?.authenticating ? <><span className="spinner" /> 认证中…</> : '重新认证'}
                          </button>
                        )}
                        {hasTestEvidence && (
                          <div className={'mcp-test-inline mcp-test-inline--' + testValue.state} title={testValue.detail} role={testValue.role}>
                            <i aria-hidden="true" />
                            <span>{shortTestLabel(testValue)}</span>
                          </div>
                        )}
                        {needsClientRegistration ? (
                          <small>需在 Provider 中配置 OAuth Client ID</small>
                        ) : needsAuth && !canAuthenticate ? (
                          <small>请在 Provider 客户端完成认证</small>
                        ) : null}
                      </td>
                    </tr>
                    {open && currentStatus?.toolNames && (
                      <tr className="mcp-tools-row">
                        <td colSpan={4}>
                          <div id={toolsId} className="mcp-tools-drawer">
                            <div><strong>本次测试返回的工具</strong><small>来自 initialize / tools/list</small></div>
                            <div className="mcp-tools-drawer__list">
                              {currentStatus.toolNames.map((tool) => <code key={tool}>{tool}</code>)}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                )
              })}
            </table>
          </div>
        )}
      </div>

      <div className="modal-foot inventory-footnote">
        <span>证据边界</span>
        <p>
          {capability?.data?.operations?.authenticate.length
            ? '支持认证的远程 MCP 可直接在 Scry 完成 Provider 原生 OAuth；凭据由 Provider 保存在本机（OpenCode 使用 Scry 私有目录），不会上传。'
            : canManage
              ? '当前 Provider 支持由 Scry 直测单个 MCP 连接。'
              : capability?.mode === 'read'
                ? '当前 Provider 只暴露原生 MCP 配置/运行状态，不提供单项直测；使用顶部「检测全部」读取原生运行状态。'
                : '当前 Provider 没有可用的 MCP 配置/运行状态接口。'}
        </p>
      </div>
    </ModalFrame>
  )
}
