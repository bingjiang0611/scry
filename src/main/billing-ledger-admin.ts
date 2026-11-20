import { createHash } from 'node:crypto'
import type {
  BillingConfidence,
  BillingCostSource,
  BillingProvider,
  BillingReconciliationRow,
  BillingSourceKind,
  ProviderRawUsageObject,
  UsageLedgerObject
} from '../shared/billing'
import type { BillingLedgerRows } from './billing-ledger-rows'
import { providerRawUsageObjectToRow, usageLedgerObjectToRow } from './billing-ledger-rows'

const isoToMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const n = Date.parse(value)
  return Number.isNaN(n) ? null : n
}
const timeToMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value
  if (typeof value === 'string') return isoToMs(value)
  return null
}
const stablePart = (v: unknown): string | null =>
  typeof v === 'string' && v.trim()
    ? v.trim().replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 80)
    : typeof v === 'number' && Number.isFinite(v)
      ? String(v)
      : null

const normalizedJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => normalizedJsonValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalizedJsonValue(item)])
    )
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  return value === undefined || typeof value === 'function' || typeof value === 'symbol' ? null : value
}

const qoderEventKey = (payload: Record<string, unknown>): string => {
  const providerId = stablePart(payload.id) ?? stablePart(payload.provider_request_id) ?? stablePart(payload.request_id)
  if (providerId) return `id:${providerId}`
  const hash = createHash('sha256').update(JSON.stringify(normalizedJsonValue(payload))).digest('hex').slice(0, 32)
  return `sha256:${hash}`
}

function numberFromPath(input: unknown, path: string[]): number | null {
  let cur: unknown = input
  for (const p of path) cur = (cur as Record<string, unknown> | undefined)?.[p]
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null
}

function stringFromPath(input: unknown, path: string[]): string | null {
  let cur: unknown = input
  for (const p of path) cur = (cur as Record<string, unknown> | undefined)?.[p]
  return typeof cur === 'string' ? cur : null
}

function rawObject(args: {
  provider: BillingProvider
  source: string
  sourceKind: BillingSourceKind
  payload: Record<string, unknown>
  fetchedAt: number
  startingAt?: string | null
  endingAt?: string | null
  idOverride?: string
}): ProviderRawUsageObject {
  const start =
    stringFromPath(args.payload, ['start_time']) ??
    stringFromPath(args.payload, ['start']) ??
    stringFromPath(args.payload, ['starting_at']) ??
    args.startingAt ??
    null
  const end =
    stringFromPath(args.payload, ['end_time']) ??
    stringFromPath(args.payload, ['end']) ??
    stringFromPath(args.payload, ['ending_at']) ??
    args.endingAt ??
    null
  const idPart =
    stablePart(args.payload.id) ??
    stablePart(args.payload.provider_request_id) ??
    stablePart(args.payload.request_id) ??
    `sha256:${createHash('sha256').update(JSON.stringify(normalizedJsonValue(args.payload))).digest('hex').slice(0, 32)}`
  return {
    id: args.idOverride ?? `${args.source}:${idPart}`,
    provider: args.provider,
    source: args.source,
    sourceKind: args.sourceKind,
    fetchedAt: args.fetchedAt,
    startingAt: start,
    endingAt: end,
    bucketStart: timeToMs(args.payload.start_time) ?? timeToMs(args.payload.starting_at) ?? timeToMs(args.payload.timestamp) ?? timeToMs(start),
    bucketEnd: timeToMs(args.payload.end_time) ?? timeToMs(args.payload.ending_at) ?? timeToMs(args.payload.timestamp) ?? timeToMs(end),
    providerRequestId: stringFromPath(args.payload, ['id']) ?? stringFromPath(args.payload, ['request_id']),
    payload: args.payload,
    storageMode: 'aggregate'
  }
}

function anthropicUsageLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  const uncached = numberFromPath(p, ['results', 'uncached_input_tokens']) ?? numberFromPath(p, ['uncached_input_tokens'])
  const cached = numberFromPath(p, ['results', 'cache_read_input_tokens']) ?? numberFromPath(p, ['cache_read_input_tokens'])
  const cacheWrite =
    numberFromPath(p, ['results', 'cache_creation_input_tokens']) ?? numberFromPath(p, ['cache_creation_input_tokens'])
  const output = numberFromPath(p, ['results', 'output_tokens']) ?? numberFromPath(p, ['output_tokens'])
  return {
    id: `ledger:${raw.id}`,
    provider: 'anthropic',
    source: 'anthropic_admin_usage',
    sourceKind: 'official_telemetry',
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: stringFromPath(p, ['grouping', 'model']) ?? stringFromPath(p, ['model']),
    usageKind: 'messages_usage',
    inputTokens: (uncached ?? 0) + (cached ?? 0) + (cacheWrite ?? 0),
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    requestCount: numberFromPath(p, ['results', 'requests']) ?? numberFromPath(p, ['requests']),
    cost: null,
    currency: null,
    costUnit: 'token',
    costSource: 'official_telemetry',
    confidence: 'exact',
    attributionMethod: 'unattributed',
    rawUsageId: raw.id,
    metadata: p,
    createdTs: raw.fetchedAt
  }
}

function anthropicCostLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  return {
    id: `ledger:${raw.id}`,
    provider: 'anthropic',
    source: 'anthropic_admin_cost',
    sourceKind: 'provider_bill',
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: stringFromPath(p, ['grouping', 'model']) ?? null,
    usageKind: 'daily_cost',
    cost: numberFromPath(p, ['results', 'cost_usd']) ?? numberFromPath(p, ['cost_usd']) ?? numberFromPath(p, ['amount']),
    currency: 'USD',
    costUnit: 'usd',
    costSource: 'provider_bill',
    confidence: 'exact',
    attributionMethod: 'unattributed',
    rawUsageId: raw.id,
    metadata: p,
    createdTs: raw.fetchedAt
  }
}

function anthropicGatewayLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  const usage = (p.usage && typeof p.usage === 'object' ? p.usage : p) as Record<string, unknown>
  const cost = numberFromPath(p, ['cost_usd']) ?? numberFromPath(p, ['usage', 'cost_usd']) ?? numberFromPath(p, ['usage', 'cost'])
  const currency = stringFromPath(p, ['currency']) ?? stringFromPath(p, ['usage', 'currency']) ?? (cost != null ? 'USD' : null)
  const cacheDetails = (usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null) as Record<string, unknown> | null
  return {
    id: `ledger:${raw.id}`,
    provider: 'anthropic',
    source: 'anthropic_gateway_response',
    sourceKind: 'gateway_reported',
    sessionId: stringFromPath(p, ['session_id']),
    runId: stringFromPath(p, ['run_id']),
    projectKey: stringFromPath(p, ['project_key']),
    accountLabel: raw.accountLabel ?? null,
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: stringFromPath(p, ['model']),
    usageKind: 'messages_response',
    inputTokens: numberFromPath(usage, ['input_tokens']),
    outputTokens: numberFromPath(usage, ['output_tokens']),
    cacheReadTokens: numberFromPath(usage, ['cache_read_input_tokens']),
    cacheWriteTokens:
      numberFromPath(usage, ['cache_creation_input_tokens']) ??
      (cacheDetails ? numberFromPath(cacheDetails, ['ephemeral_5m_input_tokens']) ?? 0 : null),
    requestCount: 1,
    cost,
    currency,
    costUnit: currency?.toLowerCase() === 'usd' ? 'usd' : cost != null ? 'custom' : 'token',
    costSource: 'gateway_reported',
    confidence: 'provider_reported',
    attributionMethod: 'direct',
    rawUsageId: raw.id,
    metadata: p,
    priceVersionId: stringFromPath(p, ['price_version_id']),
    createdTs: raw.fetchedAt
  }
}

function openAiUsageLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  return {
    id: `ledger:${raw.id}`,
    provider: 'openai',
    source: 'openai_admin_usage',
    sourceKind: 'official_telemetry',
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: stringFromPath(p, ['model']),
    usageKind: 'completions_usage',
    inputTokens: numberFromPath(p, ['input_tokens']),
    outputTokens: numberFromPath(p, ['output_tokens']),
    cacheReadTokens: numberFromPath(p, ['input_cached_tokens']),
    reasoningTokens: numberFromPath(p, ['output_reasoning_tokens']),
    requestCount: numberFromPath(p, ['num_model_requests']),
    cost: null,
    currency: null,
    costUnit: 'token',
    costSource: 'official_telemetry',
    confidence: 'exact',
    attributionMethod: 'unattributed',
    rawUsageId: raw.id,
    metadata: p,
    createdTs: raw.fetchedAt
  }
}

function openAiCostLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  const amountValue = numberFromPath(p, ['amount', 'value']) ?? numberFromPath(p, ['cost']) ?? numberFromPath(p, ['amount'])
  const currency = stringFromPath(p, ['amount', 'currency']) ?? 'USD'
  return {
    id: `ledger:${raw.id}`,
    provider: 'openai',
    source: 'openai_admin_cost',
    sourceKind: 'provider_bill',
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: null,
    usageKind: 'organization_cost',
    cost: amountValue,
    currency,
    costUnit: currency.toLowerCase() === 'usd' ? 'usd' : 'custom',
    costSource: 'provider_bill',
    confidence: 'exact',
    attributionMethod: 'unattributed',
    rawUsageId: raw.id,
    metadata: p,
    createdTs: raw.fetchedAt
  }
}

function qoderUsageLedger(raw: ProviderRawUsageObject): UsageLedgerObject {
  const p = raw.payload
  return {
    id: `ledger:${raw.id}`,
    provider: 'qoder',
    source: 'qoder_teams_usage',
    sourceKind: 'provider_bill',
    accountLabel: stringFromPath(p, ['userEmail']) ?? stringFromPath(p, ['userId']),
    bucketStart: raw.bucketStart,
    bucketEnd: raw.bucketEnd,
    model: stringFromPath(p, ['modelTier']),
    usageKind: 'credits_usage',
    requestCount: 1,
    cost: numberFromPath(p, ['cost']) ?? numberFromPath(p, ['credits']),
    currency: null,
    costUnit: 'credits',
    costSource: 'provider_bill',
    confidence: 'exact',
    attributionMethod: 'unattributed',
    rawUsageId: raw.id,
    metadata: p,
    createdTs: raw.fetchedAt
  }
}

export function billingRowsFromAdminPayload(args: {
  provider: 'anthropic' | 'openai' | 'qoder'
  source: 'anthropic_admin_usage' | 'anthropic_admin_cost' | 'openai_admin_usage' | 'openai_admin_cost' | 'qoder_teams_usage'
  payloads: Record<string, unknown>[]
  fetchedAt: number
  startingAt?: string | null
  endingAt?: string | null
}): BillingLedgerRows {
  const sourceKind: BillingSourceKind =
    args.source === 'qoder_teams_usage' || args.source.endsWith('_cost') || args.source === 'anthropic_admin_cost' ? 'provider_bill' : 'official_telemetry'
  const qoderOccurrences = new Map<string, number>()
  const raw = args.payloads.map((payload) => {
    let idOverride: string | undefined
    if (args.source === 'qoder_teams_usage') {
      const key = qoderEventKey(payload)
      const occurrence = qoderOccurrences.get(key) ?? 0
      qoderOccurrences.set(key, occurrence + 1)
      idOverride = `${args.source}:${key}:${occurrence}`
    }
    return rawObject({
      provider: args.provider,
      source: args.source,
      sourceKind,
      payload,
      fetchedAt: args.fetchedAt,
      startingAt: args.startingAt,
      endingAt: args.endingAt,
      idOverride
    })
  })
  const ledger = raw.map((r) => {
    if (args.source === 'anthropic_admin_usage') return anthropicUsageLedger(r)
    if (args.source === 'anthropic_admin_cost') return anthropicCostLedger(r)
    if (args.source === 'openai_admin_usage') return openAiUsageLedger(r)
    if (args.source === 'openai_admin_cost') return openAiCostLedger(r)
    return qoderUsageLedger(r)
  })
  return {
    providerRawUsage: raw.map(providerRawUsageObjectToRow),
    usageLedger: ledger.map(usageLedgerObjectToRow)
  }
}

