import type { TraceEvent } from '@shared/trace'

export type TimingSource = 'provider' | 'observed' | 'unknown'

export interface TimedTurnCall {
  id: string
  lifecycleId?: string
  category: string
  label: string
  event: TraceEvent
  result?: TraceEvent
  order: number
  startMs?: number
  endMs?: number
  durationMs?: number
  durationSource: TimingSource
  messageId?: string
  nested: boolean
}

export interface TurnTimingAggregate {
  category: string
  count: number
  timedCount: number
  totalMs: number
  averageMs?: number
  maxMs?: number
}

export interface ModelResponsePhase {
  id: string
  sequence: number
  messageId?: string
  kind: 'response' | 'final' | 'tail' | 'unsegmented'
  tailMode?: 'cleanup' | 'unknown'
  observedMs?: number
  toolMs?: number
  timedTools: number
  callsAfterResponse: TimedTurnCall[]
}

export interface TurnTimingBreakdown {
  wallMs?: number
  apiMs?: number
  apiSource: TimingSource
  apiObservation?: 'phase' | 'residual'
  timedApiPhases: number
  totalApiPhases: number
  totalCalls: number
  timedCalls: number
  cumulativeCallMs: number
  occupiedCallMs?: number
  overlapCallMs?: number
  aggregates: TurnTimingAggregate[]
  phases: ModelResponsePhase[]
  unassignedCalls: TimedTurnCall[]
  nestedCalls: TimedTurnCall[]
}

