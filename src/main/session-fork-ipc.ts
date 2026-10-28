import type { IpcMainInvokeEvent } from 'electron'
import { sessionForkCopy as copy } from '../shared/constants/session-fork-copy'
import { normalizeAgentForkSessionRequest } from '../shared/runtime'
import type { AgentForkSessionResult, RuntimeProvider } from '../shared/runtime'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { createAppSessionStore } from './app-store'
import type { createProviderTrust } from './provider-trust'
import type { ProviderRegistry } from './providers/registry'
import { providerOperationKey, type ProviderOperationGate } from './provider-operation-gate'
import { verifyForkArchiveBoundary } from './session-fork'
import type { readTraceArchiveAsync, TraceArchiveTurn } from './transcript-archive'
import type { McpExecutionSnapshot } from './mcp-execution-trust'

export function registerSessionForkIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  providerRegistry: Pick<ProviderRegistry, 'get'>
  providerOperationGate: Pick<ProviderOperationGate, 'acquireOperation'>
  resolveKnownProjectDirectory: (cwd: string) => string
  currentCwd: () => string | undefined
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  contextAdmission: { run: <T>(key: string, action: () => Promise<T>) => Promise<T> }
  startupManagedRecovery: () => Promise<void>
  assertLegacyConversationWriteAllowed: (scope: {
    providerId: ProviderId
    agentProfileId?: string
    cwd: string
    nativeSessionId: string
  }) => Promise<void>
  readTraceArchive: typeof readTraceArchiveAsync
  resolveCodexHookTrust: ReturnType<typeof createProviderTrust>['resolveCodexHookTrust']
  resolveOpenCodePluginTrust: ReturnType<typeof createProviderTrust>['resolveOpenCodePluginTrust']
  ensureMcpExecutionAuthorized: ReturnType<typeof createProviderTrust>['ensureMcpExecutionAuthorized']
  authorizedMcpExecution: ReturnType<typeof createProviderTrust>['authorizedMcpExecution']
  userDataDir: () => string
  cloneForkArchiveTurns: (args: {
    turns: TraceArchiveTurn[]
    targetSessionId: string
    providerId: ProviderId
    runtimeProvider: RuntimeProvider
    cwd: string
  }) => void
  resetSessionContext: (key: string) => void
  setSessionForContext: (key: string, sessionId: string) => void
  invalidateSessionHistoryLoad: (reason: string) => void
  appSessionStore: () => Pick<ReturnType<typeof createAppSessionStore>, 'record'>
  rememberProject: (cwd: string) => void
}) {
  deps.handleTrusted('agent:forkSession', async (_event, payload: unknown): Promise<AgentForkSessionResult> => {
    const request = normalizeAgentForkSessionRequest(payload)
    const providerId = request.providerId
    const cwd = request.cwd ? deps.resolveKnownProjectDirectory(request.cwd) : deps.currentCwd()
    const catalogCwd = cwd ?? ''
    const agentProfileId = request.agentProfileId
    const adapter = deps.providerRegistry.get(providerId)
    const forkSession = adapter.forkSession
    if (!forkSession) throw new Error(copy.unsupported)
    const lifecycleKey = providerOperationKey(providerId, agentProfileId)
    const lease = deps.providerOperationGate.acquireOperation(lifecycleKey)
    if (!lease.ok) throw new Error(copy.authenticating)
    const contextKey = deps.providerContextKey(providerId, catalogCwd, agentProfileId)
    try {
      return await deps.contextAdmission.run(contextKey, async () => {
        await deps.startupManagedRecovery()
        await deps.assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
        const archive = await deps.readTraceArchive({
          userDataDir: deps.userDataDir(),
          providerId,
          cwd: catalogCwd,
          sessionId: request.sourceSessionId
        })
        const { source, prefix } = verifyForkArchiveBoundary(archive, request)
        const codexHookTrust = providerId === 'codex' && cwd ? await deps.resolveCodexHookTrust(cwd) : []
        const openCodePluginTrust = providerId === 'opencode' && cwd
          ? await deps.resolveOpenCodePluginTrust(cwd)
          : undefined
        const mcpExecutionSnapshot: McpExecutionSnapshot | null = providerId === 'pi'
          ? null
          : await deps.ensureMcpExecutionAuthorized({ providerId, cwd } satisfies ProviderContext, 'run')
        await deps.assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd: catalogCwd, nativeSessionId: request.sourceSessionId })
        const forked = await forkSession.fork({
          ...request,
          cwd,
          agentProfileId,
          codexHookTrust,
          openCodePluginTrust,
          mcpExecution: deps.authorizedMcpExecution(mcpExecutionSnapshot)
        })
        if (!forked.externalSessionId) throw new Error(copy.missingIdentity)
        deps.cloneForkArchiveTurns({
          turns: prefix,
          targetSessionId: forked.externalSessionId,
          providerId,
          runtimeProvider: adapter.runtimeProvider,
          cwd: catalogCwd
        })
        deps.resetSessionContext(contextKey)
        deps.setSessionForContext(contextKey, forked.externalSessionId)
        deps.invalidateSessionHistoryLoad('session forked')
        deps.appSessionStore().record({
          providerId,
          agentProfileId,
          runtimeProvider: adapter.runtimeProvider,
          externalSessionId: forked.externalSessionId,
          cwd: catalogCwd,
          prompt: source.userText
        })
        if (cwd) deps.rememberProject(cwd)
        return { externalSessionId: forked.externalSessionId }
      })
    } finally {
      lease.release()
    }
  })
}
