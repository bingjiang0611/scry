import { createHash } from 'node:crypto'
import { isOverviewToolErrorEvent, logicalCallEventsForTurn } from '../../shared/logical-calls.js'
import { deriveModelTiming } from '../../shared/model-timing.js'
import { HOOK_DELIVERY_STAGE, mcpCallsForEvent, type McpCallRef, type TraceEvent } from '../../shared/trace.js'
import {
  available,
  canonicalCostUsd,
  partial,
  unavailable,
  type TurnCall,
  type TurnCallStatus,
  type TurnCompaction,
  type TurnEvidence,
  type TurnHookCall,
  type TurnModelSegment,
  type TurnUsage
} from '../../shared/turn-record.js'

function hash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

function callStatus(event: TraceEvent, result?: TraceEvent): TurnCallStatus {
  if (!result) return event.isError ? 'failed' : 'unknown'
  if (result.isError) return 'failed'
  return 'success'
}

function outputSummary(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length <= 500 ? value : `${value.slice(0, 500)}…`
}

function callFromEvent(
  event: TraceEvent,
  resultById: Map<string, TraceEvent>,
  mcpRef?: McpCallRef,
  order?: number,
  completedOrder?: number
): TurnCall {
  const result = event.toolUseId ? resultById.get(event.toolUseId) : undefined
  const completedAt = result?.ts
  const started = Date.parse(event.ts)
  const completed = completedAt ? Date.parse(completedAt) : NaN
  return {
    ...(event.toolUseId ? { id: event.toolUseId } : {}),
    ...(event.parentToolUseId ? { parentId: event.parentToolUseId } : {}),
    category: mcpRef ? 'mcp' : event.kind as 'tool' | 'skill' | 'agent',
    ...(order != null ? { order } : {}),
    ...(completedOrder != null ? { completedOrder } : {}),
    name: event.name ?? event.tool ?? 'unknown',
    startedAt: event.ts,
    ...(completedAt ? { completedAt } : {}),
    ...(Number.isFinite(started) && Number.isFinite(completed) ? { durationMs: Math.max(0, completed - started) } : {}),
    status: callStatus(event, result),
    ...(event.input !== undefined ? { input: event.input } : {}),
    ...(result?.text || result?.output ? { outputSummary: outputSummary(result.output ?? result.text) } : {}),
    ...(result?.isError ? { error: outputSummary(result.output ?? result.text) ?? 'tool failed' } : {}),
    ...(event.fileOp && event.filePath ? { file: { operation: event.fileOp, path: event.filePath } } : {}),
    ...(event.isMcp
      ? {
          mcp: {
            server: mcpRef?.server ?? event.mcpServer,
            action: mcpRef?.action ?? event.mcpAction,
            tool: mcpRef?.tool ?? event.mcpTool
          }
        }
      : {})
  }
}

function hookStatus(event: TraceEvent): TurnCallStatus {
  if (event.hookOutcome === 'cancelled') return 'cancelled'
  if (event.isError || event.hookOutcome === 'error' || (event.hookExitCode != null && event.hookExitCode !== 0)) return 'failed'
  if (event.hookOutcome === 'success' || event.hookOutcome === 'completed') return 'success'
  if (event.hookOutcome === 'started') return 'started'
  return 'unknown'
}

function isRecorderHook(event: TraceEvent): boolean {
  if (event.hookName === 'turn-recorder-v1') return true
  if (/scry-recorder\.sh|turn-recorder-v1/.test(`${event.hookName ?? ''}\n${event.hookCommand ?? ''}`)) return true
  const input = event.input as Record<string, unknown> | undefined
  return input?.handlerId === 'turn-recorder-v1' || input?.SCRY_HANDLER_ID === 'turn-recorder-v1'
}

function sumObserved(events: TraceEvent[], pick: (event: TraceEvent) => number | undefined): number | undefined {
  const values = events.map(pick).filter((value): value is number => value != null && Number.isFinite(value))
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined
}

function sumCostUsd(events: TraceEvent[]): number | undefined {
  const values = events.map((event) => event.costUsd).filter((value): value is number => value != null)
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) return undefined
  return canonicalCostUsd(values.reduce((sum, value) => sum + value, 0))
}

