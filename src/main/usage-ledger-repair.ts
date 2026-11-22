import type Database from 'better-sqlite3'
import { billingProviderForUpstream, type UsageLedgerObject } from '../shared/billing'
import { usageLedgerObjectToRow } from './billing-ledger-rows'
import { USAGE_LEDGER_COLS } from './span-ledger'

interface RetainedUsage {
  spanId: string
  sessionId: string
  runId: string
  cwd: string
  ts: number
  providerId: string
  runtimeProvider: string
  model: string | null
  upstreamProvider: string | null
  hasModel: number
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  cost: number | null
}

export function repairMissingUsageLedger(db: Database.Database): void {
  const retained = db.prepare(`SELECT s.id spanId, s.session_id sessionId, s.run_id runId,
    r.cwd, s.ts_start ts, r.provider_id providerId, r.runtime_provider runtimeProvider,
    COALESCE(m.model, s.model) model, m.upstream_provider upstreamProvider,
    m.span_id IS NOT NULL hasModel,
    CASE WHEN m.span_id IS NOT NULL THEN m.input_tokens ELSE s.tokens_in END input,
    CASE WHEN m.span_id IS NOT NULL THEN m.output_tokens ELSE s.tokens_out END output,
    CASE WHEN m.span_id IS NOT NULL THEN m.cache_read_tokens ELSE s.cache_read_tokens END cacheRead,
    CASE WHEN m.span_id IS NOT NULL THEN m.cache_creation_tokens ELSE s.cache_creation_tokens END cacheWrite,
    CASE WHEN m.span_id IS NOT NULL THEN m.cost_usd ELSE s.cost_usd END cost
    FROM spans s JOIN session_refs r ON r.scry_session_id=s.session_id
    LEFT JOIN model_usage m ON m.span_id=s.id
    WHERE s.kind='harness' AND s.stage='result' AND s.run_id IS NOT NULL AND s.ts_start IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM usage_ledger u WHERE u.span_id=s.id AND u.usage_kind='result')
      AND NOT EXISTS (SELECT 1 FROM usage_ledger u WHERE u.span_id=s.id AND u.model IS m.model
        AND u.usage_kind='model' AND (r.provider_id NOT IN ('pi','opencode') OR COALESCE(m.upstream_provider,'')=''
          OR json_extract(u.metadata_json,'$.upstreamProvider')=m.upstream_provider))
    ORDER BY s.ts_start, s.id, m.model, m.upstream_provider`).all() as RetainedUsage[]
  const insert = db.prepare(`INSERT OR IGNORE INTO usage_ledger (${USAGE_LEDGER_COLS.join(',')})
    VALUES (${USAGE_LEDGER_COLS.map(() => '?').join(',')})`)
  for (const row of retained) {
    const provider = row.providerId === 'pi' || row.providerId === 'opencode'
      ? billingProviderForUpstream(row.upstreamProvider || undefined) ?? (row.providerId === 'pi' ? 'unknown' : 'opencode')
      : row.providerId === 'claude' ? 'anthropic' : row.providerId
    const cost = provider === 'qoder' ||
      ((row.runtimeProvider === 'pi_rpc' || row.runtimeProvider === 'antigravity_acp') && row.cost === 0)
      ? null
      : row.cost
    const isAntigravityMissingCost = (provider === 'antigravity' || row.runtimeProvider === 'antigravity_acp') && cost == null
    const usage: UsageLedgerObject = {
      id: `${provider}:${row.spanId}${row.hasModel ? `:${row.model}` : ''}`,
      provider, source: 'scry_persisted_usage', sourceKind: 'analytics_report',
      sessionId: row.sessionId, runId: row.runId, spanId: row.spanId, projectKey: row.cwd,
      bucketStart: row.ts, bucketEnd: row.ts, model: row.model,
      usageKind: row.hasModel ? 'model' : 'result',
      inputTokens: row.input, outputTokens: row.output,
      cacheReadTokens: row.cacheRead, cacheWriteTokens: row.cacheWrite,
      cost,
      currency: isAntigravityMissingCost ? null : 'USD',
      costUnit: isAntigravityMissingCost ? 'token' : 'usd',
      costSource: isAntigravityMissingCost ? 'provider_reported' : 'sdk_estimate',
      confidence: isAntigravityMissingCost ? 'provider_reported' : 'inferred',
      attributionMethod: 'direct', createdTs: row.ts,
      metadata: {
        reconstructedFrom: 'scry_result_and_model_usage',
        runtimeProvider: row.runtimeProvider,
        upstreamProvider: row.upstreamProvider,
        ...(isAntigravityMissingCost ? { costStatus: 'unavailable' } : {}),
        omissionReason: 'Original cost provenance and per-model reasoning were not retained in SQLite.'
      }
    }
    insert.run(...usageLedgerObjectToRow(usage))
  }
}
