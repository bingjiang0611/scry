import type { DaemonLocalOpTable } from './types'

// MCP (B4-L4): main's four MCP channels run by the daemon, which owns the Provider
// processes and their auth queue. A refreshed snapshot, a test and a re-auth start MCP
// servers, so none of them is replayed after a lost reply; the guard scan only reads.
// They take the `long` lane, whose timeout fits an OAuth sign-in and a first npx install.
export const MCP_LOCAL_OPS: DaemonLocalOpTable = {
  'agent:mcpSnapshot': { op: 'mcp', method: 'mcpSnapshot', read: false },
  'agent:testMcp': { op: 'mcp', method: 'testMcp', read: false },
  'agent:reauthenticateMcp': { op: 'mcp', method: 'reauthenticateMcp', read: false },
  'agent:mcpGuardScan': { op: 'mcp', method: 'mcpGuardScan', read: true }
}