function timestampMs(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function finiteDuration(value?: number): number | undefined {
  return value != null && Number.isFinite(value) && value >= 0 ? value : undefined
}

function callCategory(event: TraceEvent): string {
  if (event.isMcp) return 'MCP'
  if (event.kind === 'skill') return 'Skill'
  if (event.kind === 'agent') return '子Agent'
  return event.tool ?? event.name ?? event.stage.replace(/^tool:/, '')
}

function callLabel(event: TraceEvent, category: string): string {
  if (event.isMcp) {
    const server = event.mcpServer ?? 'mcp'
    return event.mcpAction ? `${server}.${event.mcpAction}` : server
  }
  if (event.kind === 'skill' || event.kind === 'agent') return event.name ?? category
  return event.tool ?? event.name ?? category
}

function intervalUnionMs(calls: TimedTurnCall[]): number | undefined {
  const intervals = calls
    .filter(
      (call): call is TimedTurnCall & { startMs: number; endMs: number } =>
        call.startMs != null && call.endMs != null && call.endMs >= call.startMs
    )
    .map((call) => [call.startMs, call.endMs] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (intervals.length === 0) return undefined

  let total = 0
  let [start, end] = intervals[0]
  for (let index = 1; index < intervals.length; index++) {
    const [nextStart, nextEnd] = intervals[index]
    if (nextStart <= end) {
      end = Math.max(end, nextEnd)
      continue
    }
    total += end - start
    start = nextStart
    end = nextEnd
  }
  return total + end - start
}

function isInferenceOnlyCall(call: TimedTurnCall): boolean {
  if (call.event.kind !== 'skill' || call.durationSource !== 'unknown') return false
  const input = call.event.input as Record<string, unknown> | undefined
  const source = typeof input?.source === 'string' ? input.source : undefined
  return source === 'skill_file' || source === 'skill_path_in_bash' || source === 'skill_path_in_command'
}

function latestEnd(calls: TimedTurnCall[]): number | undefined {
  const lifecycles = new Map<string, number[]>()
  for (const call of calls) {
    // 由 Read/Bash 路径推断出的 Skill 是语义证据，不是额外 runtime lifecycle；
    // 它可计入 Skill 调用，但不能让下一次模型等待变成 unknown。
    if (isInferenceOnlyCall(call)) continue
    const id = call.lifecycleId ?? `event:${call.id}`
    const ends = lifecycles.get(id) ?? []
    if (call.endMs != null) ends.push(call.endMs)
    lifecycles.set(id, ends)
  }
  if (lifecycles.size === 0) return undefined
  const ends: number[] = []
  for (const lifecycleEnds of lifecycles.values()) {
    if (lifecycleEnds.length === 0) return undefined
    ends.push(Math.max(...lifecycleEnds))
  }
  return Math.max(...ends)
}

function observedGap(startMs?: number, endMs?: number): number | undefined {
  if (startMs == null || endMs == null || endMs < startMs) return undefined
  return endMs - startMs
}

/**
 * 派生一轮的诊断耗时，不回写 TraceEvent：
 * - 合并后的 result duration 用于整轮/API 合计；
 * - 工具优先采用自身或对应 result 的 durationMs，否则以 tool_use.ts→tool_result.ts 推算；
 * - messageId 只作为模型响应批次边界，单次 observedMs 是观测间隔，不冒充 API 原值。
 */
export function buildTurnTimingBreakdown(
  items: TraceEvent[],
  logicalCalls: TraceEvent[],
  consolidatedResult?: TraceEvent
): TurnTimingBreakdown {
  const resultEvent =
    consolidatedResult ?? [...items].reverse().find((event) => event.kind === 'harness' && event.stage === 'result')
  const resultsByToolUseId = new Map<string, TraceEvent[]>()
  const itemOrder = new Map<TraceEvent, number>()
  items.forEach((event, index) => {
    itemOrder.set(event, index)
    if (event.stage === 'tool_result' && event.toolUseId) {
      const results = resultsByToolUseId.get(event.toolUseId) ?? []
      results.push(event)
      resultsByToolUseId.set(event.toolUseId, results)
    }
  })

  const callEvents = logicalCalls.filter(
    (event) => event.stage !== 'tool_result' && (event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')
  )
  const lifecycleOwner = new Map<string, TraceEvent>()
  for (const event of callEvents) {
    if (!event.toolUseId) continue
    const owner = lifecycleOwner.get(event.toolUseId)
    // 路径推断 Skill 与实际 Bash 可能共享 toolUseId；耗时只归实际 runtime call，避免双计。
    if (!owner || (owner.kind === 'skill' && event.kind === 'tool')) lifecycleOwner.set(event.toolUseId, event)
  }

  const calls = callEvents
    .map((event, logicalIndex): TimedTurnCall => {
      const startMs = timestampMs(event.ts)
      const ownsLifecycle = !!event.toolUseId && lifecycleOwner.get(event.toolUseId) === event
      const result = ownsLifecycle
        ? (resultsByToolUseId.get(event.toolUseId as string) ?? []).find((candidate) => {
            const candidateOrder = itemOrder.get(candidate)
            return candidateOrder == null || candidateOrder > (itemOrder.get(event) ?? -1)
          })
        : undefined
      const providerDuration =
        ownsLifecycle || !event.toolUseId
          ? finiteDuration(result?.durationMs) ?? finiteDuration(event.durationMs)
          : undefined
      const resultEndMs = timestampMs(result?.ts)
      const validResultEndMs =
        resultEndMs != null && (startMs == null || resultEndMs >= startMs) ? resultEndMs : undefined
      const endMs =
        validResultEndMs ??
        (startMs != null && providerDuration != null ? startMs + providerDuration : undefined)
      const observedDuration =
        startMs != null && endMs != null && endMs >= startMs ? endMs - startMs : undefined
      const durationMs = providerDuration ?? observedDuration
      const category = callCategory(event)
      return {
        id: event.id,
        lifecycleId: event.toolUseId,
        category,
        label: callLabel(event, category),
        event,
        result,
        order: itemOrder.get(event) ?? items.length + logicalIndex,
        startMs,
        endMs,
        durationMs,
        durationSource: providerDuration != null ? 'provider' : observedDuration != null ? 'observed' : 'unknown',
        messageId: event.messageId,
        nested: !!event.parentToolUseId || !!event.agentId
      }
    })

  const aggregateMap = new Map<string, TurnTimingAggregate>()
  for (const call of calls) {
    const aggregate = aggregateMap.get(call.category) ?? {
      category: call.category,
      count: 0,
      timedCount: 0,
      totalMs: 0
    }
    aggregate.count += 1
    if (call.durationMs != null) {
      aggregate.timedCount += 1
      aggregate.totalMs += call.durationMs
      aggregate.maxMs = Math.max(aggregate.maxMs ?? 0, call.durationMs)
    }
    aggregateMap.set(call.category, aggregate)
  }
  const aggregates = [...aggregateMap.values()]
    .map((aggregate) => ({
      ...aggregate,
      averageMs: aggregate.timedCount > 0 ? aggregate.totalMs / aggregate.timedCount : undefined
    }))
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count || a.category.localeCompare(b.category))

  const mainCalls = calls.filter((call) => !call.nested)
  const nestedCalls = calls.filter((call) => call.nested)
  const explicitGroups: Array<{
    messageId?: string
    responseOrder: number
    responseEndOrder: number
    responseAt?: number
    calls: TimedTurnCall[]
  }> = []
  const groupsByMessageId = new Map<string, (typeof explicitGroups)[number]>()
  for (const event of items) {
    if (!event.messageId || event.parentToolUseId || event.agentId || event.stage === 'tool_result') continue
    if (event.kind !== 'model' && event.kind !== 'tool' && event.kind !== 'skill' && event.kind !== 'agent') continue
    const order = itemOrder.get(event) ?? items.length
    let group = groupsByMessageId.get(event.messageId)
    if (!group) {
      group = {
        messageId: event.messageId,
        responseOrder: order,
        responseEndOrder: order,
        responseAt: timestampMs(event.ts),
        calls: []
      }
      groupsByMessageId.set(event.messageId, group)
      explicitGroups.push(group)
    }
    group.responseOrder = Math.min(group.responseOrder, order)
    group.responseEndOrder = Math.max(group.responseEndOrder, order)
    const eventAt = timestampMs(event.ts)
    if (eventAt != null) group.responseAt = Math.max(group.responseAt ?? eventAt, eventAt)
  }
  for (const call of mainCalls) {
    if (!call.messageId) continue
    groupsByMessageId.get(call.messageId)?.calls.push(call)
  }

  explicitGroups.sort((a, b) => a.responseOrder - b.responseOrder)
  for (const group of explicitGroups) group.calls.sort((a, b) => a.order - b.order)

  // Claude 的 text-only 最终响应有时只留下无 messageId 的流式文本。仅当它明确位于
  // 最后一批工具之后时，补一个匿名“最终响应”边界；不会据此伪造单次 API 原值。
  if (explicitGroups.length > 0) {
    const lastGroup = explicitGroups[explicitGroups.length - 1]
    const lastCallEnd = latestEnd(lastGroup.calls)
    const trailingModelEvents = items.filter((event) => {
      if (event.kind !== 'model' || event.messageId || event.parentToolUseId || event.agentId) return false
      if (event.stage !== 'text' && event.stage !== 'text_delta' && event.stage !== 'thinking') return false
      const order = itemOrder.get(event) ?? -1
      const at = timestampMs(event.ts)
      return order > lastGroup.responseEndOrder && at != null && (lastCallEnd == null || at >= lastCallEnd)
    })
    if (trailingModelEvents.length > 0) {
      const orders = trailingModelEvents.map((event) => itemOrder.get(event) ?? items.length)
      const times = trailingModelEvents.map((event) => timestampMs(event.ts)).filter((value): value is number => value != null)
      explicitGroups.push({
        responseOrder: Math.min(...orders),
        responseEndOrder: Math.max(...orders),
        responseAt: times.length > 0 ? Math.max(...times) : undefined,
        calls: []
      })
    }
  }

  const assignedCallIds = new Set(explicitGroups.flatMap((group) => group.calls.map((call) => call.id)))
  const unassignedCalls = explicitGroups.length > 0 ? mainCalls.filter((call) => !assignedCallIds.has(call.id)) : []

  const resultTs = timestampMs(resultEvent?.ts)
  const wallMs = finiteDuration(resultEvent?.durationMs)
  const turnStart = resultTs != null && wallMs != null ? resultTs - wallMs : undefined
  const phases: ModelResponsePhase[] = []

  if (explicitGroups.length > 0) {
    explicitGroups.forEach((group, index) => {
      const previous = index === 0 ? undefined : explicitGroups[index - 1]
      const hasUnknownCallBetween =
        previous != null &&
        unassignedCalls.some((call) => call.order > previous.responseEndOrder && call.order < group.responseOrder)
      const phaseStart =
        index === 0
          ? turnStart
          : hasUnknownCallBetween
            ? undefined
            : previous!.calls.length > 0
              ? latestEnd(previous!.calls)
              : previous!.responseAt
      const isFinalResponse = index === explicitGroups.length - 1 && group.calls.length === 0
      phases.push({
        id: group.messageId ? `response:${group.messageId}` : 'response:final-observed',
        sequence: index + 1,
        messageId: group.messageId,
        kind: isFinalResponse ? 'final' : 'response',
        observedMs: observedGap(phaseStart, group.responseAt),
        toolMs: intervalUnionMs(group.calls),
        timedTools: group.calls.filter((call) => call.durationMs != null).length,
        callsAfterResponse: group.calls
      })
    })

    const lastGroup = explicitGroups[explicitGroups.length - 1]
    const tailStart = lastGroup.calls.length > 0 ? latestEnd(lastGroup.calls) : lastGroup.responseAt
    const tailMs = observedGap(tailStart, resultTs)
    if (tailMs != null && tailMs > 0) {
      phases.push({
        id: 'response:tail',
        sequence: explicitGroups.length + 1,
        kind: 'tail',
        tailMode: lastGroup.calls.length === 0 ? 'cleanup' : 'unknown',
        observedMs: tailMs,
        timedTools: 0,
        callsAfterResponse: []
      })
    }
  } else if (mainCalls.length > 0 || resultEvent?.durationApiMs != null) {
    phases.push({
      id: 'response:unsegmented',
      sequence: 1,
      kind: 'unsegmented',
      toolMs: intervalUnionMs(mainCalls),
      timedTools: mainCalls.filter((call) => call.durationMs != null).length,
      callsAfterResponse: mainCalls
    })
  }

  const timedCalls = calls.filter((call) => call.durationMs != null)
  const cumulativeCallMs = timedCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
  const occupiedCallMs = intervalUnionMs(timedCalls)
  const residualApiMs =
    wallMs != null && occupiedCallMs != null
      ? Math.max(0, wallMs - occupiedCallMs)
      : undefined
  const unsegmentedPhase = phases.find((phase) => phase.kind === 'unsegmented')
  if (unsegmentedPhase && unsegmentedPhase.observedMs == null && residualApiMs != null) {
    // 没有 messageId 时无法还原逐次请求边界。仅把整轮非工具占用余量作为观测估计，
    // UI 必须明确标成 residual，不能伪装成 SDK API 原值。
    unsegmentedPhase.observedMs = residualApiMs
  }

  const apiPhases = phases.filter((phase) => phase.kind !== 'tail')
  const timedApiPhases = apiPhases.filter((phase) => phase.observedMs != null)
  const providerApiMs = finiteDuration(resultEvent?.durationApiMs)
  const observedApiMs =
    timedApiPhases.length > 0
      ? timedApiPhases.reduce((sum, phase) => sum + (phase.observedMs ?? 0), 0)
      : undefined
  return {
    wallMs,
    apiMs: providerApiMs ?? observedApiMs,
    apiSource: providerApiMs != null ? 'provider' : observedApiMs != null ? 'observed' : 'unknown',
    apiObservation:
      providerApiMs != null
        ? undefined
        : unsegmentedPhase?.observedMs != null
          ? 'residual'
          : observedApiMs != null
            ? 'phase'
            : undefined,
    timedApiPhases: timedApiPhases.length,
    totalApiPhases: apiPhases.length,
    totalCalls: calls.length,
    timedCalls: timedCalls.length,
    cumulativeCallMs,
    occupiedCallMs,
    overlapCallMs: occupiedCallMs == null ? undefined : Math.max(0, cumulativeCallMs - occupiedCallMs),
    aggregates,
    phases,
    unassignedCalls,
    nestedCalls
  }
}
