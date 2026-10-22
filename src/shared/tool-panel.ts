import type { LlmPerformanceHistory, LlmPerformanceSummary } from './llm-performance.js'
import { groupRunningLlmSessions } from './llm-performance.js'
import type { McpSnapshot } from './provider.js'
import type { UsageAnalytics, UsageAnalyticsRangeDays } from './trace.js'

// A paired device reads the same panels the Mac shows, but only as a bounded,
// already-computed projection. Nothing here scans, executes, or invents a value:
// a missing number stays null and an unavailable source keeps its reason.

export type ToolPanelKind = 'analytics' | 'llmPerformance' | 'mcpTrust'

export const TOOL_PANEL_MODEL_ROWS = 20
export const TOOL_PANEL_PROVIDER_ROWS = 12
export const TOOL_PANEL_HISTORY_ROWS = 200
export const TOOL_PANEL_RUNNING_ROWS = 20
export const TOOL_PANEL_MCP_TARGETS = 40

export interface ToolPanelTokenTotals {
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  turns: number
  tokenKnownRows: number
  costKnownRows: number
  exactCostRows: number
  estimatedCostRows: number
  inferredCostRows: number
}

export interface ToolPanelAnalytics {
  rangeDays: UsageAnalyticsRangeDays
  status: UsageAnalytics['status']
  observedAt: number
  fromDay: string
  toDay: string
  totals: ToolPanelTokenTotals
  byDay: Array<{ day: string; costUsd: number | null; inputTokens: number | null; outputTokens: number | null }>
  byProvider: Array<{ provider: string; costUsd: number | null; inputTokens: number | null; outputTokens: number | null; turns: number }>
  byModel: Array<{ provider: string; model: string | null; costUsd: number | null; turns: number; tokenKnownRows: number }>
  byModelTruncated: boolean
  byProviderTruncated: boolean
}

export interface ToolPanelLlm {
  running: {
    observedAt: string
    models: Array<{
      key: string
      model?: string
      sessions: number
      tokensPerSecond?: number
      firstTokenMs?: number
      states: string[]
    }>
  }
  history: {
    rows: Array<{ ts: string; model: string; providerId: string; speed: number | null; firstTokenMs: number | null; failed: boolean }>
    truncated: boolean
    invalidLines: number
    /** Host-side cap; the phone shows this instead of pretending the list is complete. */
    cappedAt: number
  }
}

export interface ToolPanelMcp {
  providerId: string
  configured: Array<{ name: string; scope: string; transport: string; enabled: boolean; targetId?: string }>
  runtime: Array<{ name: string; status: string; tools?: number }> | null
  configuredTruncated: boolean
  runtimeTruncated: boolean
  /** The phone never triggers an MCP scan, so findings are absent by construction. */
  findingsUnavailable: string
}

export interface ToolPanelPayload {
  kind: ToolPanelKind
  readAt: number
  unavailable?: string
  analytics?: ToolPanelAnalytics
  llm?: ToolPanelLlm
  mcp?: ToolPanelMcp
}

function totals(source: UsageAnalytics['totals']): ToolPanelTokenTotals {
  return {
    costUsd: source.costUsd,
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cacheReadTokens: source.cacheReadTokens,
    cacheWriteTokens: source.cacheWriteTokens,
    reasoningTokens: source.reasoningTokens,
    turns: source.turns,
    tokenKnownRows: source.tokenKnownRows,
    costKnownRows: source.costKnownRows,
    exactCostRows: source.exactCostRows,
    estimatedCostRows: source.estimatedCostRows,
    inferredCostRows: source.inferredCostRows
  }
}

export function shapeAnalyticsPanel(analytics: UsageAnalytics, now = Date.now()): ToolPanelPayload {
  const models = analytics.byModel ?? []
  const providers = analytics.byProvider ?? []
  return {
    kind: 'analytics',
    readAt: now,
    analytics: {
      rangeDays: analytics.rangeDays,
      status: analytics.status,
      observedAt: analytics.observedAt,
      fromDay: analytics.fromDay,
      toDay: analytics.toDay,
      totals: totals(analytics.totals),
      byDay: (analytics.byDay ?? []).map(row => ({
        day: row.day,
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens
      })),
      byProvider: providers.slice(0, TOOL_PANEL_PROVIDER_ROWS).map(row => ({
        provider: String(row.provider),
        costUsd: row.costUsd,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        turns: row.turns
      })),
      byModel: models.slice(0, TOOL_PANEL_MODEL_ROWS).map(row => ({
        provider: String(row.provider),
        model: row.model,
        costUsd: row.costUsd,
        turns: row.turns,
        tokenKnownRows: row.tokenKnownRows
      })),
      byModelTruncated: models.length > TOOL_PANEL_MODEL_ROWS,
      byProviderTruncated: providers.length > TOOL_PANEL_PROVIDER_ROWS
    }
  }
}

export function shapeLlmPanel(history: LlmPerformanceHistory, running: LlmPerformanceSummary, now = Date.now()): ToolPanelPayload {
  const rows = history.rows ?? []
  const models = groupRunningLlmSessions(running.sessions)
  return {
    kind: 'llmPerformance',
    readAt: now,
    llm: {
      running: {
        observedAt: running.observedAt,
        models: models.slice(0, TOOL_PANEL_RUNNING_ROWS).map(group => ({
          key: group.key,
          ...(group.model ? { model: group.model } : {}),
          sessions: group.sessions.length,
          ...(group.tokensPerSecond != null ? { tokensPerSecond: group.tokensPerSecond } : {}),
          ...(group.firstTokenMs != null ? { firstTokenMs: group.firstTokenMs } : {}),
          states: [...new Set(group.sessions.map(session => session.state))]
        }))
      },
      history: {
        rows: rows.slice(0, TOOL_PANEL_HISTORY_ROWS).map(row => ({
          ts: row.ts,
          model: row.model,
          providerId: String(row.providerId),
          speed: row.performance?.apiTokensPerSecond ?? null,
          firstTokenMs: row.performance?.firstTokenMs ?? null,
          failed: row.failed === true
        })),
        truncated: history.truncated === true || rows.length > TOOL_PANEL_HISTORY_ROWS,
        invalidLines: history.invalidLines ?? 0,
        cappedAt: TOOL_PANEL_HISTORY_ROWS
      }
    }
  }
}

export function shapeMcpPanel(providerId: string, snapshot: McpSnapshot, now = Date.now()): ToolPanelPayload {
  const configured = snapshot.configured ?? []
  const runtime = snapshot.runtime
  return {
    kind: 'mcpTrust',
    readAt: now,
    mcp: {
      providerId,
      configured: configured.slice(0, TOOL_PANEL_MCP_TARGETS).map(entry => ({
        name: entry.name,
        scope: entry.scope,
        transport: entry.transport,
        enabled: entry.enabled,
        ...(entry.targetId ? { targetId: entry.targetId } : {})
      })),
      runtime: runtime == null ? null : runtime.slice(0, TOOL_PANEL_MCP_TARGETS).map(entry => ({
        name: entry.name,
        status: entry.status,
        ...(entry.tools != null ? { tools: entry.tools } : {})
      })),
      configuredTruncated: configured.length > TOOL_PANEL_MCP_TARGETS,
      runtimeTruncated: runtime != null && runtime.length > TOOL_PANEL_MCP_TARGETS,
      findingsUnavailable: '手机端不触发 MCP 扫描；风险发现在 Mac 上读取'
    }
  }
}
