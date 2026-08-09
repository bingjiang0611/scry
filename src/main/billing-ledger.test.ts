import { describe, expect, it } from 'vitest'
import {
  billingRowsFromAdminPayload,
  billingRowsFromAnthropicGatewayPayload,
  billingRowsFromItems,
  reconcileUsageLedger,
  sdkUsageLedgerRowsFromItems
} from './billing-ledger'
import { AgentRuntimeError, runtimeFailureTrace } from './cli-runtime'
import { DDL_V4, DDL_V5, USAGE_LEDGER_COLS, PROVIDER_RAW_USAGE_COLS, sqlInsert } from './span-ledger'
import type { TraceEvent } from '../shared/trace'
import type { UsageLedgerObject } from '../shared/billing'

type SqliteStmt = { run: (...p: unknown[]) => unknown; get: (...p: unknown[]) => unknown }
type SqliteDb = { prepare: (s: string) => SqliteStmt; close: () => void }
type NodeSqlite = { DatabaseSync: new (p: string) => SqliteDb }

const nodeSqlite = (await import('node:sqlite').catch(() => null)) as NodeSqlite | null
const sqliteIt = nodeSqlite ? it : it.skip

const asLedger = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(USAGE_LEDGER_COLS.map((c, i) => [c, row[i]]))
const asRaw = (row: unknown[]): Record<string, unknown> =>
  Object.fromEntries(PROVIDER_RAW_USAGE_COLS.map((c, i) => [c, row[i]]))
const metadataOf = (row: unknown[]): Record<string, unknown> => JSON.parse(String(asLedger(row).metadata_json))

const resultEvent = (p: Partial<TraceEvent> = {}): TraceEvent =>
  ({
    id: 'res-1',
    ts: '2026-07-02T10:00:00.000Z',
    runId: 'run-1',
    kind: 'harness',
    stage: 'result',
    costUsd: 0.42,
    tokensIn: 1000,
    tokensOut: 200,
    cacheReadTokens: 300,
    cacheCreationTokens: 400,
    modelUsage: [
      {
        model: 'claude-opus-4-1m',
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheCreationTokens: 400,
        costUsd: 0.42,
        contextWindow: 1000000
      }
    ],
    ...p
  }) as TraceEvent

