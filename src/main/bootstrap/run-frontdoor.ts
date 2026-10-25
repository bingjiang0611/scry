import type { AgentPermissionMode, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ManagedConversationStart } from '../conversation-service'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { ProviderRegistry } from '../providers/registry'
import { AgentRuntimeError } from '../run-outcome'
import { normalizeAgentStartRequest } from '../../shared/runtime'
import { PerformanceTrace } from '../performance-timing'
import { warmShellEnv } from '../claude-locate'
import { canonicalExistingDirectory } from '../workspace-authorization'
import { providerOperationKey } from '../provider-operation-gate'

export interface AppRunStartOptions {
  /** Host-only reservation; never accepted from renderer payloads. */
  workspaceAdmission?: { cwd: string; admit: (register: () => void) => Promise<void> }
  origin?: 'local' | 'remote'
  runId?: string
  stopSignal?: AbortSignal
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  permissionModeOverride?: AgentPermissionMode
  providerPrompt?: string
  onTraceEvent?: (event: import('../../shared/trace').TraceEvent) => void
  onSession?: (externalSessionId: string) => void
  ledgerRunId?: string
  managedConversation?: ManagedConversationStart
}

type FrontdoorDeps = {
  providerRegistry: ProviderRegistry
  isShuttingDown: boolean
  currentCwd: string | undefined
  appSessionStore: () => { isArchived: (ref: { providerId: ProviderId; agentProfileId?: string; cwd: string; externalSessionId: string }) => boolean }
  resolveRemoteProjectDirectory: (cwd: string) => string
  resolveKnownProjectDirectory: (cwd: string) => string
  providerOperationGate: ProviderOperationGate
  providerContextKey: (providerId: ProviderId, cwd: string, profile?: string) => string
}

export function prepareRunFrontdoor(payload: AgentStartRequest, options: AppRunStartOptions, deps: FrontdoorDeps) {
  const isRemoteRun = options.origin === 'remote'
  const request = normalizeAgentStartRequest(payload)
  if (request.workspace) throw new Error('工作区选择必须先完成首次发送准备，不能绕过准备入口启动')
  const providerId = request.providerId
  const agentProfileId = request.agentProfileId
  const startPerf = new PerformanceTrace('agent.start', { provider: providerId })
  const firstTracePerf = new PerformanceTrace('agent.first_provider_trace', { provider: providerId })
  const firstTextPerf = new PerformanceTrace('agent.first_text', { provider: providerId })
  const adapter = deps.providerRegistry.get(providerId)
  const runtimeProvider = adapter.runtimeProvider
  if (deps.isShuttingDown) {
    throw new AgentRuntimeError('Scry 正在退出，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      nextAction: '重新打开 Scry 后再启动'
    })
  }
  // Start one bounded acquisition for this explicit send. Discovery does not retry a
  // broken shell; the next send may recover without restarting Scry.
  const shellEnvReady = warmShellEnv({ retryFailed: true })
  const cwd = request.cwd
    ? (isRemoteRun ? deps.resolveRemoteProjectDirectory(request.cwd) : deps.resolveKnownProjectDirectory(request.cwd))
    : deps.currentCwd
  if (options.workspaceAdmission && (isRemoteRun || cwd !== options.workspaceAdmission.cwd))
    throw new Error('工作区预留与真实启动目录不一致')
  if (!isRemoteRun && !options.workspaceAdmission && request.cwd && deps.currentCwd && cwd !== canonicalExistingDirectory(deps.currentCwd)) {
    throw new AgentRuntimeError('发送请求的工作目录与当前授权目录不一致', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '重新选择目标项目后再发送'
    })
  }
  const catalogCwd = cwd ?? ''
  const assertSessionNotArchived = (sessionIds: readonly (string | null | undefined)[]): void => {
    if (sessionIds.some((sessionId) => sessionId && deps.appSessionStore().isArchived({
      providerId, agentProfileId, cwd: catalogCwd, externalSessionId: sessionId
    }))) throw new AgentRuntimeError('这个会话已归档，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '先撤销归档，再继续该会话；待发送消息不会自动恢复'
    })
  }
  assertSessionNotArchived([request.expectedExternalSessionId])
  if (request.backend !== 'local') {
    throw new AgentRuntimeError(`backend=${request.backend} 尚未实现`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '切回 Local CLI；BYOK/API transport 尚未接入 Provider adapter'
    })
  }
  if (request.runtimeProvider && request.runtimeProvider !== runtimeProvider) {
    throw new AgentRuntimeError(`provider=${providerId} 与 runtimeProvider=${request.runtimeProvider} 不匹配`, {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '不要手工覆盖 runtimeProvider；由 Provider adapter descriptor 选择原生 transport'
    })
  }
  const lifecycleKey = providerOperationKey(providerId, agentProfileId)
  const startLease = isRemoteRun ? undefined : deps.providerOperationGate.acquireOperation(lifecycleKey)
  if (startLease && !startLease.ok) {
    throw new AgentRuntimeError('当前 Provider 正在认证 MCP，已拒绝启动新一轮', {
      provider: runtimeProvider,
      stage: 'frontdoor',
      cwd,
      nextAction: '等待浏览器认证完成或超时后再发送'
    })
  }
  const admissionKey = deps.providerContextKey(providerId, cwd ?? '', agentProfileId)
  const managedConversation = options.managedConversation
  const admissionKeys = managedConversation
    ? [admissionKey, `conversation:${managedConversation.conversationId}`]
    : [admissionKey]
  return { isRemoteRun, request, providerId, agentProfileId, startPerf, firstTracePerf, firstTextPerf, adapter, runtimeProvider, shellEnvReady, cwd, catalogCwd, startLease, managedConversation, admissionKeys, assertSessionNotArchived }
}
