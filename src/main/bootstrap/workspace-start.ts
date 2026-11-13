import { normalizeAgentStartRequest, type AgentStartRequest, type AgentStartResult } from '../../shared/runtime'
import type { SourceControlService } from '../source-control/service'
import type { ProviderRegistry } from '../providers/registry'
import { canonicalExistingDirectory } from '../workspace-authorization'
import { PerformanceTrace } from '../performance-timing'
import type { RemoteRunCompletion } from '../remote/remote-run-binding'
import type { AppRunStartOptions } from './run-frontdoor'

export type RemoteWorkspaceRunStart = AgentStartResult & { remoteCompletion: Promise<RemoteRunCompletion> }

export async function startWorkspaceRun(payload: AgentStartRequest, options: AppRunStartOptions, deps: {
  sourceControl: SourceControlService
  providerRegistry: ProviderRegistry
  getCurrentCwd: () => string | undefined
  getStartupManagedRecovery: () => Promise<void>
  resolveKnownProjectDirectory: (cwd: string) => string
  resolveRemoteProjectDirectory: (cwd: string) => string
  start: (request: AgentStartRequest, options: AppRunStartOptions) => Promise<AgentStartResult | RemoteRunCompletion>
}): Promise<AgentStartResult | RemoteWorkspaceRunStart> {
  if (options.managedConversation || options.workspaceAdmission)
    throw new Error('工作区选择只用于未绑定的新会话，不能改写已有对话')
  const request = normalizeAgentStartRequest(payload)
  if (!request.workspace || !request.cwd || !request.commandId || request.expectedExternalSessionId !== null)
    throw new Error('缺少新会话的工作区准备合同')
  const adapter = deps.providerRegistry.get(request.providerId)
  if (request.backend !== 'local' || request.runtimeProvider && request.runtimeProvider !== adapter.runtimeProvider)
    throw new Error('此工作区请求与本机 Provider transport 不匹配')
  const timing = new PerformanceTrace('workspace.prepare', { provider: request.providerId })
  try {
    await deps.getStartupManagedRecovery()
    const remote = options.origin === 'remote'
    if (remote && !options.runId) throw new Error('远程 Worktree 启动缺少运行标识')
    const cwd = remote ? deps.resolveRemoteProjectDirectory(request.cwd) : deps.resolveKnownProjectDirectory(request.cwd)
    const selected = deps.getCurrentCwd()
    if (!remote && selected && cwd !== canonicalExistingDirectory(selected)) throw new Error('发送前项目已切换；请确认保留的草稿后再发送')
    timing.mark('source_authorized')
    let remoteCompletion: Promise<RemoteRunCompletion> | undefined
    const result = await deps.sourceControl.startWorkspace({
      ...request, cwd, workspace: request.workspace, commandId: request.commandId
    }, async (workspace, runId, admit) => {
      timing.mark('git_prepared')
      timing.mark('target_authorized')
      const startOptions: AppRunStartOptions = {
        ...options, origin: remote ? 'remote' : 'local', runId, projectCwd: cwd,
        workspaceAdmission: { cwd: workspace.cwd, admit }
      }
      if (!remote) return deps.start({ ...request, cwd: workspace.cwd, workspace: undefined }, startOptions) as Promise<AgentStartResult>
      return new Promise<AgentStartResult>((resolve, reject) => {
        let registered = false
        remoteCompletion = deps.start({ ...request, cwd: workspace.cwd, workspace: undefined }, {
          ...startOptions,
          onRegistered: (value) => {
            registered = true
            options.onRegistered?.({ ...value, cwd: workspace.cwd })
            resolve(value)
          }
        }).then((value) => {
          if ('status' in value) return value
          throw new Error('远程 Worktree 启动缺少终态回执')
        })
        void remoteCompletion.catch((error) => { if (!registered) reject(error) })
      })
    }, remote ? options.runId : undefined)
    timing.mark('run_registered')
    timing.finish()
    if (remote) {
      if (!remoteCompletion) throw new Error('远程 Worktree 启动缺少运行回执')
      return { ...result, remoteCompletion }
    }
    return result
  } catch (error) {
    timing.finish(undefined, 'error')
    throw error
  }
}
