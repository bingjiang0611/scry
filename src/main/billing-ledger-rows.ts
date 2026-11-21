import type { ProviderRawUsageObject, UsageLedgerObject } from '../shared/billing'

export interface BillingLedgerRows {
  providerRawUsage: unknown[][]
  usageLedger: unknown[][]
}

const toJson = (v: unknown): string => JSON.stringify(v ?? {})

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