describe('Billing Guardian P1 ledger normalizer', () => {
  sqliteIt('DDL_V4 只新增表且可重复执行', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    for (const stmt of DDL_V4) db.prepare(stmt).run()
    for (const stmt of DDL_V4) db.prepare(stmt).run()
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='provider_raw_usage'`).get()).toBeTruthy()
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_ledger'`).get()).toBeTruthy()
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='budget_events'`).get()).toBeTruthy()
    db.close()
  })

  sqliteIt('DDL_V5 团队治理和企业审计表可重复执行', () => {
    const db = new nodeSqlite!.DatabaseSync(':memory:')
    for (const stmt of DDL_V5) db.prepare(stmt).run()
    for (const stmt of DDL_V5) db.prepare(stmt).run()
    for (const table of [
      'team_labels',
      'gateway_policies',
      'billing_audit_log',
      'billing_retention_policies',
      'contract_prices',
      'chargeback_entries'
    ]) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get()).toBeTruthy()
    }
    db.close()
  })

  it('把 Claude SDK result 派生为 sdk_estimate/direct usage_ledger 行', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-1',
      sessionId: 'sess-1',
      cwd: '/repo',
      items: [resultEvent()],
      nowMs: 1783000000000,
      billingProvider: 'anthropic'
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      source: 'claude_sdk_result',
      sourceKind: 'sdk_estimate',
      sessionId: 'sess-1',
      runId: 'run-1',
      spanId: 'res-1',
      projectKey: '/repo',
      model: 'claude-opus-4-1m',
      cost: 0.42,
      costUnit: 'usd',
      costSource: 'sdk_estimate',
      confidence: 'estimated',
      attributionMethod: 'direct'
    })

    const dbRows = billingRowsFromItems({
      runId: 'run-1',
      sessionId: 'sess-1',
      cwd: '/repo',
      items: [resultEvent()],
      nowMs: 1,
      billingProvider: 'anthropic'
    })
    expect(asLedger(dbRows.usageLedger[0])).toMatchObject({
      provider: 'anthropic',
      source_kind: 'sdk_estimate',
      cost_source: 'sdk_estimate',
      confidence: 'estimated',
      attribution_method: 'direct'
    })
  })

  it('配置三方 Anthropic gateway 时 SDK result 仍标为 sdk_estimate，不伪装官方账单', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-1',
      sessionId: 'sess-1',
      cwd: '/repo',
      items: [resultEvent()],
      nowMs: 1783000000000,
      billingProvider: 'anthropic',
      gateway: { provider: 'anthropic', accountLabel: 'https://gateway.example.com' }
    })
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      source: 'anthropic_gateway_sdk_result',
      sourceKind: 'sdk_estimate',
      accountLabel: 'https://gateway.example.com',
      costSource: 'sdk_estimate',
      confidence: 'estimated'
    })
  })

  it('只有命中本地版本价格表时才估算 API-key model cost', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-priced',
      items: [resultEvent({
        costUsd: undefined,
        billingProvider: 'openai',
        usageSource: 'codex_app_server',
        modelUsage: [{
          model: 'gpt-priced', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300,
          billingProvider: 'openai', usageSource: 'codex_app_server'
        }]
      })],
      nowMs: 1783000000000,
      priceVersions: [{
        id: 'openai:gpt-priced:2026-07-01', provider: 'openai', model: 'gpt-priced', currency: 'USD',
        inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, effectiveFrom: 1782864000000
      }]
    })

    expect(rows[0]).toMatchObject({
      provider: 'openai', cost: 0.00346, costSource: 'price_table', confidence: 'estimated',
      priceVersionId: 'openai:gpt-priced:2026-07-01'
    })
  })

  it('OpenAI 价格表不会把 inclusive input/output 里的 cache write 和 reasoning 重复计价', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-openai-inclusive-priced',
      items: [resultEvent({
        costUsd: undefined,
        billingProvider: 'openai',
        usageSource: 'codex_app_server',
        modelUsage: [{
          model: 'gpt-inclusive',
          inputTokens: 1000,
          outputTokens: 200,
          cacheReadTokens: 300,
          cacheCreationTokens: 200,
          reasoningTokens: 50,
          billingProvider: 'openai',
          usageSource: 'codex_app_server'
        }]
      })],
      nowMs: 1783000000000,
      priceVersions: [{
        id: 'openai:gpt-inclusive:2026-07-01',
        provider: 'openai',
        model: 'gpt-inclusive',
        currency: 'USD',
        inputPerMillion: 2,
        outputPerMillion: 10,
        cacheReadPerMillion: 0.2,
        cacheWritePerMillion: 0.4,
        reasoningPerMillion: 20,
        effectiveFrom: 1782864000000
      }]
    })

    expect(rows[0]).toMatchObject({ cost: 0.00364, costSource: 'price_table' })
  })

  it('Anthropic 价格表不会从独立 input token 中再扣一次 cache read', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-anthropic-priced',
      items: [resultEvent({
        costUsd: undefined,
        billingProvider: 'anthropic',
        modelUsage: [{
          model: 'claude-priced', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300,
          billingProvider: 'anthropic', usageSource: 'claude_sdk_result'
        }]
      })],
      nowMs: 1783000000000,
      priceVersions: [{
        id: 'anthropic:claude-priced:2026-07-01', provider: 'anthropic', model: 'claude-priced', currency: 'USD',
        inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2, effectiveFrom: 1782864000000
      }]
    })

    expect(rows[0]).toMatchObject({
      provider: 'anthropic', cost: 0.00406, costSource: 'price_table', confidence: 'estimated',
      priceVersionId: 'anthropic:claude-priced:2026-07-01'
    })
  })

  it('OpenCode 上游 Anthropic 的 provider event 仍按 provider_reported 归因', () => {
    const rows = sdkUsageLedgerRowsFromItems({
      runId: 'run-opencode',
      items: [
        resultEvent({
          billingProvider: 'anthropic',
          upstreamProvider: 'anthropic',
          usageSource: 'opencode_session'
        })
      ],
      nowMs: 1
    })
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      source: 'opencode_session',
      sourceKind: 'provider_reported',
      costSource: 'provider_reported',
      confidence: 'provider_reported'
    })
  })

  sqliteIt('Qoder 同一账单事件换序后仍使用稳定主键，重同步不重复计费', () => {
    const prefix = { timestamp: 1, userId: 'u1', source: 'CLI', operation: 'Agent', modelTier: 'Ultimate', credits: 0.1, cost: 0.1 }
    const target = { timestamp: 2, userId: 'u1', source: 'CLI', operation: 'Agent', modelTier: 'Ultimate', credits: 0.2, cost: 0.2 }
    const first = billingRowsFromAdminPayload({
      provider: 'qoder', source: 'qoder_teams_usage', payloads: [prefix, target], fetchedAt: 10
    })
    const second = billingRowsFromAdminPayload({
      provider: 'qoder', source: 'qoder_teams_usage', payloads: [target, prefix], fetchedAt: 20
    })

    expect(asRaw(first.providerRawUsage[1]).id).toBe(asRaw(second.providerRawUsage[0]).id)

    const db = new nodeSqlite!.DatabaseSync(':memory:')
    try {
      for (const stmt of DDL_V4) db.prepare(stmt).run()
      const insertRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
      const insertLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
      for (const rows of [first, second]) {
        for (const row of rows.providerRawUsage) insertRaw.run(...row)
        for (const row of rows.usageLedger) insertLedger.run(...row)
      }
      expect(db.prepare('SELECT COUNT(*) n FROM provider_raw_usage').get()).toEqual({ n: 2 })
      const total = db.prepare('SELECT COUNT(*) n, SUM(cost) cost FROM usage_ledger').get() as { n: number; cost: number }
      expect(total.n).toBe(2)
      expect(total.cost).toBeCloseTo(0.3)
    } finally {
      db.close()
    }
  })

  it('Codex/Qoder runtime usage 写独立 billing provider，不把 runtimeProvider 写进 provider', () => {
    const codexRows = billingRowsFromItems({
      runId: 'run-codex',
      sessionId: 'sess-codex',
      cwd: '/repo',
      items: [
        resultEvent({
          id: 'res-codex',
          runId: 'run-codex',
          costUsd: undefined,
          costSource: undefined,
          costConfidence: undefined,
          costUnit: undefined,
          modelUsage: undefined,
          tokensIn: 10,
          tokensOut: 4,
          cacheCreationTokens: 2,
          reasoningTokens: 7,
          runtimeProvider: 'codex_cli',
          runtimeMetadata: {
            usage: { input_tokens: 10, output_tokens: 4 },
            samplePath: '/repo/.local/opendesign-adapter-samples/codex/2026-07-05T00-00-00',
            capabilities: {
              skills: [{ id: 'design-skill', order: 0, bodyDigest: 'skill-digest' }],
              mcpServers: [{ id: 'plain', order: 0, digest: 'mcp-digest' }],
              capabilityFailures: [{ kind: 'mcp', name: 'needsEnv', reason: 'unsupported Codex MCP config' }]
            },
            brief: { stage: 'capability', evidencePath: '/repo/.local/opendesign-adapter-samples/codex/2026-07-05T00-00-00' }
          }
        })
      ],
      nowMs: 1,
      billingProvider: 'codex',
      runtimeProvider: 'codex_cli'
    })
    const codexLedger = asLedger(codexRows.usageLedger[0])
    expect(codexLedger).toMatchObject({
      provider: 'codex',
      source: 'codex_cli_result',
      source_kind: 'provider_reported',
      cost: null,
      cost_source: 'provider_reported',
      confidence: 'provider_reported',
      cache_write_tokens: 2,
      reasoning_tokens: 7
    })
    expect(codexLedger.provider).not.toBe('codex_cli')
    expect(metadataOf(codexRows.usageLedger[0])).toMatchObject({
      runtimeProvider: 'codex_cli',
      rawUsage: { input_tokens: 10, output_tokens: 4 },
      samplePath: '/repo/.local/opendesign-adapter-samples/codex/2026-07-05T00-00-00',
      capabilities: {
        skills: [expect.objectContaining({ id: 'design-skill', order: 0, bodyDigest: 'skill-digest' })],
        mcpServers: [expect.objectContaining({ id: 'plain', order: 0, digest: 'mcp-digest' })],
        capabilityFailures: [expect.objectContaining({ kind: 'mcp', name: 'needsEnv' })]
      },
      failureBrief: expect.objectContaining({ stage: 'capability' })
    })

    const qoderRows = billingRowsFromItems({
      runId: 'run-qoder',
      items: [
        resultEvent({
          id: 'res-qoder',
          runId: 'run-qoder',
          runtimeProvider: 'qoder_cli',
          runtimeMetadata: {
            usage: { input_tokens: 8, output_tokens: 2 },
            observedMcpServers: [{ name: 'dry_alpha', status: 'disconnected' }],
            capabilityWarnings: [
              {
                kind: 'mcp',
                runtimeProvider: 'qoder_cli',
                name: 'dry_alpha',
                reason: 'runtime reported MCP server disconnected',
                expected: 'connected',
                observed: 'disconnected',
                evidence: 'runtime:init.mcp_servers'
              }
            ]
          }
        })
      ],
      nowMs: 1,
      billingProvider: 'qoder',
      runtimeProvider: 'qoder_cli'
    })
    expect(asLedger(qoderRows.usageLedger[0])).toMatchObject({
      provider: 'qoder',
      source: 'qoder_cli_result',
      source_kind: 'provider_reported'
    })
    expect(asLedger(qoderRows.usageLedger[0]).provider).not.toBe('qoder_cli')
    expect(metadataOf(qoderRows.usageLedger[0])).toMatchObject({
      runtimeProvider: 'qoder_cli',
      rawUsage: { input_tokens: 8, output_tokens: 2 },
      observedMcpServers: [expect.objectContaining({ name: 'dry_alpha', status: 'disconnected' })],
      capabilityWarnings: [
        expect.objectContaining({
          kind: 'mcp',
          runtimeProvider: 'qoder_cli',
          name: 'dry_alpha',
          observed: 'disconnected',
          evidence: 'runtime:init.mcp_servers'
        })
      ]
    })
  })

  it('CLI runtime failure result 也写 canonical provider 和 failure brief，不把 runtimeProvider 写进 provider', () => {
    const failure = runtimeFailureTrace(
      'run-qoder-fail',
      new AgentRuntimeError('qoder spawn denied', {
        provider: 'qoder_cli',
        stage: 'spawn',
        cwd: '/repo',
        commandSummary: 'qodercli -p --output-format stream-json',
        evidencePath: '/repo/.local/opendesign-adapter-samples/qoder/2026-07-05T00-00-00',
        nextAction: '检查可执行权限、cwd 是否存在、以及 GUI 环境 PATH'
      })
    )
    const rows = billingRowsFromItems({
      runId: 'run-qoder-fail',
      sessionId: 'sess-qoder-fail',
      cwd: '/repo',
      items: [failure],
      nowMs: 1,
      billingProvider: 'qoder',
      runtimeProvider: 'qoder_cli'
    })
    const ledger = asLedger(rows.usageLedger[0])
    expect(ledger).toMatchObject({
      provider: 'qoder',
      source: 'qoder_cli_result',
      source_kind: 'provider_reported',
      input_tokens: null,
      output_tokens: null,
      cost: null
    })
    expect(ledger.provider).not.toBe('qoder_cli')
    expect(metadataOf(rows.usageLedger[0])).toMatchObject({
      runtimeProvider: 'qoder_cli',
      failureBrief: expect.objectContaining({
        provider: 'qoder_cli',
        stage: 'spawn',
        evidencePath: '/repo/.local/opendesign-adapter-samples/qoder/2026-07-05T00-00-00'
      })
    })
  })

  it('Codex version_probe failure 持久化为 codex provider ledger row 并保留 probe evidencePath', () => {
    const failure = runtimeFailureTrace(
      'run-codex-probe-fail',
      new AgentRuntimeError('codex --version exited with 137', {
        provider: 'codex_cli',
        stage: 'version_probe',
        cwd: '/repo',
        commandSummary: 'codex --version && codex exec --help',
        evidencePath: '/repo/.local/opendesign-adapter-samples/codex/2026-07-05T00-00-00',
        nextAction: '运行 --version/--help，确认 CLI flag surface 与 adapter 匹配'
      })
    )
    const rows = billingRowsFromItems({
      runId: 'run-codex-probe-fail',
      sessionId: 'sess-codex-probe-fail',
      cwd: '/repo',
      items: [failure],
      nowMs: 1,
      billingProvider: 'codex',
      runtimeProvider: 'codex_cli'
    })
    const ledger = asLedger(rows.usageLedger[0])
    expect(ledger).toMatchObject({
      provider: 'codex',
      source: 'codex_cli_result',
      source_kind: 'provider_reported',
      input_tokens: null,
      output_tokens: null,
      cost: null
    })
    expect(ledger.provider).not.toBe('codex_cli')
    expect(metadataOf(rows.usageLedger[0])).toMatchObject({
      runtimeProvider: 'codex_cli',
      failureBrief: expect.objectContaining({
        provider: 'codex_cli',
        stage: 'version_probe',
        evidencePath: '/repo/.local/opendesign-adapter-samples/codex/2026-07-05T00-00-00'
      })
    })
  })

  it('把三方 Anthropic-compatible gateway response 标为 gateway_reported/provider_reported confidence', () => {
    const rows = billingRowsFromAnthropicGatewayPayload({
      fetchedAt: 1783000000000,
      accountLabel: 'fixture-gateway',
      payloads: [
        {
          id: 'msg-1',
          created_at: '2026-07-02T10:00:00.000Z',
          model: 'claude-opus-4-8',
          session_id: 'sess-1',
          run_id: 'run-1',
          usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 5,
            cost_usd: 0.012,
            currency: 'USD'
          }
        }
      ]
    })
    expect(asRaw(rows.providerRawUsage[0])).toMatchObject({
      provider: 'anthropic',
      source: 'anthropic_gateway_response',
      source_kind: 'gateway_reported',
      account_label: 'fixture-gateway'
    })
    expect(asLedger(rows.usageLedger[0])).toMatchObject({
      provider: 'anthropic',
      source: 'anthropic_gateway_response',
      source_kind: 'gateway_reported',
      session_id: 'sess-1',
      run_id: 'run-1',
      model: 'claude-opus-4-8',
      input_tokens: 120,
      output_tokens: 30,
      cache_read_tokens: 40,
      cache_write_tokens: 5,
      cost: 0.012,
      cost_source: 'gateway_reported',
      confidence: 'provider_reported',
      attribution_method: 'direct'
    })
  })

  it('gateway raw payload 脱敏且稳定 id 支持重复导入覆盖', () => {
    const payload = {
      id: 'msg-stable',
      created_at: '2026-07-02T10:00:00.000Z',
      model: 'claude-opus-4-8',
      headers: { authorization: `Bearer ${'abcdefghijklmnopqrstuvwxyz012345'}` },
      token: `sk-ant-admin01-${'abcdefghijklmnopqrstuvwxyz0123456789'}`,
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.001, currency: 'USD' }
    }
    const first = billingRowsFromAnthropicGatewayPayload({ fetchedAt: 1, payloads: [payload] })
    const second = billingRowsFromAnthropicGatewayPayload({ fetchedAt: 2, payloads: [payload] })
    expect(asRaw(first.providerRawUsage[0]).id).toBe(asRaw(second.providerRawUsage[0]).id)
    const rawJson = String(asRaw(first.providerRawUsage[0]).payload_json)
    expect(rawJson).toContain('«REDACTED»')
    expect(rawJson).not.toContain('abcdefghijklmnopqrstuvwxyz012345')
    expect(asRaw(first.providerRawUsage[0]).storage_mode).toBe('aggregate')
  })

  it('把 OpenAI Admin usage/cost payload 分别标为 official_telemetry/provider_bill', () => {
    const usage = {
      start_time: 1782864000,
      end_time: 1782950400,
      model: 'gpt-5',
      input_tokens: 100,
      input_cached_tokens: 20,
      output_tokens: 30,
      output_reasoning_tokens: 4,
      num_model_requests: 2
    }
    const cost = {
      start_time: '2026-07-01T00:00:00Z',
      end_time: '2026-07-02T00:00:00Z',
      amount: { value: 1.25, currency: 'usd' },
      line_item: 'Completions'
    }
    const usageRows = billingRowsFromAdminPayload({
      provider: 'openai',
      source: 'openai_admin_usage',
      payloads: [usage],
      fetchedAt: 1783000000000
    })
    const costRows = billingRowsFromAdminPayload({
      provider: 'openai',
      source: 'openai_admin_cost',
      payloads: [cost],
      fetchedAt: 1783000000000
    })
    expect(asRaw(usageRows.providerRawUsage[0])).toMatchObject({ provider: 'openai', source_kind: 'official_telemetry' })
    expect(asLedger(usageRows.usageLedger[0])).toMatchObject({
      source: 'openai_admin_usage',
      source_kind: 'official_telemetry',
      bucket_start: 1782864000000,
      bucket_end: 1782950400000,
      input_tokens: 100,
      cache_read_tokens: 20,
      cost_source: 'official_telemetry',
      confidence: 'exact'
    })
    expect(asLedger(costRows.usageLedger[0])).toMatchObject({
      source: 'openai_admin_cost',
      source_kind: 'provider_bill',
      cost: 1.25,
      currency: 'usd',
      cost_source: 'provider_bill',
      confidence: 'exact'
    })
  })

  it('reconciliation 并排展示 SDK estimate 与官方 bill，不把 session 级差异伪装成精确归因', () => {
    const rows: UsageLedgerObject[] = [
      {
        id: 'sdk',
        provider: 'openai',
        source: 'local_adapter',
        sourceKind: 'sdk_estimate',
        usageKind: 'result',
        cost: 1,
        costUnit: 'usd',
        costSource: 'sdk_estimate',
        confidence: 'estimated',
        attributionMethod: 'direct'
      },
      {
        id: 'bill',
        provider: 'openai',
        source: 'openai_admin_cost',
        sourceKind: 'provider_bill',
        usageKind: 'organization_cost',
        cost: 1.4,
        costUnit: 'usd',
        costSource: 'provider_bill',
        confidence: 'exact',
        attributionMethod: 'unattributed'
      }
    ]
    expect(reconcileUsageLedger(rows)[0]).toMatchObject({
      provider: 'openai',
      costUnit: 'usd',
      sdkEstimate: 1,
      officialBill: 1.4,
      deltaOfficialVsSdk: 0.3999999999999999,
      confidence: 'exact'
    })
    expect(reconcileUsageLedger(rows)[0].note).toContain('session 级归因仍为 inferred')
  })

  it('reconciliation 展示 gateway/provider reported，但 official bill 保持 unavailable', () => {
    const rows: UsageLedgerObject[] = [
      {
        id: 'sdk',
        provider: 'anthropic',
        source: 'anthropic_gateway_sdk_result',
        sourceKind: 'sdk_estimate',
        usageKind: 'result',
        cost: 0.1,
        costUnit: 'usd',
        costSource: 'sdk_estimate',
        confidence: 'estimated',
        attributionMethod: 'direct'
      },
      {
        id: 'gateway',
        provider: 'anthropic',
        source: 'anthropic_gateway_response',
        sourceKind: 'gateway_reported',
        usageKind: 'messages_response',
        cost: 0.12,
        costUnit: 'usd',
        costSource: 'gateway_reported',
        confidence: 'provider_reported',
        attributionMethod: 'direct'
      }
    ]
    expect(reconcileUsageLedger(rows)[0]).toMatchObject({
      provider: 'anthropic',
      sdkEstimate: 0.1,
      providerReported: 0.12,
      officialBill: 0,
      deltaOfficialVsSdk: null,
      confidence: 'provider_reported'
    })
    expect(reconcileUsageLedger(rows)[0].note).toContain('official bill unavailable')
  })

  it('does not turn token-only rows with unknown cost into a zero-cost reconciliation', () => {
    expect(reconcileUsageLedger([
      {
        id: 'tokens-only', provider: 'qoder', source: 'qoder_sdk', sourceKind: 'sdk_estimate', usageKind: 'result',
        inputTokens: 100, cost: null, costUnit: 'usd', costSource: 'sdk_estimate', confidence: 'estimated', attributionMethod: 'direct'
      },
      {
        id: 'legacy-zero', provider: 'qoder', source: 'qoder_cli_result', sourceKind: 'provider_reported', usageKind: 'result',
        inputTokens: 100, cost: 0, costUnit: 'usd', costSource: 'provider_reported', confidence: 'provider_reported', attributionMethod: 'direct'
      }
    ])).toEqual([])
  })
})
