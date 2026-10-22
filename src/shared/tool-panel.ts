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
export const TOOL_PANEL_FINDING_ROWS = 20

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

export interface ToolPanelMcpFinding {
  id: string
  title: string
  severity: string
  confidence: string
  decision: string
  ruleId: string
  targets: string[]
  recommendation: string
}

export interface ToolPanelMcpScan {
  status: 'pass' | 'warn' | 'block' | null
  summary: { critical: number; high: number; medium: number; low: number; info: number } | null
  findings: ToolPanelMcpFinding[]
  findingsTruncated: boolean
}

export interface ToolPanelMcp {
  providerId: string
  configured: Array<{ name: string; scope: string; transport: string; enabled: boolean; targetId?: string }>
  runtime: Array<{ name: string; status: string; tools?: number }> | null
  configuredTruncated: boolean
  runtimeTruncated: boolean
  /** A read-only static scan. Absent with a reason when the host cannot scan. */
  scan?: ToolPanelMcpScan
  scanUnavailable?: string
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

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

// The scan report carries evidence paths, key names and hashes. The phone gets
// only what a reader needs to judge the finding, never that evidence.
export function shapeMcpScan(raw: unknown): ToolPanelMcpScan | undefined {
  const report = record(raw)
  const summary = record(report?.summary)
  if (!report || !Array.isArray(report.findings) || !summary) return undefined
  const counts = {
    critical: Number(summary.critical ?? 0), high: Number(summary.high ?? 0), medium: Number(summary.medium ?? 0),
    low: Number(summary.low ?? 0), info: Number(summary.info ?? 0)
  }
  const status = ['pass', 'warn', 'block'].includes(String(summary.status)) ? String(summary.status) as 'pass' | 'warn' | 'block' : null
  const findings = report.findings.flatMap((entry): ToolPanelMcpFinding[] => {
    const finding = record(entry)
    const rule = record(finding?.rule)
    const policy = record(finding?.policy)
    if (!finding || !rule || !policy) return []
    const severity = String(finding.severity)
    if (!SEVERITIES.includes(severity as (typeof SEVERITIES)[number])) return []
    const targets = Array.isArray(finding.affectedTargets)
      ? finding.affectedTargets.flatMap((target) => {
        const value = record(target)
        return typeof value?.targetId === 'string' ? [value.targetId] : []
      })
      : []
    return [{
      id: typeof finding.findingInstanceId === 'string' ? finding.findingInstanceId : String(rule.id ?? 'finding'),
      title: typeof finding.title === 'string' ? finding.title.slice(0, 200) : String(rule.id ?? 'finding'),
      severity,
      confidence: typeof finding.confidence === 'string' ? finding.confidence : 'possible',
      decision: String(policy.decision ?? 'pass'),
      ruleId: String(rule.id ?? ''),
      targets: targets.slice(0, 8),
      recommendation: typeof finding.recommendation === 'string' ? finding.recommendation.slice(0, 400) : ''
    }]
  })
  return {
    status,
    summary: counts,
    findings: findings.slice(0, TOOL_PANEL_FINDING_ROWS),
    findingsTruncated: findings.length > TOOL_PANEL_FINDING_ROWS
  }
}

export function shapeMcpPanel(providerId: string, snapshot: McpSnapshot, now = Date.now(),
                              scan?: ToolPanelMcpScan, scanUnavailable?: string): ToolPanelPayload {
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
      ...(scan ? { scan } : {}),
      ...(scanUnavailable ? { scanUnavailable } : {})
    }
  }
}
