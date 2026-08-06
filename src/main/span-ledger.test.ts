import { describe, it, expect } from 'vitest'
import { ANALYTICS_RESULTS_SQL, buildAnalyticsStats, canonicalCostWhere, canonicalUsdCostWhere, DDL_V1, DDL_V2, DDL_V3, DDL_V4, DDL_V6, DDL_V7, DDL_V8, HUMAN_INTERVENTION_COLS, INTERVENTION_STATS_SQL, MODEL_USAGE_COLS, nearestRank, spanRowsFromItems, SPAN_COLS, sqlInsert, TOTALS_SQL, UPSERT_SESSION_REF_SQL, USAGE_LEDGER_COLS } from './span-ledger'
import { usageLedgerObjectToRow } from './billing-ledger'
import type { TraceEvent } from '../shared/trace'
import type { UsageLedgerObject } from '../shared/billing'

type SqliteStmt = {
  run: (...p: unknown[]) => unknown
  get: (...p: unknown[]) => unknown
  all: (...p: unknown[]) => unknown
}
type SqliteDb = { prepare: (s: string) => SqliteStmt; close: () => void }
type NodeSqlite = { DatabaseSync: new (p: string) => SqliteDb }

const nodeSqlite = (await import('node:sqlite').catch(() => null)) as NodeSqlite | null
const sqliteIt = nodeSqlite ? it : it.skip

// 把位置行映射回字段名，断言更可读
const asSpan = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(SPAN_COLS.map((c, i) => [c, row[i]]))
const asMu = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(MODEL_USAGE_COLS.map((c, i) => [c, row[i]]))
const asIntervention = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(HUMAN_INTERVENTION_COLS.map((c, i) => [c, row[i]]))

const ev = (p: Partial<TraceEvent>): TraceEvent =>
  ({ id: 'x', ts: '2026-06-26T00:00:00.000Z', runId: 'run-1', kind: 'tool', stage: 'tool:X', ...p }) as TraceEvent

