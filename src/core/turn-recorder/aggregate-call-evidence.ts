import { captureToolContent, limitToolContent, type ToolContentPolicy } from './tool-content.js'
import { logicalCallEventsForTurn } from '../../shared/logical-calls.js'
import { mcpCallsForEvent, type McpCallRef, type TraceEvent } from '../../shared/trace.js'
import { type TurnCall, type TurnCallStatus } from '../../shared/turn-record.js'

const TURN_CALL_INPUT_MAX_BYTES = 8 * 1024
const TURN_CALL_DETAIL_MAX_BYTES = 128 * 1024

export type CallSection = 'tools' | 'skills' | 'mcps'

interface CallCandidate {
  call: TurnCall
  event: TraceEvent
  section: CallSection
}

function callStatus(event: TraceEvent, result?: TraceEvent): TurnCallStatus {
  if (!result) return event.isError ? 'failed' : 'unknown'
  if (result.isError) return 'failed'
  return 'success'
}

export function outputSummary(value: string | undefined): string | undefined {
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

export function aggregateCallEvidence(
  events: TraceEvent[],
  resultById: Map<string, TraceEvent>,
  eventOrder: Map<TraceEvent, number>,
  toolContentPolicy?: ToolContentPolicy
): {
  starts: TraceEvent[]
  tools: TurnCall[]
  skills: TurnCall[]
  mcps: TurnCall[]
  omittedCallSections: Set<CallSection>
} {
  const logicalEvents = logicalCallEventsForTurn(events)
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
  let remainingContentBytes = toolContentPolicy?.toolContentTurnBytes ?? 128 * 1024
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
  return {
    starts,
    tools: toolCandidates.map(({ call }) => call),
    skills: skillCandidates.map(({ call }) => call),
    mcps: mcpCandidates.map(({ call }) => call),
    omittedCallSections
  }
}
