import { billingProviderForUpstream } from '../../shared/billing'
import {
  eventState,
  newEvent,
  openCodeMessageId,
  openCodeMessageParentId,
  openCodeCompletedAt,
  openCodeMessageRole,
  openCodeResultTiming,
  record
} from './opencode-records'
import type { ModelUsageRow } from '../../shared/trace'
import type { ProviderRunRequest } from './types'

interface OpenCodeTurnAggregate {
  providerTurnId?: string
  timing?: { ts: string; durationMs: number }
  contextTokens?: number
  contextModel?: string
  contextProvider?: string
  contextUsageSource?: string
  contextUsageQuality?: 'exact' | 'inferred'
  tokensIn?: number
  tokensOut?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  modelUsage?: ModelUsageRow[]
  messageCount: number
  timingBoundary: 'user_message' | 'assistant_chain' | 'final_message'
  messageCoverage: 'observed_chain' | 'final_message_only'
}

export function aggregateOpenCodeTurn(
  finalInfo: Record<string, unknown>,
  observedMessages: Map<string, Record<string, unknown>>,
  contextWindows: ReadonlyMap<string, number> = new Map()
): OpenCodeTurnAggregate {
  const messages = new Map(observedMessages)
  const finalId = openCodeMessageId(finalInfo)
  if (finalId) messages.set(finalId, finalInfo)
  const parentId = openCodeMessageParentId(finalInfo)
  const assistants = parentId
    ? [...messages.values()].filter((info) =>
        openCodeMessageRole(info) === 'assistant' && openCodeMessageParentId(info) === parentId
      )
    : [finalInfo]
  if (finalId && !assistants.some((info) => openCodeMessageId(info) === finalId)) assistants.push(finalInfo)
  assistants.sort((left, right) => {
    const leftCreated = record(left.time).created
    const rightCreated = record(right.time).created
    const leftMs = typeof leftCreated === 'number' && Number.isFinite(leftCreated) ? leftCreated : Number.MAX_SAFE_INTEGER
    const rightMs = typeof rightCreated === 'number' && Number.isFinite(rightCreated) ? rightCreated : Number.MAX_SAFE_INTEGER
    return leftMs - rightMs || String(openCodeMessageId(left) ?? '').localeCompare(String(openCodeMessageId(right) ?? ''))
  })

  let tokensIn = 0
  let tokensOut = 0
  let reasoningTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let hasUsage = false
  let costUsd = 0
  let hasCompleteCost = assistants.length > 0
  const modelRows = new Map<string, ModelUsageRow>()
  const modelCosts = new Map<string, { total: number; complete: boolean }>()
  let latestContext: { tokens: number; model: string; provider: string } | undefined
  for (const info of assistants) {
    const tokens = record(info.tokens)
    const cache = record(tokens.cache)
    const input = typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : undefined
    const output = typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : undefined
    const reasoning = typeof tokens.reasoning === 'number' && Number.isFinite(tokens.reasoning) ? tokens.reasoning : undefined
    const cacheRead = typeof cache.read === 'number' && Number.isFinite(cache.read) ? cache.read : undefined
    const cacheWrite = typeof cache.write === 'number' && Number.isFinite(cache.write) ? cache.write : undefined
    if ([input, output, reasoning, cacheRead, cacheWrite].some((value) => value != null)) {
      hasUsage = true
      tokensIn += input ?? 0
      tokensOut += output ?? 0
      reasoningTokens += reasoning ?? 0
      cacheReadTokens += cacheRead ?? 0
      cacheCreationTokens += cacheWrite ?? 0
    }
    const cost = typeof info.cost === 'number' && Number.isFinite(info.cost) ? info.cost : undefined
    if (cost == null) hasCompleteCost = false
    else costUsd += cost

    const model = typeof info.modelID === 'string' && info.modelID ? info.modelID : undefined
    if (!model) continue
    const upstream = typeof info.providerID === 'string' ? info.providerID : ''
    const key = `${upstream}\0${model}`
    const current = modelRows.get(key) ?? {
      model,
      billingProvider: billingProviderForUpstream(upstream),
      upstreamProvider: upstream || undefined,
      usageSource: 'opencode_turn_messages'
    }
    current.contextWindow = contextWindows.get(key) ?? current.contextWindow
    if ([input, cacheRead, cacheWrite].some((value) => value != null)) {
      latestContext = {
        tokens: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
        model,
        provider: upstream
      }
    }
    current.inputTokens = (current.inputTokens ?? 0) + (input ?? 0)
    current.outputTokens = (current.outputTokens ?? 0) + (output ?? 0)
    current.reasoningTokens = (current.reasoningTokens ?? 0) + (reasoning ?? 0)
    current.cacheReadTokens = (current.cacheReadTokens ?? 0) + (cacheRead ?? 0)
    current.cacheCreationTokens = (current.cacheCreationTokens ?? 0) + (cacheWrite ?? 0)
    modelRows.set(key, current)
    const modelCost = modelCosts.get(key) ?? { total: 0, complete: true }
    if (cost == null) modelCost.complete = false
    else modelCost.total += cost
    modelCosts.set(key, modelCost)
  }
  for (const [key, row] of modelRows) {
    const cost = modelCosts.get(key)
    if (cost?.complete) {
      row.costUsd = cost.total
      row.costSource = 'provider_reported'
      row.costConfidence = 'provider_reported'
      row.costUnit = 'usd'
    }
  }

  const completed = assistants
    .map((info) => openCodeCompletedAt(info))
    .filter((value): value is number => value != null)
  const created = assistants
    .map((info) => record(info.time).created)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const userInfo = parentId ? messages.get(parentId) : undefined
  const userCreated = userInfo && openCodeMessageRole(userInfo) === 'user'
    ? record(userInfo.time).created
    : undefined
  const startedAt = typeof userCreated === 'number' && Number.isFinite(userCreated)
    ? userCreated
    : created.length > 0
      ? Math.min(...created)
      : undefined
  const completedAt = completed.length > 0 ? Math.max(...completed) : undefined
  const timing = startedAt != null && completedAt != null && completedAt >= startedAt
    ? { ts: new Date(completedAt).toISOString(), durationMs: completedAt - startedAt }
    : openCodeResultTiming(finalInfo)
  const timingBoundary: OpenCodeTurnAggregate['timingBoundary'] =
    typeof userCreated === 'number' && Number.isFinite(userCreated)
      ? 'user_message'
      : assistants.length > 1
        ? 'assistant_chain'
        : 'final_message'

  return {
    providerTurnId: parentId ?? finalId,
    timing,
    ...(latestContext ? {
      contextTokens: latestContext.tokens,
      contextModel: latestContext.model,
      contextProvider: latestContext.provider,
      contextUsageSource: 'opencode_message_usage',
      contextUsageQuality: 'exact' as const
    } : {}),
    tokensIn: hasUsage ? tokensIn : undefined,
    tokensOut: hasUsage ? tokensOut : undefined,
    reasoningTokens: hasUsage ? reasoningTokens : undefined,
    cacheReadTokens: hasUsage ? cacheReadTokens : undefined,
    cacheCreationTokens: hasUsage ? cacheCreationTokens : undefined,
    costUsd: hasCompleteCost ? costUsd : undefined,
    modelUsage: modelRows.size > 0 ? [...modelRows.values()] : undefined,
    messageCount: assistants.length,
    timingBoundary,
    messageCoverage: parentId && (messages.has(parentId) || assistants.length > 1)
      ? 'observed_chain'
      : 'final_message_only'
  }
}

