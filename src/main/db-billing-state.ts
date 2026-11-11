import { adminKeyStatus } from './billing-admin'
import { canonicalUsdCostWhere } from './span-ledger'
import { reconcileUsageLedger } from './billing-ledger'
import type { BillingGuardianState, BillingProvider, UsageLedgerObject } from '../shared/billing'
import { billingEnvProvider, billingStateCache, dataRevision, db, gatewayAccountLabel, setBillingStateCache } from './db-state'

function envConnections(state: {
  lastOpenAiSync?: number
  lastAnthropicSync?: number
  lastOpenAiError?: string
  lastAnthropicError?: string
  lastQoderSync?: number
  lastQoderError?: string
} = {}): BillingGuardianState['adminConnections'] {
  const keys = adminKeyStatus(billingEnvProvider())
  return [
    {
      provider: 'anthropic',
      envVar: 'ANTHROPIC_ADMIN_API_KEY',
      configured: keys.anthropic,
      status: state.lastAnthropicError ? 'last_sync_error' : state.lastAnthropicSync ? 'last_sync_ok' : keys.anthropic ? 'ready' : 'missing_key',
      lastSyncTs: state.lastAnthropicSync,
      lastError: state.lastAnthropicError
    },
    {
      provider: 'openai',
      envVar: 'OPENAI_ADMIN_API_KEY',
      configured: keys.openai,
      status: state.lastOpenAiError ? 'last_sync_error' : state.lastOpenAiSync ? 'last_sync_ok' : keys.openai ? 'ready' : 'missing_key',
      lastSyncTs: state.lastOpenAiSync,
      lastError: state.lastOpenAiError
    },
    {
      provider: 'qoder',
      envVar: 'QODER_ADMIN_API_KEY + QODER_ORGANIZATION_ID',
      configured: keys.qoder,
      status: state.lastQoderError ? 'last_sync_error' : state.lastQoderSync ? 'last_sync_ok' : keys.qoder ? 'ready' : 'missing_key',
      lastSyncTs: state.lastQoderSync,
      lastError: state.lastQoderError
    }
  ]
}

function gatewayConnections(env: NodeJS.ProcessEnv = billingEnvProvider()): BillingGuardianState['gatewayConnections'] {
  const accountLabel = gatewayAccountLabel(env)
  return [
    {
      provider: 'anthropic',
      label: accountLabel ?? 'Anthropic-compatible gateway',
      baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
      tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
      configured: !!accountLabel,
      status: accountLabel ? 'ready' : 'missing_config',
      sourceKind: 'gateway_reported',
      note: accountLabel
        ? '三方网关已配置；SDK usage 可观测，官方账单仍为 unavailable'
        : '配置 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN 后启用三方网关观测'
    }
  ]
}

function usageLedgerObjectFromDb(row: Record<string, unknown>): UsageLedgerObject {
  return {
    id: String(row.id),
    provider: row.provider as UsageLedgerObject['provider'],
    source: String(row.source),
    sourceKind: row.source_kind as UsageLedgerObject['sourceKind'],
    sessionId: row.session_id as string | null,
    runId: row.run_id as string | null,
    spanId: row.span_id as string | null,
    projectKey: row.project_key as string | null,
    accountLabel: row.account_label as string | null,
    bucketStart: row.bucket_start as number | null,
    bucketEnd: row.bucket_end as number | null,
    model: row.model as string | null,
    usageKind: String(row.usage_kind),
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    cacheReadTokens: row.cache_read_tokens as number | null,
    cacheWriteTokens: row.cache_write_tokens as number | null,
    reasoningTokens: row.reasoning_tokens as number | null,
    toolTokens: row.tool_tokens as number | null,
    requestCount: row.request_count as number | null,
    cost: row.cost as number | null,
    currency: row.currency as string | null,
    costUnit: row.cost_unit as UsageLedgerObject['costUnit'],
    costSource: row.cost_source as UsageLedgerObject['costSource'],
    confidence: row.confidence as UsageLedgerObject['confidence'],
    attributionMethod: row.attribution_method as UsageLedgerObject['attributionMethod'],
    rawUsageId: row.raw_usage_id as string | null,
    priceVersionId: row.price_version_id as string | null,
    createdTs: row.created_ts as number
  }
}

