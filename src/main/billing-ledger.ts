import { billingProviderForUpstream } from '../shared/billing'
import { estimatedCostFromPrice, type ModelPrice } from '../shared/model-price'
import type {
  BillingConfidence,
  BillingCostSource,
  BillingProvider,
  BillingSourceKind,
  UsageLedgerObject
} from '../shared/billing'
import type { TraceEvent } from '../shared/trace'
import { providerUsageResultEvents } from '../shared/result-timing'
import { isCreditUsageEvidence } from '../shared/credit-usage'
import type { RuntimeProvider } from '../shared/runtime'
import {
  usageLedgerObjectToRow,
  type BillingLedgerRows
} from './billing-ledger-rows'

export {
  billingRowsFromAdminPayload,
  billingRowsFromAnthropicGatewayPayload,
  reconcileUsageLedger
} from './billing-ledger-admin'
export { providerRawUsageObjectToRow, usageLedgerObjectToRow, type BillingLedgerRows } from './billing-ledger-rows'

export interface LocalModelPriceVersion extends ModelPrice {
  provider: BillingProvider
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
  const isAntigravityMissingCost = (provider: BillingProvider, cost: number | null | undefined, usageSource?: string): boolean =>
    (provider === 'antigravity' || usageSource === 'antigravity_acp' || args.runtimeProvider === 'antigravity_acp' || result.runtimeProvider === 'antigravity_acp') &&
    cost == null
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
      const missingAgyCost = isAntigravityMissingCost(provider, mu.costUsd ?? null, usageSource)
      const costUnit = missingAgyCost ? 'token' : (mu.costUnit ?? result.costUnit ?? 'usd')
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
            usageSource: mu.usageSource ?? result.usageSource ?? null,
            ...(missingAgyCost ? { costStatus: 'unavailable' } : {})
          }
        }),
        createdTs: args.nowMs
      })
    }
    return estimateRows(rows, args.priceVersions)
  }
  const provider = fallbackProvider
  const missingAgyCost = isAntigravityMissingCost(provider, result.costUsd ?? null, result.usageSource)
  const costUnit = missingAgyCost ? 'token' : (result.costUnit ?? 'usd')
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
        usageSource: result.usageSource ?? null,
        ...(missingAgyCost ? { costStatus: 'unavailable' } : {})
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
    if (!price) return row
    const cost = estimatedCostFromPrice({ ...row, provider: row.provider }, price)
    if (cost == null) return row
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
