import { shell } from 'electron'
import { providerControlChannelHandlers, registerChannelHandlers } from './startup-channels'
import { mcpChannelHandlers } from './mcp-channels'
import { installMcpDaemonWindow } from './mcp-daemon'
import { providerCommandChannelHandlers, skillChannelHandlers } from './query-channels'
import { providerContextChannelHandlers } from './project-channels'
import { installProviderContextWindowCwd } from './project-daemon'
import type { IpcMainInvokeEvent } from 'electron'
import { daemonModeEnabled } from './daemon-run-mode'
import type { ProviderContext, ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import type { McpExecutionOperation, McpExecutionSnapshot } from '../mcp-execution-trust'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { AuthorizedMcpExecution } from '../providers/types'
import { providerOperationKey } from '../provider-operation-gate'

export interface ProviderHandlersDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  providerRegistry: ProviderRegistry
  withProviderOperation: <T>(providerId: ProviderId, operation: () => T | Promise<T>, agentProfileId?: string) => Promise<T>
  getRemoteProviderDiscovery: () => { invalidate: (providerId: ProviderId) => void }
  refreshInvalidatedRemoteProviderMetadata: () => void
  ensureMcpExecutionAuthorized: (context: ProviderContext, operation: McpExecutionOperation, targetId?: string) => Promise<McpExecutionSnapshot | null>
  authorizedMcpExecution: (snapshot: McpExecutionSnapshot | null) => AuthorizedMcpExecution | undefined
  homeDir: string
  getCurrentCwd: () => string | undefined
  getRuns: () => { activeStates: () => Array<{ done: boolean; providerId?: ProviderId }> }
  canonicalProviderCwd: (cwd?: string) => string
  providerOperationKey: typeof providerOperationKey
  providerOperationGate: ProviderOperationGate
}

/**
 * Under the daemon switch the daemon owns Provider processes and their auth queue.
 * Running an MCP test or re-auth here would authenticate in THIS process, outside that
 * queue, and the daemon's runs would not see it. MCP moves into the daemon in B4-L4;
 * until then the capability is named absent instead of racing it.
 */
function assertMcpAuthOwner(): void {
  if (daemonModeEnabled()) throw new Error('daemon_capability_unavailable:mcp-auth')
}

export function registerProviderHandlers(deps: ProviderHandlersDependencies): void {
  const { handleTrusted, providerRegistry, withProviderOperation, getRemoteProviderDiscovery, refreshInvalidatedRemoteProviderMetadata, ensureMcpExecutionAuthorized, authorizedMcpExecution, homeDir, getCurrentCwd, getRuns, canonicalProviderCwd, providerOperationGate } = deps
  // Shared with the daemon (B4-L4). In daemon mode the App fills a missing cwd with this
  // window's selection before the call, as the handler does here.
  registerChannelHandlers(handleTrusted, providerContextChannelHandlers({
    providerRegistry, withProviderOperation,
    invalidateDiscovery: (providerId) => getRemoteProviderDiscovery().invalidate(providerId),
    refreshInvalidatedMetadata: refreshInvalidatedRemoteProviderMetadata,
    currentCwd: getCurrentCwd
  }))
  if (daemonModeEnabled()) {
    installProviderContextWindowCwd(getCurrentCwd)
    // MCP runs in the daemon; its OAuth page opens here, for this window's own re-auth.
    installMcpDaemonWindow({ openExternal: (url) => shell.openExternal(url) })
  }
  registerChannelHandlers(handleTrusted, skillChannelHandlers({ providerRegistry, withProviderOperation }))
  registerChannelHandlers(handleTrusted, mcpChannelHandlers({
    providerRegistry, withProviderOperation, ensureMcpExecutionAuthorized, authorizedMcpExecution, homeDir, getRuns,
    canonicalProviderCwd, providerOperationGate, openExternal: (url) => shell.openExternal(url), assertOwner: assertMcpAuthOwner
  }))
  registerChannelHandlers(handleTrusted, providerCommandChannelHandlers({ providerRegistry, withProviderOperation }))
  registerChannelHandlers(handleTrusted, providerControlChannelHandlers({ providerRegistry, withProviderOperation }))


}