function baseBillingState(
  status: 'unavailable' | 'query_error' = 'unavailable',
  error = 'SQLite 当前不可用，账单事实未知'
): BillingGuardianState {
  return {
    status,
    error,
    adminConnections: envConnections(),
    gatewayConnections: gatewayConnections(),
    rawUsageRows: 0,
    ledgerRows: 0,
    sourceSummaries: [],
    reconciliation: [],
    rollups: [],
    priceVersions: [],
    preflight: {
      status: 'refused',
      confidence: 'inferred',
      evidence: 'usage_ledger has no historical rows; refusing PR estimate'
    },
    advice: [],
    teamCosts: [],
    gatewayPolicies: [],
    sharedReportExport: {
      availableFormats: ['markdown', 'json'],
      plannedFormats: ['csv', 'bi'],
      includesTranscript: false,
      evidence: 'normalized usage_ledger/team_labels export; transcript excluded by default'
    },
    audit: {
      auditRows: 0,
      retentionMode: 'aggregate-only',
      redactionMode: 'default',
      contractPriceRows: 0,
      chargebackRows: 0,
      showbackCost: 0
    }
  }
}

function computeBillingState(): BillingGuardianState {
  if (!db) {
    return baseBillingState()
  }
  try {
    const syncRows = db.prepare(
      `SELECT provider, last_sync_ts lastSyncTs, last_error lastError FROM billing_sync_state`
    ).all() as Array<{ provider: BillingProvider; lastSyncTs: number | null; lastError: string | null }>
    const syncByProvider = new Map(syncRows.map((row) => [row.provider, row]))
    const rawUsageRows = (db.prepare(`SELECT COUNT(*) n FROM provider_raw_usage`).get() as { n: number }).n
    const ledgerRows = (db.prepare(`SELECT COUNT(*) n FROM usage_ledger`).get() as { n: number }).n
    const sourceSummaries = db
      .prepare(
        `SELECT source, source_kind sourceKind, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens,
                MAX(created_ts) latestTs
         FROM usage_ledger GROUP BY source, source_kind, cost_source, confidence
         ORDER BY latestTs DESC`
      )
      .all() as BillingGuardianState['sourceSummaries']
    const rows = db.prepare(`SELECT * FROM usage_ledger ORDER BY created_ts DESC LIMIT 5000`).all() as Record<string, unknown>[]
    const reconciliation = reconcileUsageLedger(rows.map(usageLedgerObjectFromDb))
    const rollups = db
      .prepare(
        `SELECT 'day' granularity, COALESCE(project_key, 'unattributed') projectKey,
                COALESCE(model, 'unavailable') model, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens
         FROM usage_ledger
         WHERE ${canonicalUsdCostWhere()}
         GROUP BY date(bucket_start / 1000, 'unixepoch'), project_key, model, cost_source, confidence
         UNION ALL
         SELECT 'week' granularity, COALESCE(project_key, 'unattributed') projectKey,
                COALESCE(model, 'unavailable') model, cost_source costSource, confidence,
                COUNT(*) rows, COALESCE(SUM(cost), 0) cost,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) tokens
         FROM usage_ledger
         WHERE ${canonicalUsdCostWhere()}
         GROUP BY strftime('%Y-W%W', bucket_start / 1000, 'unixepoch'), project_key, model, cost_source, confidence
         ORDER BY cost DESC LIMIT 8`
      )
      .all() as BillingGuardianState['rollups']
    const priceVersions = db
      .prepare(
        `SELECT mp.id, mp.provider, mp.model, mp.currency, mp.source, mp.effective_from effectiveFrom,
                COUNT(ul.id) frozenLedgerRows
         FROM model_price_versions mp
         LEFT JOIN usage_ledger ul ON ul.price_version_id = mp.id
         GROUP BY mp.id, mp.provider, mp.model, mp.currency, mp.source, mp.effective_from
         ORDER BY mp.effective_from DESC LIMIT 8`
      )
      .all() as BillingGuardianState['priceVersions']
    const priced = db
      .prepare(`SELECT COUNT(*) n, COALESCE(AVG(cost), 0) avgCost FROM usage_ledger WHERE ${canonicalUsdCostWhere()}`)
      .get() as { n: number; avgCost: number }
    const preflight =
      priced.n < 3
        ? {
            status: 'refused' as const,
            confidence: 'inferred' as const,
            evidence: `usage_ledger priced rows=${priced.n}; history too sparse for PR estimate`
          }
        : {
            status: 'ready' as const,
            confidence: 'estimated' as const,
            low: Number((priced.avgCost * 0.5).toFixed(4)),
            expected: Number(priced.avgCost.toFixed(4)),
            high: Number((priced.avgCost * 1.8).toFixed(4)),
            evidence: `usage_ledger priced rows=${priced.n}; based on historical session costs`
          }
    const advice: BillingGuardianState['advice'] = []
    const cacheHeavy = db
      .prepare(
        `SELECT source, COUNT(*) rows, COALESCE(SUM(cache_write_tokens),0) writeTokens, COALESCE(SUM(cache_read_tokens),0) readTokens
         FROM usage_ledger GROUP BY source ORDER BY writeTokens DESC LIMIT 1`
      )
      .get() as { source: string; rows: number; writeTokens: number; readTokens: number } | undefined
    if (cacheHeavy && cacheHeavy.writeTokens > cacheHeavy.readTokens) {
      advice.push({
        title: '缓存写入高于读取',
        detail: '优先复用稳定 prompt 或拆分 session，避免重复写入缓存。',
        confidence: 'estimated',
        evidence: `usage_ledger:source=${cacheHeavy.source}`
      })
    }
    if (rollups.length > 0) {
      advice.push({
        title: '按项目查看高成本窗口',
        detail: '先从最高 day/week rollup 对应项目回看 expensive sessions。',
        confidence: 'inferred',
        evidence: `usage_rollup:${rollups[0].granularity}:${rollups[0].projectKey}`
      })
    }
    const teamCosts = db
      .prepare(
        `SELECT COALESCE(t.team, 'local') team, COALESCE(ul.project_key, 'unattributed') project,
                COALESCE(t.owner, ul.account_label, 'unassigned') owner,
                COALESCE(t.workflow, ul.source) workflow,
                COALESCE(SUM(ul.cost), 0) cost,
                CASE WHEN SUM(CASE WHEN ul.confidence='estimated' THEN 1 ELSE 0 END) > 0 THEN 'estimated'
                     WHEN SUM(CASE WHEN ul.confidence='provider_reported' THEN 1 ELSE 0 END) > 0 THEN 'provider_reported'
                     ELSE 'inferred' END confidence
         FROM usage_ledger ul
         LEFT JOIN team_labels t ON t.project_key = ul.project_key
         WHERE ${canonicalUsdCostWhere('ul')}
         GROUP BY team, project, owner, workflow
         ORDER BY cost DESC LIMIT 8`
      )
      .all() as BillingGuardianState['teamCosts']
    const gatewayPolicies = db
      .prepare(
        `SELECT provider, label, source, budget_usd budgetUsd, rpm, tpm, keys_hosted keysHosted
         FROM gateway_policies ORDER BY imported_ts DESC LIMIT 8`
      )
      .all()
      .map((r) => ({ ...(r as BillingGuardianState['gatewayPolicies'][number]), keysHosted: !!(r as { keysHosted: number }).keysHosted }))
    const retention =
      (db
        .prepare(`SELECT raw_payload_mode retentionMode, redaction_mode redactionMode FROM billing_retention_policies ORDER BY updated_ts DESC LIMIT 1`)
        .get() as { retentionMode: string; redactionMode: string } | undefined) ?? null
    const auditRows = (db.prepare(`SELECT COUNT(*) n FROM billing_audit_log`).get() as { n: number }).n
    const contractPriceRows = (db.prepare(`SELECT COUNT(*) n FROM contract_prices`).get() as { n: number }).n
    const chargeback = db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(ul.cost),0) cost
         FROM usage_ledger ul
         LEFT JOIN team_labels t ON t.project_key = ul.project_key
         WHERE ${canonicalUsdCostWhere('ul')}`
      )
      .get() as { n: number; cost: number }
    return {
      status: 'ready',
      adminConnections: envConnections({
        lastOpenAiSync: syncByProvider.get('openai')?.lastSyncTs ?? undefined,
        lastAnthropicSync: syncByProvider.get('anthropic')?.lastSyncTs ?? undefined,
        lastQoderSync: syncByProvider.get('qoder')?.lastSyncTs ?? undefined,
        lastOpenAiError: syncByProvider.get('openai')?.lastError ?? undefined,
        lastAnthropicError: syncByProvider.get('anthropic')?.lastError ?? undefined,
        lastQoderError: syncByProvider.get('qoder')?.lastError ?? undefined
      }),
      gatewayConnections: gatewayConnections(),
      rawUsageRows,
      ledgerRows,
      sourceSummaries,
      reconciliation,
      rollups,
      priceVersions,
      preflight,
      advice,
      teamCosts,
      gatewayPolicies,
      sharedReportExport: {
        availableFormats: ['markdown', 'json'],
        plannedFormats: ['csv', 'bi'],
        includesTranscript: false,
        evidence: `available markdown report + normalized JSON state; teamCosts=${teamCosts.length}; usage_ledger rows=${ledgerRows}; transcript excluded by default`
      },
      audit: {
        auditRows,
        retentionMode: retention?.retentionMode ?? 'aggregate-only',
        redactionMode: retention?.redactionMode ?? 'default',
        contractPriceRows,
        chargebackRows: chargeback.n,
        showbackCost: chargeback.cost
      }
    }
  } catch (e) {
    const error = (e as Error)?.message ?? String(e)
    console.warn('[scry] billingStateQuery 失败:', error)
    return baseBillingState('query_error', error)
  }
}

export function billingStateQuery(): BillingGuardianState {
  if (billingStateCache?.revision === dataRevision) return billingStateCache.value
  const value = computeBillingState()
  setBillingStateCache({ revision: dataRevision, value })
  return value
}