function usageFrom(events: TraceEvent[]): TurnUsage | undefined {
  const observed = events.filter((event) => event.kind === 'harness' && event.stage === 'result')
  if (!observed.length) return undefined
  const native = observed.filter((event) => event.text !== 'transcript assistant usage')
  const nativeOrObserved = native.length ? native : observed
  // Claude Agent SDK may emit more than one result while the same query continues
  // (for example, after task notifications). Each result is a cumulative snapshot,
  // so summing them double-counts every earlier model call.
  const latest = nativeOrObserved.at(-1)
  const results = latest?.runtimeProvider === 'claude_sdk' ? [latest] : nativeOrObserved
  const models = new Set(results.flatMap((event) => event.modelUsage ?? []).map((row) => row.model).filter(Boolean))
  const contextModel = latest?.modelUsage?.find((row) => row.contextWindow != null && row.contextWindow > 0)
  return {
    inputTokens: sumObserved(results, (event) => event.tokensIn),
    outputTokens: sumObserved(results, (event) => event.tokensOut),
    cacheReadTokens: sumObserved(results, (event) => event.cacheReadTokens),
    cacheCreationTokens: sumObserved(results, (event) => event.cacheCreationTokens),
    reasoningTokens: sumObserved(results, (event) => event.reasoningTokens),
    costUsd: sumCostUsd(results),
    apiDurationMs: sumObserved(results, (event) => event.durationApiMs),
    ...(latest?.contextTokens != null ? { contextTokens: latest.contextTokens } : {}),
    ...(contextModel?.contextWindow != null ? { contextWindow: contextModel.contextWindow } : {}),
    ...(models.size === 1 ? { model: [...models][0] } : {})
  }
}

export function modelSegmentsFrom(events: TraceEvent[]): TurnModelSegment[] {
  const output: TurnModelSegment[] = []
  const eventOrder = new Map(events.map((event, index) => [event, index]))
  let run: TraceEvent[] = []
  let runKey: string | undefined

  const flush = (): void => {
    if (!run.length) return
    const first = run[0]
    const kind = first.stage === 'thinking' ? 'thinking' : 'text'
    const deltas = kind === 'text'
      ? run.filter((event) => event.stage === 'text_delta').map((event) => event.text ?? '').join('')
      : ''
    const authoritativeText = kind === 'text'
      ? [...run].reverse().find((event) =>
          event.stage === 'text' && event.runtimeMetadata?.replacesStreamedText === true
        )?.text
      : undefined
    const text = kind === 'thinking'
      ? run.map((event) => event.thinking ?? '').join('')
      : authoritativeText ?? run.map((event) => event.stage === 'text' && deltas && event.text === deltas ? '' : event.text ?? '').join('')
    const providerItemId = typeof first.runtimeMetadata?.codexItemId === 'string'
      ? first.runtimeMetadata.codexItemId
      : undefined
    if (text) output.push({
      order: eventOrder.get(first) ?? 0,
      at: first.ts,
      kind,
      text,
      ...(first.messageId ? { messageId: first.messageId } : {}),
      ...(providerItemId ? { providerItemId } : {}),
      ...(first.parentToolUseId ? { parentId: first.parentToolUseId } : {}),
      ...(first.agentId ? { agentId: first.agentId } : {})
    })
    run = []
    runKey = undefined
  }

  for (const event of events) {
    const isText = event.kind === 'model' && ['text', 'text_delta'].includes(event.stage) && event.text != null
    const isThinking = event.kind === 'model' && event.stage === 'thinking' && event.thinking != null
    if (!isText && !isThinking) {
      flush()
      continue
    }
    const key = JSON.stringify([
      isThinking ? 'thinking' : 'text',
      event.messageId ?? null,
      event.runtimeMetadata?.codexItemId ?? null,
      event.agentId ?? null,
      event.parentToolUseId ?? null
    ])
    if (runKey !== undefined && runKey !== key) flush()
    runKey = key
    run.push(event)
  }
  flush()
  return output
}

/**
 * 只能证明「hook 事件触发过」的投递事件（`HOOK_DELIVERY_STAGE`）按事件名 + 子 agent 归属归并成一条，
 * 只落首次投递时刻与投递次数：脚本身份、耗时、退出码都没观测到，不得补 name / command / completedAt / durationMs / success。
 */
