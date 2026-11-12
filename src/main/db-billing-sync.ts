import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { maskSecrets } from '../shared/trace'
import {
  BILLING_AUDIT_LOG_COLS,
  BILLING_RETENTION_POLICY_COLS,
  CHARGEBACK_ENTRY_COLS,
  CONTRACT_PRICE_COLS,
  GATEWAY_POLICY_COLS,
  MODEL_PRICE_VERSION_COLS,
  PROVIDER_RAW_USAGE_COLS,
  TEAM_LABEL_COLS,
  USAGE_LEDGER_COLS,
  sqlInsert
} from './span-ledger'
import { fetchAnthropicAdminUsageAndCosts, fetchOpenAiAdminUsageAndCosts, fetchQoderUsageAndCosts, type AdminFetchResult } from './billing-admin'
import { billingRowsFromAnthropicGatewayPayload } from './billing-ledger'
import type { BillingFixtureImportResult, BillingProvider, BillingSyncResult } from '../shared/billing'
import { billingEnvProvider, db, invalidateQueryCaches } from './db-state'
import { billingStateQuery } from './db-billing-state'

function safeJson(v: unknown): string {
  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') return maskSecrets(input)
    if (Array.isArray(input)) return input.map(scrub)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([k, val]) => [k, scrub(val)]))
    return input
  }
  return JSON.stringify(scrub(v ?? {}))
}

export const UPSERT_BILLING_SYNC_STATE_SQL = `INSERT INTO billing_sync_state (
  provider, last_sync_ts, last_error, updated_ts
) VALUES (?, ?, ?, ?)
ON CONFLICT(provider) DO UPDATE SET
  last_sync_ts=COALESCE(excluded.last_sync_ts, billing_sync_state.last_sync_ts),
  last_error=excluded.last_error,
  updated_ts=excluded.updated_ts`

export async function syncBillingAdmin(): Promise<BillingSyncResult> {
  if (!db) return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: 'sqlite unavailable', state: billingStateQuery() }
  const now = Date.now()
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000
  const env = billingEnvProvider()
  const tasks: Array<{ provider: BillingProvider; promise: Promise<AdminFetchResult> }> = []
  if (env.OPENAI_ADMIN_API_KEY) {
    tasks.push({ provider: 'openai', promise: fetchOpenAiAdminUsageAndCosts({
      apiKey: env.OPENAI_ADMIN_API_KEY,
      startTime: Math.floor(oneWeekAgo / 1000),
      endTime: Math.floor(now / 1000),
      nowMs: now
    }) })
  }
  if (env.ANTHROPIC_ADMIN_API_KEY) {
    tasks.push({ provider: 'anthropic', promise: fetchAnthropicAdminUsageAndCosts({
      apiKey: env.ANTHROPIC_ADMIN_API_KEY,
      startingAt: new Date(oneWeekAgo).toISOString(),
      endingAt: new Date(now).toISOString(),
      nowMs: now
    }) })
  }
  if (env.QODER_ADMIN_API_KEY && env.QODER_ORGANIZATION_ID) {
    tasks.push({ provider: 'qoder', promise: fetchQoderUsageAndCosts({
      apiKey: env.QODER_ADMIN_API_KEY,
      organizationId: env.QODER_ORGANIZATION_ID,
      memberId: env.QODER_MEMBER_ID,
      startDate: new Date(oneWeekAgo).toISOString(),
      endDate: new Date(now).toISOString(),
      nowMs: now
    }) })
  }
  if (tasks.length === 0) {
    return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: 'missing Anthropic/OpenAI/Qoder Admin configuration', state: billingStateQuery() }
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.promise))
  const results: AdminFetchResult[] = []
  const failures: string[] = []
  const syncState = db.prepare(UPSERT_BILLING_SYNC_STATE_SQL)
  const insRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
  const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
  const tx = db.transaction(() => {
    settled.forEach((outcome, index) => {
      const provider = tasks[index].provider
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value)
        for (const row of outcome.value.rows.providerRawUsage) insRaw.run(...(row as never[]))
        for (const row of outcome.value.rows.usageLedger) insLedger.run(...(row as never[]))
        syncState.run(provider, outcome.value.fetchedAt, null, now)
      } else {
        const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)
        failures.push(`${provider}: ${error}`)
        syncState.run(provider, null, error.slice(0, 2_000), now)
      }
    })
  })
  try {
    tx()
    invalidateQueryCaches()
  } catch (error) {
    return { ok: false, rowsImported: 0, ledgerRowsImported: 0, error: String((error as Error).message), state: billingStateQuery() }
  }
  return {
    ok: failures.length === 0,
    ...(results.length > 0 ? { provider: results.length === 1 ? results[0].provider : 'multiple' as const } : {}),
    rowsImported: results.reduce((sum, result) => sum + result.rows.providerRawUsage.length, 0),
    ledgerRowsImported: results.reduce((sum, result) => sum + result.rows.usageLedger.length, 0),
    ...(failures.length > 0 ? { error: failures.join('；') } : {}),
    state: billingStateQuery()
  }
}

function insertBillingRows(rows: { providerRawUsage: unknown[][]; usageLedger: unknown[][] }): void {
  if (!db) return
  const insRaw = db.prepare(sqlInsert('provider_raw_usage', PROVIDER_RAW_USAGE_COLS))
  const insLedger = db.prepare(sqlInsert('usage_ledger', USAGE_LEDGER_COLS))
  const tx = db.transaction(() => {
    for (const r of rows.providerRawUsage) insRaw.run(...(r as never[]))
    for (const r of rows.usageLedger) insLedger.run(...(r as never[]))
  })
  tx()
}

