import { billingProviderForUpstream } from '../../shared/billing'
import type { ModelUsageRow, TraceEvent } from '../../shared/trace'
import { number, record, type JsonRecord } from './pi-shared'

interface UsageAggregate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  cost: number
  allCostKnown: boolean
  byModel: Map<string, ModelUsageRow>
  lastContextTokens?: number
  lastContextModel?: string
  lastContextProvider?: string
  contextUsageSource?: string
  contextUsageQuality?: 'exact' | 'inferred'
  lastStopReason?: string
  lastError?: string
  lastTransportError?: string
  upstreamProvider?: string
  model?: string
}

/**
 * Pi stamps an assistant message when its request is created; message_end arrives when the response
 * is complete. Their difference is one call's local time, including first-token wait. The first
 * message_update is the first content block (text, thinking or tool call), so it marks the first token.
 * Errored or aborted calls are retried by Pi and must not count as generation speed.
 */
function piLlmCall(message: JsonRecord, endedAtMs: number, firstContentAtMs: number | undefined): Pick<TraceEvent, 'llmCall'> {
  const startedAtMs = number(message.timestamp)
  const outputTokens = number(record(message.usage).output)
  const completed = message.stopReason === 'stop' || message.stopReason === 'toolUse' || message.stopReason === 'length'
  if (!completed || startedAtMs == null || outputTokens == null || outputTokens <= 0 || endedAtMs <= startedAtMs) return {}
  const firstTokenMs = firstContentAtMs != null && firstContentAtMs >= startedAtMs && firstContentAtMs <= endedAtMs
    ? firstContentAtMs - startedAtMs : undefined
  return { llmCall: {
    outputTokens,
    durationMs: endedAtMs - startedAtMs,
    ...(firstTokenMs != null ? { firstTokenMs } : {}),
    ...(typeof message.model === 'string' ? { model: message.model } : {})
  } }
}

function addAssistantUsage(
  aggregate: UsageAggregate,
  message: JsonRecord,
  contextWindows: ReadonlyMap<string, number>
): boolean {
  const usage = record(message.usage)
  const input = number(usage.input)
  const output = number(usage.output)
  const cacheRead = number(usage.cacheRead)
  const cacheWrite = number(usage.cacheWrite)
  const reasoning = number(usage.reasoning)
  const model = typeof message.model === 'string' ? message.model : 'unknown'
  const provider = typeof message.provider === 'string' ? message.provider : undefined
  // Pi's catalogue cost is an estimate, not a reported charge. A zero can be
  // an unpriced custom model (e.g. cc-switch), not evidence of free usage.
  // Qoder uses separate request-level Credits, never its USD placeholder.
  const catalogueCost = number(record(usage.cost).total)
  const cost = provider === 'qoder' || catalogueCost === 0 ? undefined : catalogueCost
  const key = `${provider ?? ''}\0${model}`
  aggregate.input += input ?? 0
  aggregate.output += output ?? 0
  aggregate.cacheRead += cacheRead ?? 0
  aggregate.cacheWrite += cacheWrite ?? 0
  aggregate.reasoning += reasoning ?? 0
  const contextEvidence = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  // Pi normalizes input/cacheRead/cacheWrite into disjoint counts, including for OpenAI/Codex.
  // Cached tokens still occupy context. All-zero transport failures are not context samples.
  if (contextEvidence > 0) {
    aggregate.lastContextTokens = contextEvidence
    aggregate.lastContextModel = model
    aggregate.lastContextProvider = provider
    aggregate.contextUsageSource = 'pi_rpc_assistant_usage'
    aggregate.contextUsageQuality = 'exact'
  }
  if (cost == null) aggregate.allCostKnown = false
  else aggregate.cost += cost
  const existing = aggregate.byModel.get(key) ?? {
    model,
    billingProvider: billingProviderForUpstream(provider),
    upstreamProvider: provider,
    usageSource: 'pi_rpc'
  }
  existing.contextWindow = contextWindows.get(key) ?? existing.contextWindow
  existing.inputTokens = (existing.inputTokens ?? 0) + (input ?? 0)
  existing.outputTokens = (existing.outputTokens ?? 0) + (output ?? 0)
  existing.cacheReadTokens = (existing.cacheReadTokens ?? 0) + (cacheRead ?? 0)
  existing.cacheCreationTokens = (existing.cacheCreationTokens ?? 0) + (cacheWrite ?? 0)
  existing.reasoningTokens = (existing.reasoningTokens ?? 0) + (reasoning ?? 0)
  if (cost != null) {
    existing.costUsd = (existing.costUsd ?? 0) + cost
    existing.costSource = 'price_table'
    existing.costConfidence = 'estimated'
    existing.costUnit = 'usd'
  }
  aggregate.byModel.set(key, existing)
  aggregate.upstreamProvider = provider
  aggregate.model = model
  aggregate.lastStopReason = typeof message.stopReason === 'string' ? message.stopReason : aggregate.lastStopReason
  aggregate.lastError = typeof message.errorMessage === 'string' ? message.errorMessage : aggregate.lastError
  if (Array.isArray(message.diagnostics)) {
    for (const rawDiagnostic of message.diagnostics) {
      const diagnostic = record(rawDiagnostic)
      if (diagnostic.type !== 'provider_transport_failure') continue
      const diagnosticError = record(diagnostic.error)
      if (typeof diagnosticError.message === 'string' && diagnosticError.message.trim()) {
        aggregate.lastTransportError = diagnosticError.message.trim()
      }
    }
  }
  return contextEvidence > 0
}


export type { UsageAggregate }
export { piLlmCall, addAssistantUsage }
