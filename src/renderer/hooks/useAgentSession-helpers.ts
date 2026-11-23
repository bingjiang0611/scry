import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentInputAttachment, AgentQuestionRequest, AgentStartRequest, AgentStopState } from '@shared/runtime'
import type { ParsedTurn, TraceBacklogState } from '../env'
import type { Turn } from '../format'

export interface TurnDoneEvent {
  runId: string
  sessionId?: string
  providerTurnId?: string
  forkTurnId?: string
}

export interface TurnErrorEvent {
  runId: string
  message: string
  hint?: string
}

export type RunLifecycleDelta =
  | { kind: 'done'; event: TurnDoneEvent }
  | { kind: 'error'; event: TurnErrorEvent }

export interface AgentSessionCallbacks {
  onTurnDone?: (event: TurnDoneEvent) => void
  onError?: (event: TurnErrorEvent) => void
}

function mergeProgressiveTrace(snapshot: TraceEvent, local: TraceEvent): TraceEvent {
  const longerPrefix = (remote: string | undefined, current: string | undefined): string | undefined => {
    if (remote === undefined) return current
    if (current === undefined) return remote
    if (current.startsWith(remote)) return current
    return remote
  }
  return {
    ...local,
    ...snapshot,
    text: longerPrefix(snapshot.text, local.text),
    thinking: longerPrefix(snapshot.thinking, local.thinking),
    llmPerformance: local.llmPerformance && (!snapshot.llmPerformance ||
      Date.parse(local.llmPerformance.observedAt) > Date.parse(snapshot.llmPerformance.observedAt))
      ? local.llmPerformance : snapshot.llmPerformance
  }
}

export function mergeActiveRun(prev: Turn[], run: Turn): Turn[] {
  const index = prev.findIndex((turn) => turn.runId === run.runId)
  if (index === -1) return [...prev, run]
  const localById = new Map(prev[index].items.map((event) => [event.id, event]))
  const ids = new Set(run.items.map((event) => event.id))
  const restored = run.items.map((event) => {
    const local = localById.get(event.id)
    return local ? mergeProgressiveTrace(event, local) : event
  })
  const extra = prev[index].items.filter((event) => !ids.has(event.id))
  const next = [...prev]
  next[index] = {
    ...prev[index],
    ...run,
    attachments: run.attachments ?? prev[index].attachments,
    items: [...restored, ...extra]
  }
  return next
}

export function mergeRecoveredRun(prev: Turn[], run: Turn): Turn[] {
  const local = prev.find((turn) => turn.runId === run.runId)
  const merged = mergeActiveRun(prev, run)
  if (!local || (!local.done && !local.error)) return merged
  return merged.map((turn) => turn.runId === run.runId ? {
    ...turn, done: true,
    error: local.error ?? turn.error,
    errorHint: local.errorHint ?? turn.errorHint,
    providerTurnId: local.providerTurnId ?? turn.providerTurnId,
    forkTurnId: local.forkTurnId ?? turn.forkTurnId
  } : turn)
}

export const markTurnDone = (prev: Turn[], runId: string, providerTurnId?: string, forkTurnId?: string): Turn[] =>
  prev.map((turn) => (turn.runId === runId ? {
    ...turn,
    done: true,
    ...(providerTurnId ? { providerTurnId } : {}),
    ...((forkTurnId ?? providerTurnId) ? { forkTurnId: forkTurnId ?? providerTurnId } : {})
  } : turn))

export const markTurnError = (prev: Turn[], event: TurnErrorEvent): Turn[] =>
  prev.map((turn) =>
    turn.runId === event.runId ? { ...turn, done: true, error: event.message, errorHint: event.hint } : turn
  )

export const replayRunLifecycleDeltas = (prev: Turn[], deltas: RunLifecycleDelta[]): Turn[] =>
  deltas.reduce(
    (turns, delta) =>
      delta.kind === 'done'
        ? markTurnDone(turns, delta.event.runId, delta.event.providerTurnId, delta.event.forkTurnId)
        : markTurnError(turns, delta.event),
    prev
  )

export const terminalEvidenceOf = (items: readonly TraceEvent[]): TraceEvent[] =>
  items.filter((item) => item.kind === 'harness' && (item.stage === 'result' || item.stage === 'session_diff' || item.stage === 'credit_usage'))

export const hasTerminalResult = (turn: Turn): boolean =>
  turn.items.some((item) => item.kind === 'harness' && item.stage === 'result')

