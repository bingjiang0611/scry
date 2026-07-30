import { createHash } from 'node:crypto'
import { isOverviewToolErrorEvent, logicalCallEventsForTurn } from '../../shared/logical-calls.js'
import { deriveModelTiming } from '../../shared/model-timing.js'
import { mcpCallsForEvent, type McpCallRef, type TraceEvent } from '../../shared/trace.js'
import {
  available,
  partial,
  unavailable,
  type TurnCall,
  type TurnCallStatus,
  type TurnEvidence,
  type TurnHookCall,
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
  mcpRef?: McpCallRef
): TurnCall {
  const result = event.toolUseId ? resultById.get(event.toolUseId) : undefined
  const completedAt = result?.ts
  const started = Date.parse(event.ts)
  const completed = completedAt ? Date.parse(completedAt) : NaN
  return {
    ...(event.toolUseId ? { id: event.toolUseId } : {}),
    ...(event.parentToolUseId ? { parentId: event.parentToolUseId } : {}),
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

function usageFrom(events: TraceEvent[]): TurnUsage | undefined {
  const observed = events.filter((event) => event.kind === 'harness' && event.stage === 'result')
  if (!observed.length) return undefined
  const native = observed.filter((event) => event.text !== 'transcript assistant usage')
  const results = native.length ? native : observed
  const models = new Set(results.flatMap((event) => event.modelUsage ?? []).map((row) => row.model).filter(Boolean))
  return {
    inputTokens: sumObserved(results, (event) => event.tokensIn),
    outputTokens: sumObserved(results, (event) => event.tokensOut),
    cacheReadTokens: sumObserved(results, (event) => event.cacheReadTokens),
    cacheCreationTokens: sumObserved(results, (event) => event.cacheCreationTokens),
    reasoningTokens: sumObserved(results, (event) => event.reasoningTokens),
    costUsd: sumObserved(results, (event) => event.costUsd),
    ...(models.size === 1 ? { model: [...models][0] } : {})
  }
}

function assistantTextFrom(events: TraceEvent[]): string {
  const output: string[] = []
  let run: TraceEvent[] = []
  let runKey: string | undefined

  const flush = (): void => {
    if (!run.length) return
    const deltas = run
      .filter((event) => event.stage === 'text_delta')
      .map((event) => event.text ?? '')
      .join('')
    for (const event of run) {
      const text = event.text ?? ''
      if (event.stage === 'text' && deltas && text === deltas) continue
      output.push(text)
    }
    run = []
    runKey = undefined
  }

  for (const event of events) {
    if (event.kind !== 'model' || !['text', 'text_delta'].includes(event.stage) || event.text == null) {
      flush()
      continue
    }
    const key = JSON.stringify([event.messageId ?? null, event.agentId ?? null, event.parentToolUseId ?? null])
    if (runKey !== undefined && runKey !== key) flush()
    runKey = key
    run.push(event)
  }
  flush()
  return output.join('')
}

function aggregateHooks(events: TraceEvent[]): TurnHookCall[] {
  const groups = new Map<string, TraceEvent[]>()
  for (const event of events.filter((item) => item.kind === 'hook' && !isRecorderHook(item))) {
    const key = event.hookId ? `hook:${event.hookId}` : `event:${event.id}`
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
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
    ...args.observable
  }
  const resultById = new Map<string, TraceEvent>()
  for (const event of args.events) {
    if (event.stage === 'tool_result' && event.toolUseId) resultById.set(event.toolUseId, event)
  }

  const logicalEvents = logicalCallEventsForTurn(args.events)
  const starts = logicalEvents.filter((event) =>
    event.stage !== 'tool_result' && ['tool', 'skill', 'agent'].includes(event.kind) && !!(event.tool || event.name)
  )
  // reportAgentTurns 的 Tool / Skill / MCP 是互斥列。Agent 暂无独立列，因此归入 Tool；
  // MCP 不能同时再出现在 Tool 中，否则看板总调用会重复相加。
  const tools = starts
    .filter((event) => event.kind === 'agent' || (event.kind === 'tool' && !event.isMcp))
    .map((event) => callFromEvent(event, resultById))
  const skills = starts.filter((event) => event.kind === 'skill').map((event) => callFromEvent(event, resultById))
  const mcps = starts
    .filter((event) => event.kind === 'tool' && event.isMcp)
    .flatMap((event) => {
      const refs = mcpCallsForEvent(event)
      return refs.map((ref) => callFromEvent(event, resultById, ref))
    })
  const hooks = aggregateHooks(args.events)
  const assistantText = assistantTextFrom(args.events)
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

  return {
    user: args.userText != null
      ? available({ text: args.userText, textHash: hash(args.userText) }, [source])
      : unavailable('top-level user prompt was not observable', [source]),
    assistant: !observable.assistant
      ? unavailable('provider does not expose assistant text to lifecycle hooks', [source])
      : assistantText
        ? available({ text: assistantText, textHash: hash(assistantText) }, [source])
        : partial({}, [source], 'assistant text was not present in captured events'),
    tools: observable.tools ? available(tools, [source]) : unavailable('provider tool events were not observable', [source]),
    skills: observable.skills ? available(skills, [source]) : unavailable('provider skill events were not observable', [source]),
    mcps: observable.mcps ? available(mcps, [source]) : unavailable('provider MCP events were not observable', [source]),
    hooks: observable.hooks ? available(hooks, [source]) : unavailable('provider hook runtime events were not observable', [source]),
    usage: !observable.usage
      ? unavailable('provider usage was not observable', [source])
      : usage
        ? available(usage, [source])
        : unavailable('no authoritative usage event was captured', [source]),
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
    errors: observable.errors ? available(errors, [source]) : unavailable('provider error events were not observable', [source])
  }
}
