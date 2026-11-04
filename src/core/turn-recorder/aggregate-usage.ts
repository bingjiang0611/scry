import { canonicalCostUsd, type TurnUsage } from '../../shared/turn-record.js'
import { contextUsageEvidence, type TraceEvent } from '../../shared/trace.js'
import { providerUsageResultEvents } from '../../shared/result-timing.js'
import { isCreditUsageEvidence } from '../../shared/credit-usage.js'

function sumObserved(events: TraceEvent[], pick: (event: TraceEvent) => number | undefined): number | undefined {
  const values = events.map(pick).filter((value): value is number => value != null && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined
}

function sumCostUsd(events: TraceEvent[]): number | undefined {
  const values = events.map((event) => event.costUsd).filter((value): value is number => value != null)
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) return undefined
  return canonicalCostUsd(values.reduce((sum, value) => sum + value, 0))
}

export function usageFrom(events: TraceEvent[]): TurnUsage | undefined {
  const results = providerUsageResultEvents(events)
  // Credits are one run-scoped snapshot, not incremental result counters. Replayed
  // snapshots replace each other and must never be summed with USD or with a shadow.
  const credits = [...events].reverse().find((event) => event.kind === 'harness' && event.stage === 'credit_usage' &&
    !event.agentId && isCreditUsageEvidence(event.creditUsage))?.creditUsage
  if (!results.length && !credits) return undefined
  const models = new Set(results.flatMap((event) => event.modelUsage ?? []).map((row) => row.model).filter(Boolean))
  const contextResult = [...results].reverse().find((event) => event.contextTokens != null)
  const context = contextResult ? contextUsageEvidence(contextResult) : null
  return {
    inputTokens: sumObserved(results, (event) => event.tokensIn),
    outputTokens: sumObserved(results, (event) => event.tokensOut),
    cacheReadTokens: sumObserved(results, (event) => event.cacheReadTokens),
    cacheCreationTokens: sumObserved(results, (event) => event.cacheCreationTokens),
    reasoningTokens: sumObserved(results, (event) => event.reasoningTokens),
    costUsd: sumCostUsd(results),
    ...(credits ? { credits } : {}),
    apiDurationMs: sumObserved(results, (event) => event.durationApiMs),
    ...(contextResult ? {
      contextTokens: contextResult.contextTokens,
      ...(contextResult.contextModel ? { contextModel: contextResult.contextModel } : {}),
      ...(contextResult.contextProvider ? { contextProvider: contextResult.contextProvider } : {}),
      contextUsageSource: contextResult.contextUsageSource ?? 'legacy_unattributed_context',
      contextUsageQuality: contextResult.contextUsageQuality ?? 'inferred'
    } : {}),
    ...(context ? {
      contextWindow: context.window,
      contextModel: context.model,
      ...(context.provider ? { contextProvider: context.provider } : {})
    } : {}),
    ...(models.size === 1 ? { model: [...models][0] } : {})
  }
}