export const needsTerminalEvidence = (turn: Turn): boolean =>
  !hasTerminalResult(turn) || (turn.items.some((item) => item.upstreamProvider === 'qoder' || item.contextProvider === 'qoder' ||
    item.modelUsage?.some((row) => row.upstreamProvider === 'qoder')) && !turn.items.some((item) => item.creditUsage))

export const appendMissingTraceItems = (prev: Turn[], runId: string, events: readonly TraceEvent[]): Turn[] => {
  if (events.length === 0) return prev
  let changed = false
  const next = prev.map((turn) => {
    if (turn.runId !== runId) return turn
    const known = new Set(turn.items.map((item) => item.id))
    const missing = events.filter((event) => !known.has(event.id))
    if (missing.length === 0) return turn
    changed = true
    return { ...turn, items: [...turn.items, ...missing] }
  })
  return changed ? next : prev
}

export const currentVisibleRunId = (turns: Turn[]): string | null =>
  [...turns].reverse().find((turn) => !turn.pendingStart && !turn.done && !turn.error)?.runId ?? null

export interface TraceLiveHealth {
  degraded: boolean
  skippedEvents: number
}

export const TRACE_LIVE_HEALTHY: TraceLiveHealth = { degraded: false, skippedEvents: 0 }

export const TRACE_LIVE_UNAVAILABLE: TraceLiveHealth = { degraded: true, skippedEvents: 0 }

export function traceLiveHealthOf(state: TraceBacklogState): TraceLiveHealth {
  return { degraded: state.degraded, skippedEvents: state.skippedEvents }
}

export interface TraceResyncBridge {
  focusedRunSnapshot?: () => Promise<ActiveRun | null>
  activeRun: () => Promise<ActiveRun | null>
  traceResynchronized?: () => Promise<unknown>
}

export interface TraceResyncOutcome {
  aligned: boolean
  acknowledged: boolean
}

export async function resynchronizeLiveTrace(
  bridge: TraceResyncBridge,
  apply: (run: ActiveRun) => void,
  isCleared: (runId: string) => boolean = () => false
): Promise<TraceResyncOutcome> {
  let run: ActiveRun | null
  try {
    run = bridge.focusedRunSnapshot ? await bridge.focusedRunSnapshot() : await bridge.activeRun()
  } catch {
    return { aligned: false, acknowledged: false }
  }
  if (!run || isCleared(run.runId)) return { aligned: false, acknowledged: false }
  apply(run)
  if (!bridge.traceResynchronized) return { aligned: true, acknowledged: false }
  try {
    await bridge.traceResynchronized()
  } catch {
    return { aligned: true, acknowledged: false }
  }
  return { aligned: true, acknowledged: true }
}

export function rendererTraceResyncBridge(): TraceResyncBridge {
  return {
    ...(typeof window.scry.focusedRunSnapshot === 'function'
      ? { focusedRunSnapshot: () => window.scry.focusedRunSnapshot!() }
      : {}),
    activeRun: () => window.scry.activeRun(),
    ...(typeof window.scry.traceResynchronized === 'function'
      ? { traceResynchronized: () => window.scry.traceResynchronized!() }
      : {})
  }
}

export function acknowledgeTraceResync(): void {
  void window.scry.traceResynchronized?.().catch(() => {
  })
}

export type StopStateMap = Readonly<Record<string, AgentStopState>>

export function applyStopState(prev: StopStateMap, state: AgentStopState): StopStateMap {
  if (state.phase === 'settled') return clearStopState(prev, state.runId)
  const existing = prev[state.runId]
  if (existing && Date.parse(existing.updatedAt) > Date.parse(state.updatedAt)) return prev
  return { ...prev, [state.runId]: state }
}

export function clearStopState(prev: StopStateMap, runId: string): StopStateMap {
  if (!(runId in prev)) return prev
  const next = { ...prev }
  delete next[runId]
  return next
}

export function turnBlocksInput(turn: Turn): boolean {
  return !turn.done && !turn.error
}

export function sessionBusy(turns: Turn[], flags: { restoring: boolean; running: boolean }): boolean {
  if (flags.restoring) return true
  const inFlight = turns.filter(turnBlocksInput)
  if (inFlight.length > 0) return true
  return flags.running
}