function aggregateHookDeliveries(events: TraceEvent[], eventOrder: Map<TraceEvent, number>): TurnHookCall[] {
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events) {
    if (event.kind !== 'hook' || event.stage !== HOOK_DELIVERY_STAGE) continue
    const key = `${event.hookEvent ?? event.name ?? 'Hook'}\u0000${event.agentId ?? ''}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const first = [...group].sort((left, right) => left.ts.localeCompare(right.ts))[0]
    return {
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: group.length,
      event: first.hookEvent ?? first.name ?? 'Hook',
      startedAt: first.ts,
      status: 'unknown' as const
    }
  })
}

function aggregateHooks(events: TraceEvent[], eventOrder: Map<TraceEvent, number>): TurnHookCall[] {
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events) {
    if (event.kind !== 'hook' || event.stage === HOOK_DELIVERY_STAGE || isRecorderHook(event)) continue
    const key = event.hookId ? `hook:${event.hookId}` : `event:${event.id}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const runs = [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) => left.ts.localeCompare(right.ts))
    const first = ordered[0]
    const last = ordered.at(-1) ?? first
    const terminal = [...ordered].reverse().find((event) => !['started', 'progress'].includes(event.hookOutcome ?? '')) ?? last
    const started = ordered.find((event) => event.hookOutcome === 'started') ?? first
    const startedMs = Date.parse(started.ts)
    const completedMs = Date.parse(terminal.ts)
    const durationMs = terminal.durationMs ?? (
      Number.isFinite(startedMs) && Number.isFinite(completedMs) && terminal !== started
        ? Math.max(0, completedMs - startedMs)
        : undefined
    )
    return {
      ...(first.hookId ? { id: first.hookId } : {}),
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: ordered.length,
      event: last.hookEvent ?? first.hookEvent ?? last.name ?? first.name ?? 'Hook',
      ...(last.hookName ?? first.hookName ? { name: last.hookName ?? first.hookName } : {}),
      ...(last.hookCommand ?? first.hookCommand ? { command: last.hookCommand ?? first.hookCommand } : {}),
      startedAt: started.ts,
      ...(terminal !== started ? { completedAt: terminal.ts } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      status: hookStatus(terminal),
      ...(terminal.hookExitCode != null ? { exitCode: terminal.hookExitCode } : {})
    }
  })
  return [...runs, ...aggregateHookDeliveries(events, eventOrder)]
}

