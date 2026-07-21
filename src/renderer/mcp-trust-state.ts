import type { McpGuardReport } from './components/McpTrustPanel'

const MCP_TRUST_NO_CWD_KEY = '__scry_no_cwd__'

export function mcpTrustReportKey(activeCwd?: string | null): string {
  return activeCwd && activeCwd.trim() ? activeCwd : MCP_TRUST_NO_CWD_KEY
}

export function setMcpGuardReportForCwd(
  reportsByCwd: Record<string, McpGuardReport>,
  activeCwd: string | null | undefined,
  report: McpGuardReport
): Record<string, McpGuardReport> {
  return { ...reportsByCwd, [mcpTrustReportKey(activeCwd)]: report }
}

export function getMcpGuardReportForCwd(
  reportsByCwd: Record<string, McpGuardReport>,
  activeCwd: string | null | undefined
): McpGuardReport | null {
  return reportsByCwd[mcpTrustReportKey(activeCwd)] ?? null
}