export function clearSessionTurns(prev: Turn[], clearedRuns: Set<string>, maxTombstones = 512): Turn[] {
  prev.forEach((turn) => clearedRuns.add(turn.runId))
  while (clearedRuns.size > maxTombstones) {
    const oldest = clearedRuns.values().next().value
    if (oldest === undefined) break
    clearedRuns.delete(oldest)
  }
  return []
}

export function upsertPendingQuestion(prev: AgentQuestionRequest[], request: AgentQuestionRequest): AgentQuestionRequest[] {
  const index = prev.findIndex((item) => item.runId === request.runId && item.questionId === request.questionId)
  if (index === -1) return [...prev, request]
  const next = [...prev]
  next[index] = request
  return next
}

export const removePendingQuestion = (
  prev: AgentQuestionRequest[],
  event: { runId: string; questionId?: string }
): AgentQuestionRequest[] =>
  prev.filter((item) => item.runId !== event.runId || (event.questionId != null && item.questionId !== event.questionId))

export type PendingQuestionDelta =
  | { kind: 'open'; request: AgentQuestionRequest }
  | { kind: 'closed'; event: { runId: string; questionId?: string } }

export function replayPendingQuestionDeltas(
  snapshot: AgentQuestionRequest[],
  deltas: PendingQuestionDelta[]
): AgentQuestionRequest[] {
  return deltas.reduce(
    (current, delta) =>
      delta.kind === 'open'
        ? upsertPendingQuestion(current, delta.request)
        : removePendingQuestion(current, delta.event),
    snapshot
  )
}

export function restoredRunRuntimeState(
  runId: string | null,
  questionSnapshot: AgentQuestionRequest[],
  questionDeltas: PendingQuestionDelta[],
  lifecycleDeltas: RunLifecycleDelta[]
): { pendingQuestions: AgentQuestionRequest[]; running: boolean } {
  const terminal = runId != null && lifecycleDeltas.some((delta) => delta.event.runId === runId)
  return {
    pendingQuestions: terminal ? [] : replayPendingQuestionDeltas(questionSnapshot, questionDeltas),
    running: runId != null && !terminal
  }
}

export const parsedSessionTurns = (sessionId: string, parsed: ParsedTurn[], indexOffset = 0): Turn[] =>
  parsed.map((turn, index) => {
    const restored: Turn = {
      runId: turn.runId ?? `${sessionId}-${indexOffset + index}`,
      providerTurnId: turn.providerTurnId,
      forkTurnId: turn.forkTurnId,
      userText: turn.userText,
      items: turn.items,
      done: turn.done ?? true
    }
    if (turn.attachments) restored.attachments = turn.attachments
    if (turn.error) restored.error = turn.error
    if (turn.errorHint) restored.errorHint = turn.errorHint
    return restored
  })

function isReplaceablePartialTurn(sessionId: string, turn: Turn, activeRun: ActiveRun): boolean {
  if (turn.runId === activeRun.runId) return true
  const syntheticIndex = turn.runId.slice(`${sessionId}-`.length)
  const syntheticRunId = turn.runId.startsWith(`${sessionId}-`) && /^\d+$/.test(syntheticIndex)
  if (turn.userText !== activeRun.userText || !syntheticRunId) return false
  return !turn.items.some(
    (event) => event.kind === 'harness' && (event.stage === 'result' || event.stage === 'turn_diff')
  )
}

export function sessionTurnsWithActiveRun(
  sessionId: string,
  parsed: ParsedTurn[],
  activeRun?: ActiveRun | null,
  indexOffset = 0
): Turn[] {
  const turns = parsedSessionTurns(sessionId, parsed, indexOffset)
  if (!activeRun || activeRun.done) return turns
  const activeTurn: Turn = { ...activeRun }
  const exact = turns.findIndex((turn) => turn.runId === activeRun.runId)
  if (exact >= 0) turns[exact] = activeTurn
  else if (turns.length > 0 && isReplaceablePartialTurn(sessionId, turns[turns.length - 1], activeRun)) {
    turns[turns.length - 1] = activeTurn
  }
  else turns.push(activeTurn)
  return turns
}

export interface SessionHistoryWindow {
  sessionId: string
  projectionKey?: string
  offset: number
  totalTurns: number
  hasOlder: boolean
  sourceComplete?: boolean
  completeness: 'complete' | 'partial'
  pagedOlder?: boolean
}

export type OlderSessionPage = import('../env').SessionHistoryPage

