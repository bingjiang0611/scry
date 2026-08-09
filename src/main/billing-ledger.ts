import type {
  BillingConfidence,
  BillingCostSource,
  BillingProvider,
  BillingReconciliationRow,
  BillingSourceKind,
  ProviderRawUsageObject,
  UsageLedgerObject
} from '../shared/billing'
import { maskSecrets, type TraceEvent } from '../shared/trace'
import type { RuntimeProvider } from '../shared/runtime'
import { createHash } from 'node:crypto'

export interface BillingLedgerRows {
  providerRawUsage: unknown[][]
  usageLedger: unknown[][]
}

export interface LocalModelPriceVersion {
  id: string
  provider: BillingProvider
  model: string
  currency: string
  inputPerMillion?: number | null
  outputPerMillion?: number | null
  cacheReadPerMillion?: number | null
  cacheWritePerMillion?: number | null
  reasoningPerMillion?: number | null
  effectiveFrom: number
  effectiveTo?: number | null
}

const redacted = (v: unknown): unknown => {
  if (typeof v === 'string') return maskSecrets(v)
  if (Array.isArray(v)) return v.map(redacted)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redacted(val)]))
  return v
}
const toJson = (v: unknown): string => JSON.stringify(redacted(v ?? {}))
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

function runtimeLedgerMetadata(args: {
  runtimeProvider?: RuntimeProvider
  result: TraceEvent
  gateway?: { provider: 'anthropic'; accountLabel: string } | null
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    ...(args.extra ?? {}),
    gateway: args.gateway ? { provider: args.gateway.provider } : null,
    runtimeProvider: args.runtimeProvider ?? args.result.runtimeProvider ?? null,
    rawUsage: args.result.runtimeMetadata?.usage ?? null,
    capabilities: args.result.runtimeMetadata?.capabilities ?? null,
    observedMcpServers: args.result.runtimeMetadata?.observedMcpServers ?? null,
    capabilityWarnings: args.result.runtimeMetadata?.capabilityWarnings ?? [],
    samplePath: args.result.runtimeMetadata?.samplePath ?? null,
    failureBrief: args.result.runtimeMetadata?.brief ?? null
  }
}

export const usageLedgerObjectToRow = (o: UsageLedgerObject): unknown[] => [
  o.id,
  o.provider,
  o.source,
  o.sourceKind,
  o.sessionId ?? null,
  o.runId ?? null,
  o.spanId ?? null,
  o.projectKey ?? null,
  o.accountLabel ?? null,
  o.bucketStart ?? null,
  o.bucketEnd ?? null,
  o.model ?? null,
  o.usageKind,
  o.inputTokens ?? null,
  o.outputTokens ?? null,
  o.cacheReadTokens ?? null,
  o.cacheWriteTokens ?? null,
  o.reasoningTokens ?? null,
  o.toolTokens ?? null,
  o.requestCount ?? null,
  o.cost ?? null,
  o.currency ?? null,
  o.costUnit,
  o.costSource,
  o.confidence,
  o.attributionMethod,
  o.rawUsageId ?? null,
  toJson(o.metadata),
  o.priceVersionId ?? null,
  o.createdTs ?? Date.now()
]

export const providerRawUsageObjectToRow = (o: ProviderRawUsageObject): unknown[] => [
  o.id,
  o.provider,
  o.source,
  o.sourceKind,
  o.accountLabel ?? null,
  o.fetchedAt,
  o.startingAt ?? null,
  o.endingAt ?? null,
  o.bucketStart ?? null,
  o.bucketEnd ?? null,
  o.providerRequestId ?? null,
  o.traceId ?? null,
  o.otelSpanId ?? null,
  o.parentSpanId ?? null,
  o.otelSignal ?? null,
  o.eventName ?? null,
  toJson(o.resourceAttributes),
  toJson(o.spanAttributes),
  toJson(o.payload),
  o.storageMode
]

