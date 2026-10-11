import { createHash } from 'node:crypto'
import { captureToolContent, isFullToolContentPolicy, limitToolContent, sanitizeToolEvents, type ToolContentPolicy } from './tool-content.js'
import { isOverviewToolErrorEvent, logicalCallEventsForTurn } from '../../shared/logical-calls.js'
import { deriveModelTiming } from '../../shared/model-timing.js'
import { providerDangerCoverage } from '../../shared/provider.js'
import { providerUsageResultEvents } from '../../shared/result-timing.js'
import { isCreditUsageEvidence } from '../../shared/credit-usage.js'
import { contextUsageEvidence, HOOK_DELIVERY_STAGE, mcpCallsForEvent, type McpCallRef, type TraceEvent } from '../../shared/trace.js'
import { limitTurnDiffPatchBytes } from './git.js'
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

const TURN_CALL_INPUT_MAX_BYTES = 8 * 1024
const TURN_CALL_DETAIL_MAX_BYTES = 128 * 1024

type CallSection = 'tools' | 'skills' | 'mcps'

interface CallCandidate {
  call: TurnCall
  event: TraceEvent
  section: CallSection
}

function hash(text: string | Uint8Array): string {
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
    ...(event.inputContent ? {
      inputContent: event.inputContent,
      outputContent: result?.outputContent ?? captureToolContent(undefined, { source: event.inputContent.source })
    } : event.input !== undefined ? { input: event.input } : {}),
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

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function limitCallDetails(candidates: CallCandidate[]): Set<CallSection> {
  const omitted = new Set<CallSection>()
  const boundaries = new Set<CallCandidate>()
  const groups = new Map<string, CallCandidate[]>()
  for (const candidate of candidates) {
    const key = `${candidate.section}:${candidate.call.name}`
    const group = groups.get(key) ?? []
    group.push(candidate)
    groups.set(key, group)
    if (candidate.call.input !== undefined && jsonBytes(candidate.call.input) > TURN_CALL_INPUT_MAX_BYTES) {
      delete candidate.call.input
      omitted.add(candidate.section)
    }
  }
  for (const group of groups.values()) {
    boundaries.add(group[0])
    boundaries.add(group.at(-1) ?? group[0])
  }
  const priority = (candidate: CallCandidate): number => {
    if (
      candidate.call.status === 'failed' ||
      candidate.call.status === 'cancelled' ||
      candidate.event.danger ||
      (candidate.call.file && candidate.call.file.operation !== 'read')
    ) return 0
    return boundaries.has(candidate) ? 1 : 2
  }
  let remainingBytes = TURN_CALL_DETAIL_MAX_BYTES
  for (const candidate of [...candidates].sort((left, right) =>
    priority(left) - priority(right) || (left.call.order ?? 0) - (right.call.order ?? 0)
  )) {
    const detail = {
      ...(candidate.call.input !== undefined ? { input: candidate.call.input } : {}),
      ...(candidate.call.outputSummary ? { outputSummary: candidate.call.outputSummary } : {}),
      ...(candidate.call.error ? { error: candidate.call.error } : {})
    }
    const bytes = jsonBytes(detail)
    if (bytes <= remainingBytes) {
      remainingBytes -= bytes
      continue
    }
    if (candidate.call.input !== undefined || candidate.call.outputSummary || candidate.call.error) {
      delete candidate.call.input
      delete candidate.call.outputSummary
      delete candidate.call.error
      omitted.add(candidate.section)
    }
  }
  return omitted
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
    const authoritativeEvent = kind === 'text'
      ? [...run].reverse().find((event) =>
          event.stage === 'text' && event.runtimeMetadata?.replacesStreamedText === true
        )
      : undefined
    const bodyEvents = kind === 'thinking'
      ? run.filter((event) => !!event.thinking)
      : authoritativeEvent
        ? [authoritativeEvent]
        : run.filter((event) => !(event.stage === 'text' && deltas && event.text === deltas) && !!event.text)
    const fullText = kind === 'thinking'
      ? bodyEvents.map((event) => event.thinking ?? '').join('')
      : bodyEvents.map((event) => event.text ?? '').join('')
    const contentRefs = bodyEvents
      .map((event) => event.modelContent?.contentRef)
      .filter((ref): ref is NonNullable<typeof ref> => !!ref)
    const hasCompleteRefs = bodyEvents.length > 0 && contentRefs.length === bodyEvents.length
    const text = hasCompleteRefs
      ? captureToolContent(fullText, { source: 'model_segment_preview', maxBytes: 32 * 1024 }).content ?? ''
      : fullText
    const providerItemId = typeof first.runtimeMetadata?.codexItemId === 'string'
      ? first.runtimeMetadata.codexItemId
      : undefined
    if (text) output.push({
      order: eventOrder.get(first) ?? 0,
      at: first.ts,
      kind,
      text,
      ...(hasCompleteRefs ? { contentRefs } : {}),
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
      runs: group.length,
      event: first.hookEvent ?? first.name ?? 'Hook',
      startedAt: first.ts,
      status: 'unknown' as const
    }
  })
}

