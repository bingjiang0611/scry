import { shapeAnalyticsPanel, shapeLlmPanel, shapeMcpPanel, shapeMcpScan, type ToolPanelKind, type ToolPanelPayload } from '../../shared/tool-panel'
import type { ToolPanelSources } from './host-controller-types'

// Device-facing tool panels (analytics, LLM performance, MCP trust). The caller
// has already authorized the peer; every branch re-checks its own source.
export interface ToolPanelDeps {
  authorizeDevice(peer: string): void
  toolPanels: ToolPanelSources | undefined
}

function unavailable(kind: ToolPanelKind, readAt: number, reason: string): ToolPanelPayload {
  return { kind, readAt, unavailable: reason }
}

export async function readToolPanel(deps: ToolPanelDeps, peerCertSHA256: string, input: unknown): Promise<ToolPanelPayload> {
    deps.authorizeDevice(peerCertSHA256)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_tool_panel')
    const value = input as Record<string, unknown>
    const now = Date.now()
    if (value.kind === 'analytics') {
      const rangeDays = value.rangeDays ?? 7
      if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('invalid_tool_panel')
      // No source means no capability, which is not the same as no data: the device
      // gets the reason and no empty rows.
      if (!deps.toolPanels?.analytics) return unavailable('analytics', now, 'host 未提供 analytics 数据源')
      const analytics = await deps.toolPanels.analytics(rangeDays)
      return shapeAnalyticsPanel(analytics, now)
    }
    if (value.kind === 'llmPerformance') {
      if (!deps.toolPanels?.llmPerformance) return unavailable('llmPerformance', now, 'host 未提供 LLM performance 数据源')
      const [history, running] = await deps.toolPanels.llmPerformance()
      return shapeLlmPanel(history, running, now)
    }
    if (value.kind === 'mcpTrust') {
      const providerId = value.providerId
      if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) throw new Error('invalid_tool_panel')
      if (!deps.toolPanels?.mcpTrust) return unavailable('mcpTrust', now, 'host 未提供 MCP trust 数据源')
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
