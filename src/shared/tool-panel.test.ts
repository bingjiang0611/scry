import { describe, expect, it } from 'vitest'
import {
  shapeAnalyticsPanel, shapeLlmPanel, shapeMcpPanel, shapeMcpScan,
  TOOL_PANEL_FINDING_ROWS, TOOL_PANEL_HISTORY_ROWS, TOOL_PANEL_MODEL_ROWS
} from './tool-panel'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from './llm-performance'
import type { McpSnapshot } from './provider'
import type { UsageAnalytics, UsageAnalyticsAggregate } from './trace'

const aggregate = (over: Partial<UsageAnalyticsAggregate> = {}): UsageAnalyticsAggregate => ({
  inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
  costUsd: null, turns: 3, usageRows: 3, inputKnownRows: 2, outputKnownRows: 2, cacheReadKnownRows: 0,
  cacheWriteKnownRows: 0, reasoningKnownRows: 0, tokenKnownRows: 2, costKnownRows: 1,
  exactCostRows: 1, providerReportedCostRows: 0, estimatedCostRows: 0, inferredCostRows: 0, ...over
})

const analytics = (over: Partial<UsageAnalytics> = {}): UsageAnalytics => ({
  status: 'ready', rangeDays: 7, fromDay: '2026-10-15', toDay: '2026-10-21', observedAt: 1,
  days: ['2026-10-15'], totals: aggregate({ costUsd: 1.25 }),
  byDay: [{ day: '2026-10-15', ...aggregate() }],
  dailyByProvider: [], byProvider: [], byModel: [], ...over
})

