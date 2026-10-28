import type { ConversationServiceDeps } from './conversation-service'
import type { ProviderRegistry } from './providers/registry'
import { ProviderOperationGate, providerOperationKey } from './provider-operation-gate'
import type { ContextAdmission } from './context-admission'
import type { ProviderId } from '../shared/provider'

export interface ForkConversationDeps {
  resolveKnownProjectDirectory: (cwd: string) => string
  providerRegistry: ProviderRegistry
  providerOperationGate: ProviderOperationGate
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  contextAdmission: ContextAdmission
  runs: { unsettledStates: () => Array<{ providerId?: ProviderId; agentProfileId?: string; cwd?: string }> }
  readTraceArchive: typeof import('./transcript-archive').readTraceArchiveAsync
  verifyForkArchiveBoundary: typeof import('./session-fork').verifyForkArchiveBoundary
  resolveCodexHookTrust: (cwd: string) => Promise<import('./codex-hook-trust').CodexHookTrustGrant[]>
  ensureMcpExecutionAuthorized: (scope: { providerId: ProviderId; cwd?: string }, operation: 'run') => Promise<import('./mcp-execution-trust').McpExecutionSnapshot | null>
  authorizedMcpExecution: (snapshot: import('./mcp-execution-trust').McpExecutionSnapshot | null) => import('./providers/types').AuthorizedMcpExecution | undefined
  getUserData: () => string
}

export async function forkManagedConversation(
  input: Parameters<NonNullable<ConversationServiceDeps['forkNative']>>[0],
  deps: ForkConversationDeps
): Promise<string> {
  const { source, binding, turn, permissionMode, beforeFork } = input
  const cwd = deps.resolveKnownProjectDirectory(source.cwd)
  const { providerId, agentProfileId } = binding
  const adapter = deps.providerRegistry.get(providerId)
  if (!adapter.forkSession) throw new Error('该轮的 Provider 不支持原生分支')
  if (providerId === 'pi' && permissionMode !== 'full_access') throw new Error('Pi 原生分支需要明确选择本机完全访问')
  const lease = deps.providerOperationGate.acquireOperation(providerOperationKey(providerId, agentProfileId))
  if (!lease.ok) throw new Error('源 Provider 正在认证，不能创建分支')
  try {
    return await deps.contextAdmission.run(deps.providerContextKey(providerId, cwd, agentProfileId), async () => {
      if (deps.runs.unsettledStates().some(run => run.providerId === providerId && run.agentProfileId === agentProfileId && run.cwd === cwd)) {
        throw new Error('源 Provider 仍在运行或保存证据，请等待收敛')
      }
      if (!turn.archive) throw new Error('分支轮次缺少已提交归档')
      const archive = await deps.readTraceArchive({ userDataDir: deps.getUserData(), providerId, cwd, sessionId: turn.archive.sessionId })
      const recorded = archive?.turns.find(item => item.runId === turn.runId)
      if (!recorded?.providerTurnId) throw new Error('归档没有稳定的原生轮次边界')
      const request = { providerId, agentProfileId, cwd, sourceSessionId: binding.nativeSessionId!, sourceRunId: turn.runId,
        sourceProviderTurnId: recorded.providerTurnId, sourceForkTurnId: recorded.forkTurnId ?? recorded.providerTurnId, permissionMode }
      deps.verifyForkArchiveBoundary(archive, request)
      const codexHookTrust = providerId === 'codex' ? await deps.resolveCodexHookTrust(cwd) : []
      const mcpSnapshot = providerId === 'pi' ? null : await deps.ensureMcpExecutionAuthorized({ providerId, cwd }, 'run')
      const result = await adapter.forkSession!.fork({ ...request, expectedContinuationKey: binding.continuationKey,
        beforeFork, codexHookTrust, mcpExecution: deps.authorizedMcpExecution(mcpSnapshot) })
      if (!result.externalSessionId) throw new Error('Provider 未返回原生分支身份')
      return result.externalSessionId
    })
  } finally { lease.release() }
}
