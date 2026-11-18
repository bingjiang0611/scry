import { mcpChannelHandlers } from '../../main/bootstrap/mcp-channels'
import { authorizedMcpExecution, ensureMcpExecutionAuthorized } from '../../main/bootstrap/trust'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

// MCP snapshot, test, re-auth and guard scan, from the table main registers, with the same
// trust and fingerprint checks (fail closed). The daemon cannot open a browser: the OAuth
// page, already checked as safe, goes to its App on the event feed, and the App opens it
// only while it is waiting for a re-auth it asked for.
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
  // The daemon is the process that owns Provider authentication.
  assertOwner: () => undefined
}) as Record<string, LocalOpHandler>