describe('tool panel shaping', () => {
  it('keeps unknown token and cost values null instead of zero', () => {
    const panel = shapeAnalyticsPanel(analytics({
      byModel: [{ provider: 'claude', model: 'opus', ...aggregate({ costUsd: null }) } as never]
    }), 42)
    expect(panel.readAt).toBe(42)
    expect(panel.analytics?.totals.costUsd).toBe(1.25)
    expect(panel.analytics?.totals.inputTokens).toBeNull()
    // A model row without a known cost is not a breakdown row at all; the Mac
    // table drops it too, so the phone must not invent an "unavailable" line.
    expect(panel.analytics?.byModel).toEqual([])
    // Coverage counters travel with the projection so the phone can show evidence.
    expect(panel.analytics?.totals.tokenKnownRows).toBe(2)
    expect(panel.analytics?.totals.exactCostRows).toBe(1)
  })

  it('caps model and provider rows and says the list is truncated', () => {
    const rows = Array.from({ length: TOOL_PANEL_MODEL_ROWS + 5 }, (_, index) => ({
      provider: 'claude', model: `model-${index}`, ...aggregate({ costUsd: index })
    })) as never[]
    const panel = shapeAnalyticsPanel(analytics({ byModel: rows, byProvider: rows }))
    expect(panel.analytics?.byModel).toHaveLength(TOOL_PANEL_MODEL_ROWS)
    expect(panel.analytics?.byModelTruncated).toBe(true)
    expect(panel.analytics?.byProviderTruncated).toBe(true)
  })

  it('lists the same model rows the Mac shows: known cost, no qoder model, ranked', () => {
    const panel = shapeAnalyticsPanel(analytics({
      byModel: [
        { provider: 'codex', model: 'gpt-6.1-sol', ...aggregate({ costUsd: 10 }) },
        { provider: 'claude', model: 'opus', ...aggregate({ costUsd: 30 }) },
        { provider: 'radius', model: 'recursive/flint', ...aggregate({ costUsd: null }) },
        { provider: 'qoder', model: 'qoder-model', ...aggregate({ costUsd: 9 }) }
      ] as never,
      byProvider: [
        { provider: 'qoder', ...aggregate({ costUsd: 9, turns: 110 }) },
        { provider: 'radius', ...aggregate({ costUsd: null }) }
      ] as never
    }))
    expect(panel.analytics?.byModel.map(row => [row.provider, row.model, row.costUsd])).toEqual([
      ['claude', 'opus', 30],
      ['codex', 'gpt-6.1-sol', 10],
      // qoder's credits are attributed to the provider, exactly like the Mac table.
      ['qoder', null, 9]
    ])
    // Only rows the Mac would draw as approximate carry the marker.
    expect(panel.analytics?.byModel.map(row => row.approximate)).toEqual([false, false, false])
  })

  it('reports running sessions grouped by model without inventing a measurement', () => {
    const running: LlmPerformanceSummary = {
      observedAt: '2026-10-21T12:00:00.000Z',
      sessions: [
        { key: 'a', runId: 'r1', state: 'streaming', outputStarted: true, model: 'opus', tokensPerSecond: 40 },
        { key: 'b', runId: 'r2', state: 'waiting', outputStarted: false, model: 'opus' }
      ]
    }
    const history: LlmPerformanceHistory = { rows: [], invalidLines: 2, truncated: false }
    const panel = shapeLlmPanel(history, running, 7)
    expect(panel.llm?.running.models).toHaveLength(1)
    expect(panel.llm?.running.models[0].sessions).toBe(2)
    expect(panel.llm?.running.models[0].tokensPerSecond).toBe(40)
    expect(panel.llm?.running.models[0].states.sort()).toEqual(['streaming', 'waiting'])
    expect(panel.llm?.history.rows).toEqual([])
    expect(panel.llm?.history.invalidLines).toBe(2)
  })

  it('caps history rows and marks truncation from either side', () => {
    const rows = Array.from({ length: TOOL_PANEL_HISTORY_ROWS + 1 }, (_, index) => ({
      runId: `r${index}`, ts: '2026-10-21T10:00:00.000Z', providerId: 'claude', model: 'opus', networkLabel: 'wifi',
      failed: false, performance: { apiTokensPerSecond: 30 }
    })) as never[]
    const panel = shapeLlmPanel({ rows, invalidLines: 0, truncated: false }, { observedAt: 'now', sessions: [] })
    expect(panel.llm?.history.rows).toHaveLength(TOOL_PANEL_HISTORY_ROWS)
    expect(panel.llm?.history.truncated).toBe(true)
    expect(panel.llm?.history.cappedAt).toBe(TOOL_PANEL_HISTORY_ROWS)
    const withoutPerformance = { ...(rows[0] as Record<string, unknown>), performance: {} } as never
    const missing = shapeLlmPanel({ rows: [withoutPerformance], invalidLines: 0, truncated: false },
      { observedAt: 'now', sessions: [] })
    expect(missing.llm?.history.rows[0].speed).toBeNull()
    expect(missing.llm?.history.rows[0].firstTokenMs).toBeNull()
  })

  it('shapes MCP findings without leaking evidence paths or key names', () => {
    const scan = shapeMcpScan({
      summary: { critical: 1, high: 2, medium: 0, low: 0, info: 0, status: 'block' },
      findings: [
        { findingInstanceId: 'f1', title: '未固定版本', severity: 'critical', confidence: 'high',
          rule: { id: 'mcpguard/unpinned-package' }, policy: { decision: 'block' },
          affectedTargets: [{ targetId: 't1', role: 'subject' }], recommendation: '固定版本',
          evidence: [{ path: '/Users/me/.claude.json', keyName: 'GITHUB_TOKEN', snippetHash: 'abc' }] },
        { findingInstanceId: 'f2', title: '未知严重度', severity: 'unknown', confidence: 'low',
          rule: { id: 'r' }, policy: { decision: 'warn' }, affectedTargets: [] }
      ]
    })
    expect(scan?.status).toBe('block')
    expect(scan?.summary).toEqual({ critical: 1, high: 2, medium: 0, low: 0, info: 0 })
    expect(scan?.findings).toHaveLength(1)
    expect(JSON.stringify(scan)).not.toContain('/Users/me/.claude.json')
    expect(JSON.stringify(scan)).not.toContain('GITHUB_TOKEN')
    expect(shapeMcpScan({ summary: { status: 'pass' } })).toBeUndefined()
  })

  it('caps MCP findings and marks the truncation', () => {
    const findings = Array.from({ length: TOOL_PANEL_FINDING_ROWS + 3 }, (_, index) => ({
      findingInstanceId: `f${index}`, title: `finding-${index}`, severity: 'high', confidence: 'high',
      rule: { id: 'r' }, policy: { decision: 'warn' }, affectedTargets: []
    }))
    const scan = shapeMcpScan({ summary: { critical: 0, high: 23, medium: 0, low: 0, info: 0, status: 'warn' }, findings })
    expect(scan?.findings).toHaveLength(TOOL_PANEL_FINDING_ROWS)
    expect(scan?.findingsTruncated).toBe(true)
  })

  it('passes MCP configured/runtime through and keeps an absent scan explicit', () => {
    const snapshot: McpSnapshot = {
      configured: [{ name: 'fs', scope: 'user', transport: 'stdio', detail: 'npx', enabled: true, targetId: 't1' }],
      runtime: [{ name: 'fs', status: 'connected', tools: 4 }]
    }
    const panel = shapeMcpPanel('claude', snapshot)
    expect(panel.mcp?.providerId).toBe('claude')
    expect(panel.mcp?.configured[0]).toMatchObject({ name: 'fs', enabled: true, targetId: 't1' })
    expect(panel.mcp?.runtime?.[0]).toEqual({ name: 'fs', status: 'connected', tools: 4 })
    // No scan evidence stays absent with a reason, never "no findings".
    expect(panel.mcp?.scan).toBeUndefined()
    expect(shapeMcpPanel('claude', snapshot, 1, undefined, '这次没有生成可读的扫描报告').mcp?.scanUnavailable)
      .toBe('这次没有生成可读的扫描报告')
    // No live status is not "disconnected": the panel keeps null.
    expect(shapeMcpPanel('claude', { configured: [], runtime: null }).mcp?.runtime).toBeNull()
  })
})
