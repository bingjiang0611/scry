import { shapeAnalyticsPanel, shapeLlmPanel, shapeMcpPanel, shapeMcpScan, type ToolPanelPayload } from '../../shared/tool-panel'
import type { ToolPanelSources } from './host-controller-types'

// Device-facing tool panels (analytics, LLM performance, MCP trust). The caller
// has already authorized the peer; every branch re-checks its own source.
export interface ToolPanelDeps {
  authorizeDevice(peer: string): void
  toolPanels: ToolPanelSources | undefined
}

export async function readToolPanel(deps: ToolPanelDeps, peerCertSHA256: string, input: unknown): Promise<ToolPanelPayload> {
    deps.authorizeDevice(peerCertSHA256)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_tool_panel')
    const value = input as Record<string, unknown>
    const now = Date.now()
    if (value.kind === 'analytics') {
      const rangeDays = value.rangeDays ?? 7
      if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('invalid_tool_panel')
      if (!deps.toolPanels?.analytics) throw new Error('tool_panel_unavailable')
      const analytics = await deps.toolPanels.analytics(rangeDays)
      return shapeAnalyticsPanel(analytics, now)
    }
    if (value.kind === 'llmPerformance') {
      if (!deps.toolPanels?.llmPerformance) throw new Error('tool_panel_unavailable')
      const [history, running] = await deps.toolPanels.llmPerformance()
      return shapeLlmPanel(history, running, now)
    }
    if (value.kind === 'mcpTrust') {
      const providerId = value.providerId
      if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) throw new Error('invalid_tool_panel')
      if (!deps.toolPanels?.mcpTrust) throw new Error('tool_panel_unavailable')
      // The scan is static and read-only: it inspects configuration and tool
      // fingerprints and never starts, authorizes or connects an MCP server.
      const result = await deps.toolPanels.mcpTrust({ providerId })
      if (result.unavailable) return { kind: 'mcpTrust', readAt: now, unavailable: result.unavailable }
      const scan = shapeMcpScan(result.scan)
      const snapshot = result.snapshot ?? { configured: [], runtime: null }
      return shapeMcpPanel(providerId, snapshot, now, scan,
        scan ? undefined : '这次没有生成可读的扫描报告')
    }
    throw new Error('invalid_tool_panel')
}
