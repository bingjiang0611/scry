import { billingProviderForUpstream } from '../shared/billing'
import type {
  BillingConfidence,
  BillingCostSource,
  BillingProvider,
  BillingSourceKind,
  ProviderRawUsageObject,
  UsageLedgerObject
} from '../shared/billing'
import type { TraceEvent } from '../shared/trace'
import { providerUsageResultEvents } from '../shared/result-timing'
import { isCreditUsageEvidence } from '../shared/credit-usage'
import type { RuntimeProvider } from '../shared/runtime'

export {
  billingRowsFromAdminPayload,
  billingRowsFromAnthropicGatewayPayload,
  reconcileUsageLedger
} from './billing-ledger-admin'

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

const toJson = (v: unknown): string => JSON.stringify(v ?? {})

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
  const results = providerUsageResultEvents(args.items)
  if (results.length > 1) {
    return results.flatMap((result) => sdkUsageLedgerRowsFromItems({ ...args, items: [result] }))
  }
  const result = results[0]
  if (!result) return []
  const fallbackProvider = result.billingProvider ?? args.billingProvider ??
    billingProviderForUpstream(result.upstreamProvider) ?? 'unknown'
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
      const piRuntime = (args.runtimeProvider ?? result.runtimeProvider) === 'pi_rpc' || result.usageSource === 'pi_rpc'
      const provider = mu.billingProvider ?? (piRuntime ? billingProviderForUpstream(mu.upstreamProvider) : undefined) ?? fallbackProvider
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
  const rows = sdkUsageLedgerRowsFromItems(args)
  const snapshot = [...args.items].reverse().find((event) => event.kind === 'harness' && event.stage === 'credit_usage' &&
    !event.agentId && isCreditUsageEvidence(event.creditUsage))
  if (snapshot) {
    const evidence = snapshot.creditUsage!
    const ts = Date.parse(snapshot.ts)
    rows.push({
      id: `qoder:credits:${args.runId}`, provider: 'qoder', source: evidence.source.join('+'),
      sourceKind: 'provider_reported', sessionId: args.sessionId, runId: args.runId,
      projectKey: args.cwd, bucketStart: Number.isFinite(ts) ? ts : args.nowMs,
      usageKind: 'credits', cost: evidence.value!.amount ?? null, costUnit: 'credits',
      costSource: 'provider_reported', confidence: 'provider_reported', attributionMethod: 'direct',
      metadata: { creditUsage: evidence }, createdTs: args.nowMs
    })
  }
  return { providerRawUsage: [], usageLedger: rows.map(usageLedgerObjectToRow) }
}