export const sessionHistoryWindowOf = (
  sessionId: string,
  page: OlderSessionPage | null | undefined,
  loadedTurns: number
): SessionHistoryWindow =>
  page
    ? {
        sessionId,
        projectionKey: page.projection?.sessionKey,
        offset: page.offset,
        totalTurns: page.totalTurns,
        hasOlder: page.hasOlder,
        sourceComplete: page.sourceComplete,
        completeness: page.completeness
      }
    : { sessionId, offset: 0, totalTurns: loadedTurns, hasOlder: false, completeness: 'complete' }

export function prependOlderSessionTurns(
  prev: Turn[],
  window: SessionHistoryWindow | null,
  sessionId: string,
  page: OlderSessionPage
): { turns: Turn[]; window: SessionHistoryWindow } | null {
  if (!window || window.sessionId !== sessionId) return null
  if (page.totalTurns !== window.totalTurns) return null
  if (page.turns.length === 0) return null
  if (page.offset + page.turns.length !== window.offset) return null
  const older = parsedSessionTurns(sessionId, page.turns, page.offset)
  const existing = new Set(prev.map((turn) => turn.runId))
  return {
    turns: [...older.filter((turn) => !existing.has(turn.runId)), ...prev],
    window: {
      sessionId,
      offset: page.offset,
      totalTurns: page.totalTurns,
      hasOlder: page.hasOlder,
      sourceComplete: page.sourceComplete,
      completeness: page.hasOlder || page.sourceComplete === false ? 'partial' : 'complete',
      pagedOlder: true
    }
  }
}

export function buildAgentStartRequest(text: string, options: Omit<AgentStartRequest, 'prompt'> = {}): AgentStartRequest | null {
  const prompt = text.trim()
  const attachments = options.attachments ?? []
  if (!prompt && attachments.length === 0) return null
  return {
    ...options,
    prompt,
    commandId: options.commandId ?? `cmd-${crypto.randomUUID()}`,
    attachments: attachments.map((attachment) => ({ ...attachment })) as AgentInputAttachment[]
  }
}

export function visibleTurnsBeforeReplacement(
  turns: Turn[],
  replaceRunId: string | undefined,
  clearSession = false
): Turn[] {
  if (clearSession) return []
  if (!replaceRunId) return turns
  const index = turns.findIndex((turn) => turn.runId === replaceRunId)
  return index >= 0 ? turns.slice(0, index) : turns
}

export function beginOptimisticTurn(prev: Turn[], pendingRunId: string, request: AgentStartRequest): Turn[] {
  return [...prev, {
    runId: pendingRunId,
    pendingStart: true,
    providerId: request.providerId,
    agentProfileId: request.agentProfileId,
    cwd: request.cwd,
    externalSessionId: request.expectedExternalSessionId ?? undefined,
    userText: request.prompt,
    attachments: request.attachments,
    items: [],
    done: false
  }]
}

export function discardOptimisticTurn(prev: Turn[], pendingRunId: string): Turn[] {
  return prev.filter((turn) => turn.runId !== pendingRunId)
}

export function confirmOptimisticTurn(
  prev: Turn[],
  pendingRunId: string,
  runId: string,
  request: AgentStartRequest,
  lifecycleDeltas: RunLifecycleDelta[] = []
): Turn[] {
  const withoutPending = discardOptimisticTurn(prev, pendingRunId)
  const replaceRunId = request.forkLastTurn?.replaceRunId ?? request.restartLastTurn?.replaceRunId
  const visible = visibleTurnsBeforeReplacement(withoutPending, replaceRunId, !!request.restartLastTurn)
  const index = visible.findIndex((turn) => turn.runId === runId)
  if (index === -1) {
    return replayRunLifecycleDeltas(
      [...visible, {
        runId,
        providerId: request.providerId,
        agentProfileId: request.agentProfileId,
        cwd: request.cwd,
        externalSessionId: request.expectedExternalSessionId ?? undefined,
        userText: request.prompt,
        attachments: request.attachments,
        items: [],
        done: false
      }],
      lifecycleDeltas
    )
  }
  const next = [...visible]
  next[index] = {
    ...next[index],
    pendingStart: undefined,
    providerId: request.providerId,
    agentProfileId: request.agentProfileId,
    cwd: request.cwd,
    externalSessionId: request.expectedExternalSessionId ?? undefined,
    userText: request.prompt,
    attachments: request.attachments
  }
  return replayRunLifecycleDeltas(next, lifecycleDeltas)
}