export function billingRowsFromAnthropicGatewayPayload(args: {
  payloads: Record<string, unknown>[]
  fetchedAt: number
  accountLabel?: string | null
}): BillingLedgerRows {
  const raw = args.payloads.map((payload) =>
    rawObject({
      provider: 'anthropic',
      source: 'anthropic_gateway_response',
      sourceKind: 'gateway_reported',
      payload,
      fetchedAt: args.fetchedAt,
      startingAt: stringFromPath(payload, ['created_at']) ?? null,
      endingAt: stringFromPath(payload, ['created_at']) ?? null
    })
  )
  for (const r of raw) r.accountLabel = args.accountLabel ?? null
  const ledger = raw.map(anthropicGatewayLedger)
  return {
    providerRawUsage: raw.map(providerRawUsageObjectToRow),
    usageLedger: ledger.map(usageLedgerObjectToRow)
  }
}

export function reconcileUsageLedger(rows: UsageLedgerObject[]): BillingReconciliationRow[] {
  const byProvider = new Map<string, UsageLedgerObject[]>()
  for (const r of rows) {
    if (r.cost == null) continue
    if (r.provider === 'qoder' && r.costUnit === 'usd' && r.cost === 0 && r.costSource === 'provider_reported') continue
    const key = `${r.provider}:${r.costUnit}`
    const arr = byProvider.get(key) ?? []
    arr.push(r)
    byProvider.set(key, arr)
  }
  return [...byProvider.values()].map((items) => {
    const provider = items[0].provider
    const costUnit = items[0].costUnit
    const sum = (sources: BillingCostSource[]): number =>
      items.filter((r) => sources.includes(r.costSource)).reduce((s, r) => s + (r.cost ?? 0), 0)
    const sdkEstimate = sum(['sdk_estimate', 'price_table'])
    const providerReported = sum(['provider_reported', 'gateway_reported'])
    const officialBill = sum(['provider_bill'])
    const officialTelemetry = sum(['official_telemetry'])
    const deltaOfficialVsSdk = officialBill > 0 && sdkEstimate > 0 ? officialBill - sdkEstimate : null
    const hasOfficial = officialBill > 0 || officialTelemetry > 0
    const hasGateway = providerReported > 0
    const note = !hasOfficial
      ? hasGateway
        ? '三方 gateway/provider reported 已导入；official bill unavailable'
        : '只有本地 SDK 估算，official bill unavailable'
      : officialBill > 0 && sdkEstimate > 0
        ? '官方账单与 SDK 估算可对比；session 级归因仍为 inferred'
        : '官方来源已导入，但缺少可直接对比的 SDK 估算或 cost 字段'
    const confidence: BillingConfidence = officialBill > 0 ? 'exact' : hasOfficial ? 'inferred' : hasGateway ? 'provider_reported' : 'estimated'
    return { provider, label: costUnit === 'usd' ? provider : `${provider} · ${costUnit}`, costUnit, sdkEstimate, providerReported, officialBill, officialTelemetry, deltaOfficialVsSdk, confidence, note }
  })
}