interface HookRun {
  order?: number
  lifecycleEvents: number
  event: string
  name?: string
  command?: string
  startedAt: string
  completedAt?: string
  durationMs?: number
  status: TurnCallStatus
}

// 相同 event+name+command 的多次运行折叠成一条：保留 runs/failed 计数，丢弃逐次的 id/exitCode，
// 大幅压缩重复命令串（同一 hook 脚本在每个工具调用上重复触发）。
function collapseHookRuns(runs: HookRun[]): TurnHookCall[] {
  const groups = new Map<string, HookRun[]>()
  for (const run of runs) {
    const key = `${run.event}\u0000${run.name ?? ''}\u0000${run.command ?? ''}`
    const group = groups.get(key) ?? []
    group.push(run)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const first = group[0]
    const failed = group.filter((run) => run.status === 'failed').length
    const orders = group.map((run) => run.order).filter((value): value is number => value != null)
    const startedAt = group.map((run) => run.startedAt).sort()[0]
    const completedAts = group.map((run) => run.completedAt).filter((value): value is string => !!value).sort()
    const hasDuration = group.some((run) => run.durationMs != null)
    const durationMs = group.reduce((sum, run) => sum + (run.durationMs ?? 0), 0)
    const status: TurnCallStatus =
      failed > 0 ? 'failed' : group.some((run) => run.status === 'unknown') ? 'unknown' : first.status
    return {
      ...(orders.length > 0 ? { order: Math.min(...orders) } : {}),
      lifecycleEvents: group.reduce((sum, run) => sum + run.lifecycleEvents, 0),
      runs: group.length,
      ...(failed > 0 ? { failed } : {}),
      event: first.event,
      ...(first.name ? { name: first.name } : {}),
      ...(first.command ? { command: first.command } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(completedAts.length > 0 ? { completedAt: completedAts[completedAts.length - 1] } : {}),
      ...(hasDuration ? { durationMs } : {}),
      status
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
  const runs: HookRun[] = [...groups.values()].map((group) => {
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
      ...(eventOrder.get(first) != null ? { order: eventOrder.get(first) } : {}),
      lifecycleEvents: ordered.length,
      event: last.hookEvent ?? first.hookEvent ?? last.name ?? first.name ?? 'Hook',
      ...(last.hookName ?? first.hookName ? { name: last.hookName ?? first.hookName } : {}),
      ...(last.hookCommand ?? first.hookCommand ? { command: last.hookCommand ?? first.hookCommand } : {}),
      startedAt: started.ts,
      ...(terminal !== started ? { completedAt: terminal.ts } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      status: hookStatus(terminal)
    }
  })
  return [...collapseHookRuns(runs), ...aggregateHookDeliveries(events, eventOrder)]
}

type CaptureField = 'assistant_response' | 'tool_input' | 'tool_response' | 'model_segments'

function captureOmissionReasons(events: TraceEvent[], fields: CaptureField[]): string[] {
  const reasons = new Set<string>()
  for (const event of events) {
    const limitations = event.runtimeMetadata?.scryCaptureLimitations
    if (!Array.isArray(limitations)) continue
    for (const raw of limitations) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const item = raw as Record<string, unknown>
      if (!fields.includes(item.field as CaptureField)) continue
      const label = item.field === 'assistant_response'
        ? 'assistant response'
        : item.field === 'model_segments'
          ? 'model segments'
          : item.field === 'tool_input'
            ? 'tool input'
            : 'tool response'
      const reason = item.reason === 'byte_limit'
        ? 'exceeded the integration byte limit'
        : item.reason === 'item_limit'
          ? 'exceeded the integration item limit'
          : 'could not be serialized by the integration'
      reasons.add(`${label} ${reason}`)
    }
  }
  return [...reasons]
}

function joinOmissionReasons(reasons: Array<string | undefined>): string | undefined {
  const unique = [...new Set(reasons.filter((reason): reason is string => !!reason))]
  return unique.length > 0 ? unique.join('; ') : undefined
}

export function aggregateTurnEvidence(args: {
  userText?: string
  events: TraceEvent[]
  source?: string
  toolContentPolicy?: ToolContentPolicy
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
  if (isFullToolContentPolicy(args.toolContentPolicy)) {
    args = { ...args, events: sanitizeToolEvents(args.events, args.toolContentPolicy, source) }
  }
  const providerEvent = args.events.find((event) => event.providerId || event.runtimeProvider)
  const dangerCoverage = providerDangerCoverage(providerEvent?.providerId, providerEvent?.runtimeProvider)
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
  const toolCandidates: CallCandidate[] = starts
    .filter((event) => event.kind === 'agent' || (event.kind === 'tool' && !event.isMcp))
    .map((event) => ({
      call: callFromEvent(event, resultById, undefined, eventOrder.get(event), resultOrder(event)),
      event,
      section: 'tools'
    }))
  const skillCandidates: CallCandidate[] = starts
    .filter((event) => event.kind === 'skill')
    .map((event) => ({
      call: callFromEvent(event, resultById, undefined, eventOrder.get(event), resultOrder(event)),
      event,
      section: 'skills'
    }))
  const mcpCandidates: CallCandidate[] = starts
    .filter((event) => event.kind === 'tool' && event.isMcp)
    .flatMap((event) => {
      const refs = mcpCallsForEvent(event)
      return refs.map((ref): CallCandidate => ({
        call: callFromEvent(event, resultById, ref, eventOrder.get(event), resultOrder(event)),
        event,
        section: 'mcps'
      }))
    })
  const candidates = [...toolCandidates, ...skillCandidates, ...mcpCandidates]
  const omittedCallSections = limitCallDetails(candidates)
  let remainingContentBytes = args.toolContentPolicy?.toolContentTurnBytes ?? 128 * 1024
  // Stable source order across mutually exclusive sections; metadata survives exhausted body budgets.
  for (const candidate of [...candidates].sort((a, b) => (a.call.order ?? 0) - (b.call.order ?? 0))) {
    for (const key of ['inputContent', 'outputContent'] as const) {
      const content = candidate.call[key]
      if (!content) continue
      const saved = limitToolContent(content, remainingContentBytes, 'turn_budget')
      candidate.call[key] = saved
      remainingContentBytes -= saved.savedBytes
      if ((saved.storage !== 'complete' && !saved.contentRef) || saved.sourceCompleteness === 'partial') omittedCallSections.add(candidate.section)
    }
    if (candidate.call.outputContent) {
      candidate.call.outputSummary = outputSummary(candidate.call.outputContent.content)
      if (candidate.call.error) candidate.call.error = candidate.call.outputSummary ?? 'tool failed'
    }
  }
  const tools = toolCandidates.map(({ call }) => call)
  const skills = skillCandidates.map(({ call }) => call)
  const mcps = mcpCandidates.map(({ call }) => call)
  const hooks = aggregateHooks(args.events, eventOrder)
  // 只有带脚本身份的 hook 运行才能宣称 exact；纯投递证据只能证明事件触发过。
  const hookRunsObserved = args.events.some((event) =>
    event.kind === 'hook' && event.stage !== HOOK_DELIVERY_STAGE && !isRecorderHook(event)
  )
  // 覆盖率必须带分母：混合证据（部分 hook 有结果、部分只有投递）以前整段判 available，
  // 于是下游把派生的 failed=0 读成「Hook 成功率 100%」。未观测到结果的运行数单独算出来。
  const hookRunTotal = hooks.reduce((sum, hook) => sum + (hook.runs ?? 1), 0)
  const hookRunOutcomeUnknown = hooks.reduce(
    (sum, hook) => sum + (hook.status === 'unknown' ? hook.runs ?? 1 : 0),
    0
  )
  const modelSegments = modelSegmentsFrom(args.events)
  const assistantSegments = modelSegments.filter((segment) => segment.kind === 'text')
  const assistantText = assistantSegments.map((segment) => segment.text).join('')
  const assistantContentRefs = assistantSegments.flatMap((segment) => segment.contentRefs ?? [])
  const fileMap = new Map<string, 'read' | 'write' | 'edit'>()
  for (const event of args.events) {
    if (event.stage !== 'tool_result' && event.filePath && event.fileOp) fileMap.set(event.filePath, event.fileOp)
  }
  const diffSnapshots = limitTurnDiffPatchBytes(args.events.flatMap((event) => event.turnDiff ? [event.turnDiff] : []))
  const diffs = diffSnapshots.map((diff) => {
    const { version: _version, ...record } = diff
    return record
  })
  const capturedDiffs = diffs.filter((diff) => diff.status === 'captured')
  const incompletePatchReasons = new Set(diffs.flatMap((diff) => diff.files.flatMap((file) =>
    file.patchStatus === 'truncated' && !file.patchContent?.contentRef
      ? ['truncated']
      : file.patchStatus === 'unavailable'
        ? [file.patchReason ?? 'unknown']
        : []
  )))
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
  const assistantCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['assistant_response']))
  const callCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['tool_input', 'tool_response']))
  const modelSegmentCaptureReason = joinOmissionReasons(captureOmissionReasons(args.events, ['assistant_response', 'model_segments']))
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

  // Admission lifecycle is one supplementary message, never an extra logical turn.
  const steerById = new Map<string, NonNullable<TraceEvent['steer']>>()
  for (const event of args.events) {
    if (event.kind === 'human' && event.stage === 'steer' && event.steer) steerById.set(event.steer.messageId, event.steer)
  }
  const steers = [...steerById.values()].map(({ attachments, ...steer }) => ({
    ...steer,
    attachments: attachments.map(attachment => {
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      return { name: attachment.name, mimeType: attachment.mimeType, size: bytes.byteLength, sha256: hash(bytes) }
    })
  }))

  return {
    user: args.userText != null
      ? available({ text: args.userText, textHash: hash(args.userText), ...(steers.length > 0 ? { steers } : {}) }, [source])
      : unavailable('top-level user prompt was not observable', [source]),
    assistant: !observable.assistant
      ? unavailable('provider does not expose assistant text to lifecycle hooks', [source])
      : assistantText
        ? assistantCaptureReason
          ? partial({
              text: assistantText,
              textHash: hash(assistantText),
              ...(assistantContentRefs.length > 0 ? { contentRefs: assistantContentRefs } : {})
            }, [source], assistantCaptureReason, 'exact')
          : available({
              text: assistantText,
              textHash: hash(assistantText),
              ...(assistantContentRefs.length > 0 ? { contentRefs: assistantContentRefs } : {})
            }, [source])
        : partial({}, [source], assistantCaptureReason ?? 'assistant text was not present in captured events'),
    modelSegments: !observable.assistant
      ? unavailable('provider does not expose model output to lifecycle hooks', [source])
      : modelSegmentCaptureReason
        ? partial(modelSegments, [source], modelSegmentCaptureReason, 'exact')
        : available(modelSegments, [source]),
    tools: !observable.tools
      ? unavailable('provider tool events were not observable', [source])
      : omittedCallSections.has('tools') || (!!callCaptureReason && tools.length > 0)
        ? partial(tools, [source], joinOmissionReasons([
            omittedCallSections.has('tools') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more tool call contents are missing, partial or limited; inspect content provenance' : 'one or more tool call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(tools, [source]),
    skills: !observable.skills
      ? unavailable('provider skill events were not observable', [source])
      : omittedCallSections.has('skills') || (!!callCaptureReason && skills.length > 0)
        ? partial(skills, [source], joinOmissionReasons([
            omittedCallSections.has('skills') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more skill call contents are missing, partial or limited; inspect content provenance' : 'one or more skill call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(skills, [source]),
    mcps: !observable.mcps
      ? unavailable('provider MCP events were not observable', [source])
      : omittedCallSections.has('mcps') || (!!callCaptureReason && mcps.length > 0)
        ? partial(mcps, [source], joinOmissionReasons([
            omittedCallSections.has('mcps') ? (isFullToolContentPolicy(args.toolContentPolicy) ? 'one or more MCP call contents are missing, partial or limited; inspect content provenance' : 'one or more MCP call payloads were omitted by the record byte budget') : undefined,
            callCaptureReason
          ])!, 'exact')
        : available(mcps, [source]),
    hooks: !observable.hooks
      ? unavailable('provider hook runtime events were not observable', [source])
      : hooks.length > 0 && !hookRunsObserved
        ? partial(
            hooks,
            [source],
            'provider only delivered hook lifecycle events; per-hook command, outcome and exit code were not observable',
            'inferred'
          )
        : hookRunOutcomeUnknown > 0
          ? partial(
              hooks,
              [source],
              `${hookRunOutcomeUnknown} of ${hookRunTotal} hook runs have no observed outcome; ` +
                'a zero failure count over this section is not proof that every hook succeeded',
              'inferred'
            )
          : available(hooks, [source]),
    usage: !observable.usage
      ? unavailable('provider usage was not observable', [source])
      : usage
        ? usage.credits || providerUsageResultEvents(args.events).some((event) => event.runtimeMetadata?.usageComplete === false)
          ? partial(usage, [source], 'one or more usage counters have partial coverage; inspect credits and context provenance', usage.contextTokens != null ? usage.contextUsageQuality ?? 'inferred' : 'exact')
          : available(usage, [source], usage.contextTokens != null ? usage.contextUsageQuality ?? 'inferred' : 'exact')
        : unavailable('no authoritative usage event was captured', [source]),
    compactions: available(compactions, [source]),
    ...(modelTiming
      ? {
          modelTiming:
            modelTiming.status === 'unavailable'
              ? { ...unavailable(modelTiming.omissionReason ?? 'model timing was unavailable', [source]), value: modelTiming.value }
              : modelTiming.status === 'available' && !modelSegmentCaptureReason
                ? available(modelTiming.value, [source], modelTiming.quality)
                : partial(
                  modelTiming.value,
                  [source],
                  joinOmissionReasons([
                    modelTiming.status === 'partial' ? modelTiming.omissionReason ?? 'model timing coverage was incomplete' : undefined,
                    modelSegmentCaptureReason
                  ]) ?? 'model timing coverage was incomplete',
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
        : capturedDiffs.length === diffs.length && incompletePatchReasons.size === 0
          ? available(diffs, [source])
        : capturedDiffs.length > 0
            ? partial(
                diffs,
                [source],
                capturedDiffs.length < diffs.length
                  ? 'one or more repository snapshots were unavailable'
                  : `one or more file patches were omitted or truncated: ${[...incompletePatchReasons].join(', ')}`,
                'exact'
              )
            : {
                status: 'unavailable',
                quality: 'unavailable',
                source: [source],
                value: diffs,
                omissionReason: 'no repository snapshot was captured'
              },
    dangerousOperations: !observable.tools
      ? unavailable('tool evidence was unavailable', [source])
      : dangerCoverage === 'unsupported'
        ? unavailable('danger classification is unsupported for this Provider', [source])
        : available(dangers, [source]),
    errors: observable.errors ? available(errors, [source]) : unavailable('provider error events were not observable', [source]),
    interventions: observable.interventions
      ? available(interventions, [source])
      : unavailable('provider user-input events were not observable', [source])
  }
}