export function sdkUsageLedgerRowsFromItems(args: {
  runId: string
  sessionId?: string
  cwd?: string
  items: TraceEvent[]
  nowMs: number
  billingProvider?: BillingProvider
  runtimeProvider?: RuntimeProvider
  gateway?: { provider: 'anthropic'; accountLabel: string } | null
  priceVersions?: LocalModelPriceVersion[]
}): UsageLedgerObject[] {
  const result = args.items.find((e) => e.kind === 'harness' && e.stage === 'result')
  if (!result) return []
  const fallbackProvider = result.billingProvider ?? args.billingProvider
  const sourceFor = (provider: BillingProvider, usageSource?: string): string =>
    usageSource ??
    (provider === 'anthropic'
      ? args.gateway
        ? 'anthropic_gateway_sdk_result'
        : 'claude_sdk_result'
      : provider === 'codex' || provider === 'qoder'
        ? `${provider}_cli_result`
        : `${provider}_runtime_result`)
  const isClaudeSdkEstimate = (provider: BillingProvider, usageSource?: string): boolean =>
    provider === 'anthropic' && (!usageSource || usageSource === 'claude_sdk')
  const sourceKindFor = (provider: BillingProvider, usageSource?: string): BillingSourceKind =>
    isClaudeSdkEstimate(provider, usageSource) ? 'sdk_estimate' : 'provider_reported'
  const costSourceFor = (provider: BillingProvider, usageSource: string | undefined, value?: BillingCostSource): BillingCostSource =>
    value ?? (isClaudeSdkEstimate(provider, usageSource) ? 'sdk_estimate' : 'provider_reported')
  const confidenceFor = (provider: BillingProvider, usageSource: string | undefined, value?: BillingConfidence): BillingConfidence =>
    value ?? (isClaudeSdkEstimate(provider, usageSource) ? 'estimated' : 'provider_reported')
  const ts = Date.parse(result.ts)
  const bucket = Number.isNaN(ts) ? args.nowMs : ts
  const rows: UsageLedgerObject[] = []
  const modelUsage = result.modelUsage ?? []
  if (modelUsage.length > 0) {
    for (const mu of modelUsage) {
      const provider = mu.billingProvider ?? fallbackProvider
      if (!provider) continue
      const usageSource = mu.usageSource ?? result.usageSource
      const costUnit = mu.costUnit ?? result.costUnit ?? 'usd'
      rows.push({
        id: `${provider}:${result.id}:${mu.model}`,
        provider,
        source: sourceFor(provider, usageSource),
        sourceKind: sourceKindFor(provider, usageSource),
        sessionId: args.sessionId ?? null,
        runId: args.runId,
        spanId: result.id,
        projectKey: args.cwd ?? null,
        accountLabel: mu.accountLabel ?? result.accountLabel ?? args.gateway?.accountLabel ?? null,
        bucketStart: bucket,
        bucketEnd: bucket,
        model: mu.model,
        usageKind: 'model',
        inputTokens: mu.inputTokens ?? null,
        outputTokens: mu.outputTokens ?? null,
        cacheReadTokens: mu.cacheReadTokens ?? null,
        cacheWriteTokens: mu.cacheCreationTokens ?? null,
        reasoningTokens: mu.reasoningTokens ?? null,
        cost: mu.costUsd ?? null,
        currency: costUnit === 'usd' ? 'USD' : null,
        costUnit,
        costSource: costSourceFor(provider, usageSource, mu.costSource ?? result.costSource),
        confidence: confidenceFor(provider, usageSource, mu.costConfidence ?? result.costConfidence),
        attributionMethod: 'direct',
        metadata: runtimeLedgerMetadata({
          runtimeProvider: args.runtimeProvider,
          result,
          gateway: args.gateway,
          extra: {
            contextWindow: mu.contextWindow ?? null,
            upstreamProvider: mu.upstreamProvider ?? result.upstreamProvider ?? null,
            usageSource: mu.usageSource ?? result.usageSource ?? null
          }
        }),
        createdTs: args.nowMs
      })
    }
    return estimateRows(rows, args.priceVersions)
  }
  const provider = fallbackProvider
  if (!provider) return []
  const costUnit = result.costUnit ?? 'usd'
  rows.push({
    id: `${provider}:${result.id}`,
    provider,
    source: sourceFor(provider, result.usageSource),
    sourceKind: sourceKindFor(provider, result.usageSource),
    sessionId: args.sessionId ?? null,
    runId: args.runId,
    spanId: result.id,
    projectKey: args.cwd ?? null,
    accountLabel: result.accountLabel ?? args.gateway?.accountLabel ?? null,
    bucketStart: bucket,
    bucketEnd: bucket,
    usageKind: 'result',
    inputTokens: result.tokensIn ?? null,
    outputTokens: result.tokensOut ?? null,
    cacheReadTokens: result.cacheReadTokens ?? null,
    cacheWriteTokens: result.cacheCreationTokens ?? null,
    reasoningTokens: result.reasoningTokens ?? null,
    cost: result.costUsd ?? null,
    currency: costUnit === 'usd' ? 'USD' : null,
    costUnit,
    costSource: costSourceFor(provider, result.usageSource, result.costSource),
    confidence: confidenceFor(provider, result.usageSource, result.costConfidence),
    attributionMethod: 'direct',
    metadata: runtimeLedgerMetadata({
      runtimeProvider: args.runtimeProvider,
      result,
      gateway: args.gateway,
      extra: {
        source: 'result_without_model_usage',
        upstreamProvider: result.upstreamProvider ?? null,
        usageSource: result.usageSource ?? null
      }
    }),
    createdTs: args.nowMs
  })
  return estimateRows(rows, args.priceVersions)
}

