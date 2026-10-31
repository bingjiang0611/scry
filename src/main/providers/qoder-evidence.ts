import type { Query } from '@qoder-ai/qoder-agent-sdk'
import { contextUsageEvidence, type TraceEvent } from '../../shared/trace'
import type { ParsedTurn } from '../normalize'
import { qoderRecord } from './qoder-shared'

const QODER_CONTEXT_USAGE_TIMEOUT_MS = 2_000

export interface QoderContextEvidence {
  contextTokens: number
  contextWindow: number
  model?: string
  percentage?: number
  rawContextWindow?: number
  source: 'qoder_control' | 'qoder_native_transcript'
  quality: 'exact' | 'inferred'
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function qoderControlContext(value: unknown): QoderContextEvidence | undefined {
  const raw = qoderRecord(value)
  const contextTokens = finiteNumber(raw.totalTokens)
  const contextWindow = finiteNumber(raw.maxTokens)
  if (contextTokens == null || contextTokens < 0 || contextWindow == null || contextWindow <= 0) return undefined
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined
  return {
    contextTokens,
    contextWindow,
    ...(model ? { model } : {}),
    ...(finiteNumber(raw.percentage) != null ? { percentage: finiteNumber(raw.percentage) } : {}),
    ...(finiteNumber(raw.rawMaxTokens) != null ? { rawContextWindow: finiteNumber(raw.rawMaxTokens) } : {}),
    source: 'qoder_control',
    quality: 'exact'
  }
}

export function qoderContextTokensFromUsage(value: unknown): number {
  return finiteNumber(qoderRecord(value).input_tokens) ?? 0
}

export function qoderTranscriptContexts(messages: unknown[]): Array<QoderContextEvidence & { ts: number }> {
  const contexts: Array<QoderContextEvidence & { ts: number }> = []
  for (const value of messages) {
    const raw = qoderRecord(value)
    if (raw.type !== 'assistant') continue
    const ts = typeof raw.timestamp === 'string' ? new Date(raw.timestamp).getTime() : finiteNumber(raw.timestamp)
    if (ts == null || !Number.isFinite(ts)) continue
    const message = qoderRecord(raw.message)
    const usage = qoderRecord(message.usage)
    // Qoder 的 input_tokens 已是当前完整 prompt；cache_read_input_tokens 是其中的复用子集，
    // 与 input_tokens 相加会重复计算。原生 context_usage_ratio 也直接以 input_tokens 为分子。
    const contextTokens = finiteNumber(usage.input_tokens)
    const ratio = finiteNumber(usage.context_usage_ratio)
    if (contextTokens == null || contextTokens < 0 || ratio == null || ratio <= 0) continue
    const contextWindow = Math.round(contextTokens / ratio)
    if (contextWindow <= 0) continue
    const model = typeof message.model === 'string' && message.model.trim() ? message.model.trim() : undefined
    contexts.push({
      ts,
      contextTokens,
      contextWindow,
      ...(model ? { model } : {}),
      percentage: ratio * 100,
      source: 'qoder_native_transcript',
      quality: 'inferred'
    })
  }
  return contexts
}

export function withQoderContext(event: TraceEvent, evidence: QoderContextEvidence | undefined): TraceEvent {
  if (!evidence || event.kind !== 'harness' || event.stage !== 'result') return event
  const existing = contextUsageEvidence(event)
  const genericSource = event.contextUsageSource === 'provider_usage' || event.contextUsageSource === 'provider_transcript'
  if (evidence.quality === 'inferred' && !genericSource && (existing || event.contextUsageQuality === 'exact')) return event
  const rows = event.modelUsage?.length
    ? event.modelUsage
    : [{ model: evidence.model ?? 'unknown' }]
  let attached = false
  const canAttachWithoutModel = !evidence.model && rows.length === 1
  const modelUsage = rows.map((row) => {
    if (attached || (!canAttachWithoutModel && row.model !== evidence.model)) return row
    attached = true
    return { ...row, contextWindow: evidence.contextWindow }
  })
  if (!attached && evidence.model) modelUsage.push({ model: evidence.model, contextWindow: evidence.contextWindow })
  return {
    ...event,
    contextTokens: evidence.contextTokens,
    contextModel: evidence.model ?? (modelUsage.length === 1 ? modelUsage[0].model : undefined),
    contextUsageSource: evidence.source,
    contextUsageQuality: evidence.quality,
    modelUsage,
    runtimeMetadata: {
      ...(event.runtimeMetadata ?? {}),
      ...(evidence.percentage != null ? { contextUsagePercentage: evidence.percentage } : {}),
      ...(evidence.rawContextWindow != null ? { rawContextWindow: evidence.rawContextWindow } : {})
    }
  }
}

export function enrichQoderHistory(turns: ParsedTurn[], messages: unknown[]): ParsedTurn[] {
  const contexts = qoderTranscriptContexts(messages)
  if (contexts.length === 0) return turns
  let previousEnd = Number.NEGATIVE_INFINITY
  return turns.map((turn) => {
    const timestamps = turn.items.map((event) => new Date(event.ts).getTime()).filter(Number.isFinite)
    if (timestamps.length === 0) return turn
    const end = Math.max(...timestamps)
    const evidence = [...contexts].reverse().find((context) => context.ts > previousEnd && context.ts <= end)
    previousEnd = end
    if (!evidence) return turn
    return {
      ...turn,
      items: turn.items.map((event) => withQoderContext(event, evidence))
    }
  })
}

export async function qoderLiveContext(query: Query): Promise<QoderContextEvidence | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const value = await Promise.race([
      query.getContextUsage(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), QODER_CONTEXT_USAGE_TIMEOUT_MS)
      })
    ])
    return qoderControlContext(value)
  } catch {
    return undefined
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function qoderTrace(event: TraceEvent, contextEvidence?: QoderContextEvidence): TraceEvent {
  if (event.kind === 'hook') {
    return {
      ...event,
      hookCommand: event.hookCommand ?? event.hookName,
      runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk' }
    }
  }
  if (event.kind !== 'harness' || event.stage !== 'result') return event
  const reportedTokens = [event.tokensIn, event.tokensOut, event.cacheReadTokens, event.cacheCreationTokens, event.reasoningTokens]
  const reportedZeroUsage = reportedTokens.some((value) => value != null) && reportedTokens.every((value) => value == null || value === 0)
  const normalized = {
    ...event,
    tokensIn: reportedZeroUsage ? undefined : event.tokensIn,
    tokensOut: reportedZeroUsage ? undefined : event.tokensOut,
    cacheReadTokens: reportedZeroUsage ? undefined : event.cacheReadTokens,
    cacheCreationTokens: reportedZeroUsage ? undefined : event.cacheCreationTokens,
    reasoningTokens: reportedZeroUsage ? undefined : event.reasoningTokens,
    costUsd: undefined,
    costSource: undefined,
    costConfidence: undefined,
    costUnit: undefined,
    modelUsage: event.modelUsage?.map((usage) => {
      const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheCreationTokens, usage.reasoningTokens]
      const zero = values.some((value) => value != null) && values.every((value) => value == null || value === 0)
      return {
        ...usage,
        inputTokens: zero ? undefined : usage.inputTokens,
        outputTokens: zero ? undefined : usage.outputTokens,
        cacheReadTokens: zero ? undefined : usage.cacheReadTokens,
        cacheCreationTokens: zero ? undefined : usage.cacheCreationTokens,
        reasoningTokens: zero ? undefined : usage.reasoningTokens,
        costUsd: undefined,
        costSource: undefined,
        costConfidence: undefined,
        costUnit: undefined,
        billingProvider: 'qoder' as const,
        upstreamProvider: 'qoder',
        usageSource: 'qoder_sdk'
      }
    }),
    contextProvider: event.contextTokens != null ? 'qoder' : undefined,
    contextUsageSource: event.contextTokens != null ? 'qoder_sdk_usage' : undefined,
    contextUsageQuality: event.contextTokens != null ? 'exact' as const : undefined,
    runtimeMetadata: { ...(event.runtimeMetadata ?? {}), source: 'qoder_sdk', billingProvider: 'qoder', reportedZeroUsage },
    billingProvider: 'qoder' as const,
    upstreamProvider: 'qoder',
    usageSource: 'qoder_sdk'
  }
  return withQoderContext(normalized, contextEvidence)
}
