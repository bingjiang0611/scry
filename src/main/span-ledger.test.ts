import { describe, it, expect } from 'vitest'
import { canonicalCostWhere, canonicalUsdCostWhere, DDL_V4, MODEL_USAGE_COLS, spanRowsFromItems, SPAN_COLS, sqlInsert, USAGE_LEDGER_COLS } from './span-ledger'
import { usageLedgerObjectToRow } from './billing-ledger'
import type { TraceEvent } from '../shared/trace'
import type { UsageLedgerObject } from '../shared/billing'

type SqliteStmt = { run: (...p: unknown[]) => unknown; all: (...p: unknown[]) => unknown }
type SqliteDb = { prepare: (s: string) => SqliteStmt; close: () => void }
type NodeSqlite = { DatabaseSync: new (p: string) => SqliteDb }

const nodeSqlite = (await import('node:sqlite').catch(() => null)) as NodeSqlite | null
const sqliteIt = nodeSqlite ? it : it.skip

// 把位置行映射回字段名，断言更可读
const asSpan = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(SPAN_COLS.map((c, i) => [c, row[i]]))
const asMu = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(MODEL_USAGE_COLS.map((c, i) => [c, row[i]]))

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
