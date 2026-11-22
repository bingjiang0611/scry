import { mcpChannelHandlers } from '../../main/bootstrap/mcp-channels'
import { authorizedMcpExecution, ensureMcpExecutionAuthorized } from '../../main/bootstrap/trust'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

export const mcpLocalOps: DaemonLocalOpGroup = ({ providers, session, workspace, events, runs }) => mcpChannelHandlers({
  providerRegistry: providers.providerRegistry,
  withProviderOperation: session.withProviderOperation,
  ensureMcpExecutionAuthorized,
  authorizedMcpExecution,
  homeDir: workspace.homeDir,
  getRuns: runs,
  canonicalProviderCwd: session.canonicalProviderCwd,
  providerOperationGate: session.providerOperationGate,
  openExternal: async (url) => { events.append({ kind: 'oauth', url }) },
  assertOwner: () => undefined
}) as Record<string, LocalOpHandler>