describe('spanRowsFromItems（P0 行映射）', () => {
  it('tool_result 按 tool_use_id 合并进 tool span（output/is_error 回填，不插新行）', () => {
    const items = [
      ev({ id: 's1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', input: { command: 'ls' } }),
      ev({ id: 'r1', kind: 'tool', stage: 'tool_result', toolUseId: 'tu1', text: 'file output', isError: false })
    ]
    const { spans } = spanRowsFromItems({ runId: 'run-1', sessionId: 'sess', cwd: '/p', items, nowMs: 1 })
    expect(spans).toHaveLength(1) // tool_result 不单独成行
    const s = asSpan(spans[0])
    expect(s).toMatchObject({
      id: 's1',
      kind: 'tool',
      tool: 'Bash',
      tool_use_id: 'tu1',
      is_error: 0,
      output_preview: 'file output',
      cwd: '/p'
    })
    expect(String(s.input_preview)).toContain('ls')
  })

  it('tool_result is_error=true 回填到 tool span', () => {
    const items = [
      ev({ id: 's1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1' }),
      ev({ id: 'r1', kind: 'tool', stage: 'tool_result', toolUseId: 'tu1', text: 'boom', isError: true })
    ]
    const { spans } = spanRowsFromItems({ runId: 'run-1', items, nowMs: 1 })
    expect(asSpan(spans[0]).is_error).toBe(1)
  })

  it('result → result span + model_usage 展开（cost/token/cache/api）', () => {
    const items = [
      ev({
        id: 'res',
        kind: 'harness',
        stage: 'result',
        costUsd: 0.88,
        tokensIn: 30054,
        tokensOut: 381,
        cacheReadTokens: 66665,
        cacheCreationTokens: 110635,
        durationApiMs: 21900,
        modelUsage: [
          { model: 'claude-opus-4-8[1m]', inputTokens: 30054, outputTokens: 381, cacheReadTokens: 66665, cacheCreationTokens: 110635, costUsd: 0.88, contextWindow: 1000000 }
        ]
      })
    ]
    const { spans, modelUsage } = spanRowsFromItems({ runId: 'run-1', cwd: '/p', items, nowMs: 1 })
    const s = asSpan(spans[0])
    expect(s).toMatchObject({
      kind: 'harness',
      stage: 'result',
      cost_usd: 0.88,
      tokens_in: 30054,
      tokens_out: 381,
      cache_read_tokens: 66665,
      cache_creation_tokens: 110635,
      duration_api_ms: 21900,
      model: 'claude-opus-4-8[1m]'
    })
    expect(modelUsage).toHaveLength(1)
    expect(asMu(modelUsage[0])).toMatchObject({
      span_id: 'res',
      model: 'claude-opus-4-8[1m]',
      input_tokens: 30054,
      cache_creation_tokens: 110635,
      context_window: 1000000
    })
  })

  it('Read/Write 投影 file_ops（source=tool-input, confidence=exact）', () => {
    const items = [ev({ id: 's1', kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/a/b.ts' })]
    const { fileOps } = spanRowsFromItems({ runId: 'run-1', sessionId: 'sess', items, nowMs: 1 })
    expect(fileOps).toHaveLength(1)
    // [span_id, session_id, op, path, source, confidence, ...]
    expect(fileOps[0].slice(0, 6)).toEqual(['s1', 'sess', 'read', '/a/b.ts', 'tool-input', 'exact'])
  })

  it('input/output 落库前 mask 密钥', () => {
    const fakeGithubPat = ['gh', 'p_', '0123456789abcdefghij0123456789abcdef'].join('')
    const items = [
      ev({ id: 's1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1', input: { command: 'export K=sk-ant-api03-abcdefGHIJKLmnop1234567890' } }),
      ev({ id: 'r1', kind: 'tool', stage: 'tool_result', toolUseId: 'tu1', text: `token ${fakeGithubPat}` })
    ]
    const s = asSpan(spanRowsFromItems({ runId: 'run-1', items, nowMs: 1 }).spans[0])
    expect(String(s.input_preview)).toContain('«REDACTED»')
    expect(String(s.input_preview)).not.toContain('sk-ant-api03')
    expect(String(s.output_preview)).toContain('«REDACTED»')
  })

  it('model text/thinking、text_delta、tool_result 不落 span（P0 只存 tool/skill/agent + result）', () => {
    const items = [
      ev({ kind: 'model', stage: 'text', text: 'hi' }),
      ev({ kind: 'model', stage: 'thinking', thinking: 'hmm' }),
      ev({ kind: 'model', stage: 'text_delta', text: 'h' }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'z' })
    ]
    expect(spanRowsFromItems({ runId: 'run-1', items, nowMs: 1 }).spans).toHaveLength(0)
  })

  it('skill / agent 也落 span', () => {
    const items = [
      ev({ id: 'sk', kind: 'skill', stage: 'skill:foo', name: 'foo', tool: 'Skill' }),
      ev({ id: 'ag', kind: 'agent', stage: 'agent:Explore', name: 'Explore', tool: 'Agent' })
    ]
    const kinds = spanRowsFromItems({ runId: 'run-1', items, nowMs: 1 }).spans.map((r) => asSpan(r).kind)
    expect(kinds).toEqual(['skill', 'agent'])
  })

  it('人工选择完整落 human_interventions，并对 SQLite JSON 副本脱敏', () => {
    const items = [ev({
      id: 'human-1',
      kind: 'human',
      stage: 'intervention',
      providerId: 'codex',
      intervention: {
        kind: 'clarification',
        source: 'codex:item/tool/requestUserInput',
        resolution: 'answered',
        request: {
          runId: 'run-1',
          questionId: 'question-1',
          providerId: 'codex',
          questions: [{
            header: '密钥',
            question: '使用哪个值？',
            multiSelect: false,
            options: [{ label: '现有', description: '继续' }, { label: '新建', description: '替换' }]
          }]
        },
        response: {
          runId: 'run-1',
          questionId: 'question-1',
          behavior: 'answered',
          answers: { '使用哪个值？': 'sk-ant-api03-abcdefGHIJKLmnop1234567890' }
        },
        openedAt: '2026-08-06T00:00:00.000Z',
        closedAt: '2026-08-06T00:00:01.500Z',
        durationMs: 1500
      }
    })]

    const rows = spanRowsFromItems({ runId: 'run-1', sessionId: 'session-1', items, nowMs: 1 })
    expect(rows.spans).toHaveLength(0)
    expect(asIntervention(rows.interventions[0])).toMatchObject({
      id: 'human-1',
      session_id: 'session-1',
      run_id: 'run-1',
      provider_id: 'codex',
      question_id: 'question-1',
      kind: 'clarification',
      source: 'codex:item/tool/requestUserInput',
      resolution: 'answered',
      question_count: 1,
      duration_ms: 1500
    })
    expect(String(asIntervention(rows.interventions[0]).response_json)).toContain('«REDACTED»')
  })
})

describe('Analytics v7（四 Provider 口径 + 窗口聚合）', () => {
  const now = new Date(2026, 6, 22, 12).getTime()
  const daysAgo = (days: number): number => new Date(2026, 6, 22 - days, 10).getTime()

  it('按 Provider 分母计算 cache reuse，不给 OpenCode/Qoder 制造比例', () => {
    const stats = buildAnalyticsStats({
      nowMs: now,
      results: [
        { tsStart: daysAgo(0), providerId: 'claude', inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 20 },
        { tsStart: daysAgo(0), providerId: 'codex', inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: null },
        { tsStart: daysAgo(0), providerId: 'opencode', inputTokens: 50, outputTokens: 10, cacheReadTokens: 25, cacheWriteTokens: 5 },
        { tsStart: daysAgo(0), providerId: 'qoder', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null }
      ],
      tools: [], dangers: [], mcp: []
    })
    const cache = Object.fromEntries(stats.cacheReuse!.map((row) => [row.providerId, row]))
    expect(cache.claude).toMatchObject({ denominator: 'separate_input', comparableTurns: 1, reuseRate: 0.4 })
    expect(cache.codex).toMatchObject({ denominator: 'input_includes_cache', comparableTurns: 1, reuseRate: 0.3 })
    expect(cache.opencode).toMatchObject({ denominator: 'upstream_dependent', comparableTurns: 0, reuseRate: null, cacheReadTokens: 25 })
    expect(cache.qoder).toMatchObject({ denominator: 'unknown', comparableTurns: 0, reuseRate: null, inputTokens: null })
  })

  it('按本地日补齐 30/90 天并保留字段级 coverage、环比和 danger 能力边界', () => {
    const stats = buildAnalyticsStats({
      nowMs: now,
      results: [
        { tsStart: daysAgo(0), providerId: 'claude', inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 20 },
        { tsStart: daysAgo(0), providerId: 'qoder', inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
        { tsStart: daysAgo(30), providerId: 'claude', inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
      ],
      tools: [{ tsStart: daysAgo(0) }, { tsStart: daysAgo(30) }],
      dangers: [{ tsStart: daysAgo(0), level: 'danger' }, { tsStart: daysAgo(1), level: 'warn' }],
      mcp: []
    })
    expect(stats.tokenDaily).toHaveLength(30)
    expect(stats.dangerDaily).toHaveLength(90)
    expect(stats.tokenDaily!.at(-1)).toMatchObject({ turns: 2, input: 100, output: 20, inputKnownTurns: 1, outputKnownTurns: 1 })
    expect(stats.comparison).toMatchObject({
      current: { tokens: 120, tokenKnownTurns: 1, turns: 2, toolCalls: 1, danger: 1 },
      previous: { tokens: 60, tokenKnownTurns: 1, turns: 1, toolCalls: 1, danger: 0 },
      change: { tokensPct: null, turnsPct: 100, toolCallsPct: 0, dangerPct: null }
    })
    const coverage = Object.fromEntries(stats.providerCoverage!.map((row) => [row.providerId, row]))
    expect(coverage.claude).toMatchObject({ turns: 1, inputKnownTurns: 1, dangerCoverage: 'classified' })
    expect(coverage.qoder).toMatchObject({ turns: 1, inputKnownTurns: 0, dangerCoverage: 'classified' })
    expect(coverage.codex.dangerCoverage).toBe('unsupported')
    expect(coverage.opencode.dangerCoverage).toBe('unsupported')
  })

  it('nearest-rank P50/P95 只使用完成的 MCP duration 样本', () => {
    expect(nearestRank([40, 10, 30, 20], 0.5)).toBe(20)
    expect(nearestRank([40, 10, 30, 20], 0.95)).toBe(40)
    expect(nearestRank([], 0.5)).toBeNull()
    const stats = buildAnalyticsStats({
      nowMs: now, results: [], tools: [], dangers: [],
      mcp: [10, 20, 30, 40].map((durationMs, index) => ({ server: 'docs', durationMs, isError: index === 3 ? 1 : 0 }))
    })
    expect(stats.mcpLatency).toEqual([{ server: 'docs', calls: 4, p50Ms: 20, p95Ms: 40, errors: 1 }])
  })

  it('只有前后窗口 Token coverage 都完整时才给环比', () => {
    const complete = buildAnalyticsStats({
      nowMs: now,
      results: [
        { tsStart: daysAgo(0), providerId: 'codex', inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: null },
        { tsStart: daysAgo(30), providerId: 'codex', inputTokens: 50, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: null }
      ],
      tools: [], dangers: [], mcp: []
    })
    expect(complete.comparison?.change.tokensPct).toBe(100)
  })

  sqliteIt('session_refs 首轮 preview 稳定，续跑只刷新时间', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of [...DDL_V1, ...DDL_V2, ...DDL_V3, ...DDL_V6, ...DDL_V7]) db.prepare(stmt).run()
      const upsert = db.prepare(UPSERT_SESSION_REF_SQL)
      upsert.run('s1', 'codex', 'codex_cli', '/repo', 'external', 'first prompt', 1, 1)
      upsert.run('s1', 'codex', 'codex_cli', '/repo', 'external', 'resume prompt', 2, 2)

      expect(db.prepare('SELECT preview, created_ts createdAt, updated_ts updatedAt FROM session_refs').get()).toEqual({
        preview: 'first prompt',
        createdAt: 1,
        updatedAt: 2
      })
    } finally {
      db.close()
    }
  })

  sqliteIt('人工介入统计排除 Provider 自动取消，并分开澄清与权限', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of DDL_V8) db.prepare(stmt).run()
      const insert = db.prepare(sqlInsert('human_interventions', HUMAN_INTERVENTION_COLS))
      const row = (id: string, kind: string, resolution: string, questions: number, duration: number) => [
        id, 'session-1', `run-${id}`, 'codex', null, `question-${id}`, kind, 'codex:test', resolution,
        questions, '{}', '{}', 1, 1 + duration, duration
      ]
      insert.run(...row('answered', 'clarification', 'answered', 2, 1000))
      insert.run(...row('cancelled', 'permission', 'user_cancelled', 1, 500))
      insert.run(...row('provider', 'permission', 'provider_cancelled', 3, 250))

      expect(db.prepare(INTERVENTION_STATS_SQL).get()).toEqual({
        requested: 3,
        total: 2,
        answered: 1,
        cancelled: 1,
        questions: 3,
        clarification: 1,
        permission: 1,
        waitMs: 1500
      })
    } finally {
      db.close()
    }
  })

  sqliteIt('v7 索引与 session_refs join 保留四 Provider 身份和 NULL', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of [...DDL_V1, ...DDL_V2, ...DDL_V3, ...DDL_V6, ...DDL_V7]) db.prepare(stmt).run()
      const insertSpan = db.prepare(sqlInsert('spans', SPAN_COLS))
      const insertRef = db.prepare(`INSERT INTO session_refs (
        scry_session_id, provider_id, runtime_provider, cwd, external_session_id, preview, created_ts, updated_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const [index, providerId] of (['claude', 'codex', 'qoder', 'opencode'] as const).entries()) {
        const sessionId = `session-${providerId}`
        insertRef.run(sessionId, providerId, `${providerId}-runtime`, '/repo', `external-${providerId}`, '', 1, 1)
        const row = spanRowsFromItems({
          runId: `run-${providerId}`,
          sessionId,
          cwd: '/repo',
          nowMs: index + 1,
          items: [ev({
            id: `result-${providerId}`,
            runId: `run-${providerId}`,
            ts: new Date(index + 1).toISOString(),
            kind: 'harness',
            stage: 'result',
            tokensIn: providerId === 'qoder' ? undefined : 10,
            tokensOut: providerId === 'qoder' ? undefined : 2,
            cacheReadTokens: providerId === 'qoder' ? undefined : 1
          })]
        }).spans[0]
        insertSpan.run(...row)
      }
      const rows = db.prepare(ANALYTICS_RESULTS_SQL).all(0, 10) as Array<{ providerId: string; inputTokens: number | null }>
      expect(rows.map((row) => row.providerId)).toHaveLength(4)
      expect(rows.map((row) => row.providerId)).toEqual(expect.arrayContaining(['claude', 'codex', 'qoder', 'opencode']))
      expect(rows.find((row) => row.providerId === 'qoder')?.inputTokens).toBeNull()
      expect(db.prepare(TOTALS_SQL).all()).toEqual([{ cost: null, tin: 30, tout: 6, turns: 4, toolCalls: 0, dangerEvents: 0 }])
    } finally {
      db.close()
    }
  })
})

describe('canonicalCostWhere（账单 canonical cost 优先级）', () => {
  const ledger = (p: Partial<UsageLedgerObject> & Pick<UsageLedgerObject, 'id' | 'provider' | 'costSource'>): UsageLedgerObject => ({
    source: `${p.provider}_source`,
    sourceKind: 'provider_reported',
    usageKind: 'result',
    costUnit: 'usd',
    confidence: p.costSource === 'provider_bill' ? 'exact' : 'provider_reported',
    attributionMethod: 'direct',
    createdTs: 1,
    ...p
  })

  sqliteIt('codex/qoder provider_reported 成本参与 canonical rollup，null cost 不参与，provider_bill 覆盖 provider_reported', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of DDL_V4) db.prepare(stmt).run()
      const insert = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
      for (const row of [
        ledger({ id: 'codex-priced', provider: 'codex', costSource: 'provider_reported', cost: 0.12 }),
        ledger({ id: 'codex-null', provider: 'codex', costSource: 'provider_reported', cost: null }),
        ledger({ id: 'qoder-provider', provider: 'qoder', costSource: 'provider_reported', cost: 0.2 }),
        ledger({ id: 'qoder-bill', provider: 'qoder', sourceKind: 'provider_bill', costSource: 'provider_bill', cost: 0.3 }),
        ledger({ id: 'qoder-credits', provider: 'qoder', sourceKind: 'provider_bill', costSource: 'provider_bill', cost: 2, costUnit: 'credits' })
      ]) {
        insert.run(...usageLedgerObjectToRow(row))
      }

      const rows = db
        .prepare(`SELECT id, provider, cost_source costSource, cost FROM usage_ledger WHERE ${canonicalCostWhere()} ORDER BY provider, cost_source, id`)
        .all() as Array<{ id: string; provider: string; costSource: string; cost: number }>
      expect(rows).toEqual([
        { id: 'codex-priced', provider: 'codex', costSource: 'provider_reported', cost: 0.12 },
        { id: 'qoder-bill', provider: 'qoder', costSource: 'provider_bill', cost: 0.3 },
        { id: 'qoder-credits', provider: 'qoder', costSource: 'provider_bill', cost: 2 }
      ])
    } finally {
      db.close()
    }
  })

  sqliteIt('美元汇总不会把 Qoder Credits 当作美元相加', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of DDL_V4) db.prepare(stmt).run()
      const insert = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
      for (const row of [
        ledger({ id: 'usd', provider: 'openai', costSource: 'provider_bill', cost: 1, costUnit: 'usd' }),
        ledger({ id: 'credits', provider: 'qoder', costSource: 'provider_bill', cost: 100, costUnit: 'credits' })
      ]) {
        insert.run(...usageLedgerObjectToRow(row))
      }

      const result = db
        .prepare(`SELECT COUNT(*) n, SUM(cost) cost FROM usage_ledger WHERE ${canonicalUsdCostWhere()}`)
        .all() as Array<{ n: number; cost: number }>
      expect(result).toEqual([{ n: 1, cost: 1 }])
    } finally {
      db.close()
    }
  })
})