export function aggregateTurnEvidence(args: {
  userText?: string
  events: TraceEvent[]
  source?: string
  observable?: {
    assistant?: boolean
    tools?: boolean
    skills?: boolean
    mcps?: boolean
    hooks?: boolean
    usage?: boolean
    files?: boolean
    errors?: boolean
    diff?: boolean
    interventions?: boolean
  }
}): TurnEvidence {
  const source = args.source ?? 'trace_events'
  const observable = {
    assistant: true,
    tools: true,
    skills: true,
    mcps: true,
    hooks: true,
    usage: true,
    files: true,
    errors: true,
    diff: true,
    interventions: true,
    ...args.observable
  }
  const resultById = new Map<string, TraceEvent>()
  const eventOrder = new Map(args.events.map((event, index) => [event, index]))
  for (const event of args.events) {
    if (event.stage === 'tool_result' && event.toolUseId) resultById.set(event.toolUseId, event)
  }

  const logicalEvents = logicalCallEventsForTurn(args.events)
  const resultOrder = (event: TraceEvent): number | undefined => {
    const result = event.toolUseId ? resultById.get(event.toolUseId) : undefined
    return result ? eventOrder.get(result) : undefined
  }
  const starts = logicalEvents.filter((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  // AgentTurnRecord v1 的 Tool / Skill / MCP 是互斥 evidence 容器。Agent 为兼容 v1 仍存入
  // tools，但用 category=agent 明确分列；MCP 不能同时再进入 tools，否则总调用会重复相加。
  const tools = starts
    .filter((event) => event.kind === 'agent' || (event.kind === 'tool' && !event.isMcp))
    .map((event) => callFromEvent(event, resultById, undefined, eventOrder.get(event), resultOrder(event)))
  const skills = starts
    .filter((event) => event.kind === 'skill')
    .map((event) => callFromEvent(event, resultById, undefined, eventOrder.get(event), resultOrder(event)))
  const mcps = starts
    .filter((event) => event.kind === 'tool' && event.isMcp)
    .flatMap((event) => {
      const refs = mcpCallsForEvent(event)
      return refs.map((ref) => callFromEvent(event, resultById, ref, eventOrder.get(event), resultOrder(event)))
    })
  const hooks = aggregateHooks(args.events, eventOrder)
  // 只有带脚本身份的 hook 运行才能宣称 exact；纯投递证据只能证明事件触发过。
  const hookRunsObserved = args.events.some((event) =>
    event.kind === 'hook' && event.stage !== HOOK_DELIVERY_STAGE && !isRecorderHook(event)
  )
  const modelSegments = modelSegmentsFrom(args.events)
  const assistantText = modelSegments.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('')
  const fileMap = new Map<string, 'read' | 'write' | 'edit'>()
  for (const event of args.events) {
    if (event.stage !== 'tool_result' && event.filePath && event.fileOp) fileMap.set(event.filePath, event.fileOp)
  }
  const diffs = args.events.flatMap((event) => {
    const diff = event.turnDiff
    if (!diff) return []
    const { version: _version, ...record } = diff
    return [record]
  })
  const capturedDiffs = diffs.filter((diff) => diff.status === 'captured')
  const dangers = starts.flatMap((event) =>
    event.danger ? [{ ...event.danger, tool: event.tool, toolUseId: event.toolUseId }] : []
  )
  const errors = args.events.flatMap((event) =>
    isOverviewToolErrorEvent(event)
      ? [{ message: outputSummary(event.output ?? event.text) ?? `${event.tool ?? event.stage} failed`, source: event.stage, toolUseId: event.toolUseId }]
      : []
  )
  const usage = usageFrom(args.events)
  const modelTiming = deriveModelTiming(args.events)
  const interventions = args.events.flatMap((event) => event.intervention ? [event.intervention] : [])
  const compactions: TurnCompaction[] = args.events.flatMap((event) => {
    if (event.kind !== 'harness' || event.stage !== 'context_compaction') return []
    return [{
      eventId: event.id,
      at: event.ts,
      ...(event.compaction?.trigger ? { trigger: event.compaction.trigger } : {}),
      ...(event.compaction?.preTokens != null ? { preTokens: event.compaction.preTokens } : {}),
      ...(event.compaction?.postTokens != null ? { postTokens: event.compaction.postTokens } : {}),
      ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {})
    }]
  })

  return {
    user: args.userText != null
      ? available({ text: args.userText, textHash: hash(args.userText) }, [source])
      : unavailable('top-level user prompt was not observable', [source]),
    assistant: !observable.assistant
      ? unavailable('provider does not expose assistant text to lifecycle hooks', [source])
      : assistantText
        ? available({ text: assistantText, textHash: hash(assistantText) }, [source])
        : partial({}, [source], 'assistant text was not present in captured events'),
    modelSegments: observable.assistant
      ? available(modelSegments, [source])
      : unavailable('provider does not expose model output to lifecycle hooks', [source]),
    tools: observable.tools ? available(tools, [source]) : unavailable('provider tool events were not observable', [source]),
    skills: observable.skills ? available(skills, [source]) : unavailable('provider skill events were not observable', [source]),
    mcps: observable.mcps ? available(mcps, [source]) : unavailable('provider MCP events were not observable', [source]),
    hooks: !observable.hooks
      ? unavailable('provider hook runtime events were not observable', [source])
      : hooks.length > 0 && !hookRunsObserved
        ? partial(
            hooks,
            [source],
            'provider only delivered hook lifecycle events; per-hook command, outcome and exit code were not observable',
            'inferred'
          )
        : available(hooks, [source]),
    usage: !observable.usage
      ? unavailable('provider usage was not observable', [source])
      : usage
        ? available(usage, [source])
        : unavailable('no authoritative usage event was captured', [source]),
    compactions: available(compactions, [source]),
    ...(modelTiming
      ? {
          modelTiming:
            modelTiming.status === 'available'
              ? available(modelTiming.value, [source], modelTiming.quality)
              : partial(
                  modelTiming.value,
                  [source],
                  modelTiming.omissionReason ?? 'model timing coverage was incomplete',
                  modelTiming.quality
                )
        }
      : {}),
    files: observable.files
      ? available([...fileMap].map(([path, operation]) => ({ path, operation })), [source])
      : unavailable('provider file events were not observable', [source]),
    diff: !observable.diff
      ? unavailable('turn diff capture was disabled or unavailable', [source])
      : diffs.length === 0
        ? unavailable('turn diff snapshot was not captured', [source])
        : capturedDiffs.length === diffs.length
          ? available(diffs, [source])
          : capturedDiffs.length > 0
            ? partial(diffs, [source], 'one or more repository snapshots were unavailable', 'exact')
            : {
                status: 'unavailable',
                quality: 'unavailable',
                source: [source],
                value: diffs,
                omissionReason: 'no repository snapshot was captured'
              },
    dangerousOperations: observable.tools ? available(dangers, [source]) : unavailable('tool evidence was unavailable', [source]),
    errors: observable.errors ? available(errors, [source]) : unavailable('provider error events were not observable', [source]),
    interventions: observable.interventions
      ? available(interventions, [source])
      : unavailable('provider user-input events were not observable', [source])
  }
}
