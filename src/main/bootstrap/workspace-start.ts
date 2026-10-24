import { normalizeAgentStartRequest, type AgentStartRequest, type AgentStartResult } from '../../shared/runtime'
import type { SourceControlService } from '../source-control/service'
import type { ProviderRegistry } from '../providers/registry'
import { canonicalExistingDirectory } from '../workspace-authorization'
import { PerformanceTrace } from '../performance-timing'
import type { AppRunStartOptions } from './run-frontdoor'

export async function startWorkspaceRun(payload: AgentStartRequest, options: AppRunStartOptions, deps: {
  sourceControl: SourceControlService
  providerRegistry: ProviderRegistry
  getCurrentCwd: () => string | undefined
  getStartupManagedRecovery: () => Promise<void>
  resolveKnownProjectDirectory: (cwd: string) => string
  rememberProject: (cwd: string) => void
  start: (request: AgentStartRequest, options: AppRunStartOptions & { origin?: 'local' }) => Promise<AgentStartResult>
}): Promise<AgentStartResult> {
  if (options.origin === 'remote' || options.managedConversation || options.workspaceAdmission)
    throw new Error('工作区选择只用于本机未绑定的新会话，不能改写远端或已有对话')
  const request = normalizeAgentStartRequest(payload)
  if (!request.workspace || !request.cwd || !request.commandId || request.expectedExternalSessionId !== null)
    throw new Error('缺少新会话的工作区准备合同')
  const adapter = deps.providerRegistry.get(request.providerId)
  if (request.backend !== 'local' || request.runtimeProvider && request.runtimeProvider !== adapter.runtimeProvider)
    throw new Error('此工作区请求与本机 Provider transport 不匹配')
  const timing = new PerformanceTrace('workspace.prepare', { provider: request.providerId })
  try {
    await deps.getStartupManagedRecovery()
    const cwd = deps.resolveKnownProjectDirectory(request.cwd)
    const selected = deps.getCurrentCwd()
    if (selected && cwd !== canonicalExistingDirectory(selected)) throw new Error('发送前项目已切换；请确认保留的草稿后再发送')
    timing.mark('source_authorized')
    const result = await deps.sourceControl.startWorkspace({
      ...request, cwd, workspace: request.workspace, commandId: request.commandId
    }, async (workspace, runId, admit) => {
      timing.mark('git_prepared')
      // Use exactly the picker authority. Its existing synchronous store is shared
      // with local/paired owners; a separate async writer could lose concurrent grants.
      deps.rememberProject(workspace.cwd)
      deps.resolveKnownProjectDirectory(workspace.cwd)
      timing.mark('target_authorized')
      return deps.start({ ...request, cwd: workspace.cwd, workspace: undefined }, {
        ...options, origin: 'local', runId, workspaceAdmission: { cwd: workspace.cwd, admit }
      })
    })
    timing.mark('run_registered')
    timing.finish()
    return result
  } catch (error) {
    timing.finish(undefined, 'error')
    throw error
  }
}