export function emitOpenCodeResponseParts(
  request: ProviderRunRequest,
  parts: unknown[],
  messageId: string | undefined
): void {
  const textByMessage = new Map<string | undefined, string[]>()
  for (const rawPart of parts) {
    const part = record(rawPart)
    if (part.type !== 'text' || part.ignored === true || typeof part.text !== 'string' || !part.text) continue
    const partMessageId = typeof part.messageID === 'string' ? part.messageID : messageId
    const text = textByMessage.get(partMessageId) ?? []
    text.push(part.text)
    textByMessage.set(partMessageId, text)
  }
  for (const [partMessageId, textParts] of textByMessage) {
    const text = textParts.join('')
    const streamed = partMessageId ? eventState(request).streamedTextByMessageId.get(partMessageId) : undefined
    if (streamed === text) continue
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text',
      text,
      messageId: partMessageId,
      runtimeMetadata: {
        source: 'opencode_response_parts',
        ...(streamed === undefined ? {} : { replacesStreamedText: true })
      }
    }))
  }
  if (textByMessage.size === 0 && messageId && eventState(request).streamedTextByMessageId.has(messageId)) {
    request.emit(newEvent(request.runId, {
      kind: 'model',
      stage: 'text',
      text: '',
      messageId,
      runtimeMetadata: { source: 'opencode_response_parts', replacesStreamedText: true }
    }))
  }
}

export function emitOpenCodeTurnResponseParts(
  request: ProviderRunRequest,
  rows: Array<{ info?: unknown; parts?: unknown }> | undefined,
  finalInfo: Record<string, unknown>,
  finalParts: unknown[]
): void {
  const parentId = openCodeMessageParentId(finalInfo)
  const finalId = openCodeMessageId(finalInfo)
  if (!rows || !parentId) {
    emitOpenCodeResponseParts(request, finalParts, finalId)
    return
  }
  const assistants = rows
    .map((row) => ({ info: record(row.info), parts: Array.isArray(row.parts) ? row.parts : [] }))
    .filter(({ info }) => openCodeMessageRole(info) === 'assistant' && openCodeMessageParentId(info) === parentId)
    .sort((left, right) => {
      const leftTime = record(left.info.time)
      const rightTime = record(right.info.time)
      const leftCreated = typeof leftTime.created === 'number' ? leftTime.created : Number.POSITIVE_INFINITY
      const rightCreated = typeof rightTime.created === 'number' ? rightTime.created : Number.POSITIVE_INFINITY
      return leftCreated - rightCreated || String(openCodeMessageId(left.info) ?? '').localeCompare(String(openCodeMessageId(right.info) ?? ''))
    })
  let emittedFinal = false
  for (const assistant of assistants) {
    const messageId = openCodeMessageId(assistant.info)
    const parts = assistant.parts.length > 0 || messageId !== finalId ? assistant.parts : finalParts
    if (parts.length === 0 && !eventState(request).streamedTextByMessageId.has(messageId ?? '')) continue
    emitOpenCodeResponseParts(request, parts, messageId)
    if (messageId === finalId) emittedFinal = true
  }
  if (!emittedFinal) emitOpenCodeResponseParts(request, finalParts, finalId)
}