function estimateRows(rows: UsageLedgerObject[], prices: LocalModelPriceVersion[] | undefined): UsageLedgerObject[] {
  if (!prices?.length) return rows
  return rows.map((row) => {
    if (row.cost != null || !row.model) return row
    const at = row.bucketStart ?? row.createdTs ?? Date.now()
    const price = prices
      .filter((item) => item.provider === row.provider && item.model === row.model && item.effectiveFrom <= at && (item.effectiveTo == null || item.effectiveTo > at))
      .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0]
    if (!price || price.currency.toUpperCase() !== 'USD') return row
    const input = row.inputTokens ?? 0
    const output = row.outputTokens ?? 0
    const cacheRead = row.cacheReadTokens ?? 0
    const cacheWrite = row.cacheWriteTokens ?? 0
    const reasoning = row.reasoningTokens ?? 0
    if (input + output + cacheRead + cacheWrite + reasoning === 0 || price.inputPerMillion == null || price.outputPerMillion == null) return row
    // Anthropic counters are disjoint; OpenAI/Codex input includes cache reads and cache writes.
    const includedCacheWrite = row.provider === 'openai' || row.provider === 'codex' ? cacheWrite : 0
    const uncachedInput = row.provider === 'anthropic' ? input : Math.max(0, input - cacheRead - includedCacheWrite)
    const normalOutput = price.reasoningPerMillion == null ? output : Math.max(0, output - reasoning)
    const cost = (
      uncachedInput * price.inputPerMillion +
      cacheRead * (price.cacheReadPerMillion ?? price.inputPerMillion) +
      cacheWrite * (price.cacheWritePerMillion ?? price.inputPerMillion) +
      normalOutput * price.outputPerMillion +
      (price.reasoningPerMillion == null ? 0 : reasoning * price.reasoningPerMillion)
    ) / 1_000_000
    return {
      ...row,
      sourceKind: 'sdk_estimate',
      cost,
      currency: 'USD',
      costUnit: 'usd',
      costSource: 'price_table',
      confidence: 'estimated',
      priceVersionId: price.id,
      metadata: { ...(row.metadata ?? {}), priceVersionId: price.id }
    }
  })
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
  index: number
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
    stablePart(args.payload.timestamp) ??
    stablePart(args.payload.start_time) ??
    stablePart(args.payload.starting_at) ??
    stablePart(args.payload.created_at) ??
    String(args.index)
  return {
    id: args.idOverride ?? `${args.source}:${idPart}:${args.index}`,
    provider: args.provider,
    source: args.source,
    sourceKind: args.sourceKind,
    fetchedAt: args.fetchedAt,
    startingAt: start,
    endingAt: end,
    bucketStart: timeToMs(args.payload.start_time) ?? timeToMs(args.payload.starting_at) ?? timeToMs(args.payload.timestamp) ?? timeToMs(start),
    bucketEnd: timeToMs(args.payload.end_time) ?? timeToMs(args.payload.ending_at) ?? timeToMs(args.payload.timestamp) ?? timeToMs(end),
    providerRequestId: stringFromPath(args.payload, ['id']) ?? stringFromPath(args.payload, ['request_id']),
    payload: redacted(args.payload) as Record<string, unknown>,
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
  const raw = args.payloads.map((payload, index) => {
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
      index,
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
  const raw = args.payloads.map((payload, index) =>
    rawObject({
      provider: 'anthropic',
      source: 'anthropic_gateway_response',
      sourceKind: 'gateway_reported',
      payload,
      index,
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

export function billingRowsFromItems(args: {
  runId: string
  sessionId?: string
  cwd?: string
  items: TraceEvent[]
  nowMs: number
  billingProvider?: BillingProvider
  runtimeProvider?: RuntimeProvider
  gateway?: { provider: 'anthropic'; accountLabel: string } | null
  priceVersions?: LocalModelPriceVersion[]
}): BillingLedgerRows {
  return { providerRawUsage: [], usageLedger: sdkUsageLedgerRowsFromItems(args).map(usageLedgerObjectToRow) }
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