export function importBillingFixture(): BillingFixtureImportResult {
  const fixture = 'fixtures/billing/anthropic-gateway-response.json'
  if (!db) return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: 'sqlite unavailable', state: billingStateQuery() }
  try {
    const fp = join(app.getAppPath(), fixture)
    if (!existsSync(fp)) return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: 'fixture missing', state: billingStateQuery() }
    const json = JSON.parse(readFileSync(fp, 'utf8')) as {
      responses?: Record<string, unknown>[]
      accountLabel?: string
      priceVersions?: Array<Record<string, unknown>>
      teamLabels?: Array<Record<string, unknown>>
      gatewayPolicies?: Array<Record<string, unknown>>
      retentionPolicy?: Record<string, unknown>
      contractPrices?: Array<Record<string, unknown>>
      chargebackEntries?: Array<Record<string, unknown>>
    }
    const fetchedAt = 1783000000000
    const rows = billingRowsFromAnthropicGatewayPayload({
      payloads: json.responses ?? [],
      fetchedAt,
      accountLabel: json.accountLabel ?? 'fixture-gateway'
    })
    insertBillingRows(rows)
    const insPrice = db.prepare(sqlInsert('model_price_versions', MODEL_PRICE_VERSION_COLS))
    const insTeam = db.prepare(sqlInsert('team_labels', TEAM_LABEL_COLS))
    const insPolicy = db.prepare(sqlInsert('gateway_policies', GATEWAY_POLICY_COLS))
    const insAudit = db.prepare(sqlInsert('billing_audit_log', BILLING_AUDIT_LOG_COLS))
    const insRetention = db.prepare(sqlInsert('billing_retention_policies', BILLING_RETENTION_POLICY_COLS))
    const insContract = db.prepare(sqlInsert('contract_prices', CONTRACT_PRICE_COLS))
    const insChargeback = db.prepare(sqlInsert('chargeback_entries', CHARGEBACK_ENTRY_COLS))
    const metaTx = db.transaction(() => {
      for (const p of json.priceVersions ?? []) {
        insPrice.run(
          p.id,
          p.provider,
          p.model,
          p.currency ?? 'USD',
          p.inputPerMillion ?? null,
          p.outputPerMillion ?? null,
          p.cacheReadPerMillion ?? null,
          p.cacheWritePerMillion ?? null,
          p.reasoningPerMillion ?? null,
          p.effectiveFrom ?? fetchedAt,
          null,
          p.source ?? 'fixture',
          safeJson({ importedFrom: fixture })
        )
      }
      for (const t of json.teamLabels ?? []) {
        insTeam.run(t.id, t.projectKey, t.team, t.owner, t.workflow, t.source ?? 'fixture', fetchedAt)
      }
      for (const p of json.gatewayPolicies ?? []) {
        insPolicy.run(
          p.id,
          p.provider,
          p.label,
          p.source ?? 'gateway-config-import',
          p.budgetUsd ?? null,
          p.rpm ?? null,
          p.tpm ?? null,
          safeJson(p.config ?? {}),
          0,
          fetchedAt
        )
      }
      const rp = json.retentionPolicy
      if (rp) {
        insRetention.run(
          rp.id,
          rp.rawPayloadMode ?? 'aggregate-only',
          rp.retentionDays ?? 30,
          rp.redactionMode ?? 'secrets-and-prompts',
          rp.exportMode ?? 'redacted',
          fetchedAt
        )
      }
      for (const p of json.contractPrices ?? []) {
        insContract.run(
          p.id,
          p.provider,
          p.model,
          p.currency ?? 'USD',
          p.inputPerMillion ?? null,
          p.outputPerMillion ?? null,
          p.cacheReadPerMillion ?? null,
          p.cacheWritePerMillion ?? null,
          p.effectiveFrom ?? fetchedAt,
          p.source ?? 'contract-import',
          safeJson({ importedFrom: fixture })
        )
      }
      for (const c of json.chargebackEntries ?? []) {
        insChargeback.run(
          c.id,
          c.team,
          c.projectKey,
          c.owner,
          c.workflow,
          c.cost ?? 0,
          c.currency ?? 'USD',
          c.source ?? 'gateway_reported',
          c.confidence ?? 'provider_reported',
          fetchedAt
        )
      }
      insAudit.run(`audit:${fetchedAt}:fixture`, 'local-user', 'import_gateway_fixture', fixture, safeJson({ rows: rows.usageLedger.length }), fetchedAt)
      insAudit.run(`audit:${fetchedAt}:retention`, 'local-user', 'apply_retention_policy', rp?.id ?? 'default', safeJson({ mode: rp?.rawPayloadMode ?? 'aggregate-only' }), fetchedAt)
    })
    metaTx()
    invalidateQueryCaches()
    return {
      ok: true,
      fixture,
      provider: 'anthropic',
      rowsImported: rows.providerRawUsage.length,
      ledgerRowsImported: rows.usageLedger.length,
      state: billingStateQuery()
    }
  } catch (e) {
    return { ok: false, fixture, rowsImported: 0, ledgerRowsImported: 0, error: String((e as Error).message), state: billingStateQuery() }
  }
}
