import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type {
  AgentInputAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentStartRequest,
  AgentStopState
} from '@shared/runtime'
import { applyTraceBatch } from '../format'
import type { ParsedTurn, TraceBacklogState } from '../env'
import type { Turn } from '../format'

interface TurnDoneEvent {
  runId: string
  sessionId?: string
  providerTurnId?: string
  forkTurnId?: string
}

interface TurnErrorEvent {
  runId: string
  message: string
  hint?: string
}

type RunLifecycleDelta =
  | { kind: 'done'; event: TurnDoneEvent }
  | { kind: 'error'; event: TurnErrorEvent }

interface AgentSessionCallbacks {
  onTurnDone?: (event: TurnDoneEvent) => void
  onError?: (event: TurnErrorEvent) => void
}

export function mergeActiveRun(prev: Turn[], run: Turn): Turn[] {
  const index = prev.findIndex((turn) => turn.runId === run.runId)
  if (index === -1) return [...prev, run]
  const ids = new Set(run.items.map((event) => event.id))
  const extra = prev[index].items.filter((event) => !ids.has(event.id))
  const next = [...prev]
  next[index] = {
    ...prev[index],
    ...run,
    attachments: run.attachments ?? prev[index].attachments,
    items: [...run.items, ...extra]
  }
  return next
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

export const currentVisibleRunId = (turns: Turn[]): string | null =>
  [...turns].reverse().find((turn) => !turn.done && !turn.error)?.runId ?? null

/**
 * live trace 镜像的健康状态。degraded 表示实时视图落后于权威证据（归档/runState 仍完整），
 * resyncRequired 表示积压已排空、可以用权威快照重新对齐。
 */
export interface TraceLiveHealth {
  degraded: boolean
  skippedEvents: number
}

export const TRACE_LIVE_HEALTHY: TraceLiveHealth = { degraded: false, skippedEvents: 0 }

export function traceLiveHealthOf(state: TraceBacklogState): TraceLiveHealth {
  return { degraded: state.degraded, skippedEvents: state.skippedEvents }
}

/** live trace 降级恢复需要的 bridge 子集；单独抽出来是为了能直接测 null / 抛错 / 终态三条路径。 */
export interface TraceResyncBridge {
  /** 忽略 done 的权威快照口。旧 preload 可能没有，此时只能退回 activeRun。 */
  focusedRunSnapshot?: () => Promise<ActiveRun | null>
  activeRun: () => Promise<ActiveRun | null>
  traceResynchronized?: () => Promise<unknown>
}

export interface TraceResyncOutcome {
  /** 是否真的拿到并应用了权威快照。false 时必须保持降级。 */
  aligned: boolean
  acknowledged: boolean
}

/**
 * 用权威快照重新对齐 live 视图。
 *
 * 硬性规则：只有在成功拿到快照**并且**已经把它应用到时间线之后，才向 main 确认。
 * null、抛错、或该 run 已被清空都算没有证据，一律保持降级，绝不清除降级标记。
 *
 * 快照优先用 focusedRunSnapshot：activeRun 会因为 done=true 返回 null，
 * 那样终态阶段被跳过的事件永远补不回来。
 */
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
  // 旧 preload 没有确认口：对齐已经发生，但 main 那边的降级标记没人清得掉，
  // 不能因为调用被可选链吞掉就上报 acknowledged。
  if (!bridge.traceResynchronized) return { aligned: true, acknowledged: false }
  try {
    await bridge.traceResynchronized()
  } catch {
    // 确认没送到不影响已经完成的对齐：main 仍保持 resyncRequired，下次健康事件会再触发。
    return { aligned: true, acknowledged: false }
  }
  return { aligned: true, acknowledged: true }
}

function rendererTraceResyncBridge(): TraceResyncBridge {
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

/** 权威历史整体替换可见时间线后的确认；此处对齐已由 main 交付的历史本身证明。 */
function acknowledgeTraceResync(): void {
  void window.scry.traceResynchronized?.().catch(() => {
    // 确认没送到不影响正确性：main 仍然保持 resyncRequired，下次健康事件会再触发一次。
  })
}

export type StopStateMap = Readonly<Record<string, AgentStopState>>

/**
 * 停止进度是 main 的权威快照；乱序到达时保留较新的 updatedAt，settled 直接摘掉标记
 * （真正的终态由 turnDone/error 表达，不由停止状态冒充）。
 */
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

/**
 * 这一轮是否还占着会话。停止请求的任何阶段都不解除占用——包括 provider_unsettled：
 * main 的 admission 仍按 providerSettled 判断，未 settle 时同一会话的新一轮会被直接拒绝
 * （waitForCompletedRuns 见到 done=false 立刻返回 false）。所以 UI 必须继续算 busy，
 * 让新消息进入队列而不是立刻发送并失败。输入框本身保持可编辑。
 */
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

/**
 * indexOffset 是本页首轮在整个会话里的序号：分页后合成 runId 必须继续全局唯一，
 * 否则不同页的无 runId 历史轮次会撞名并互相覆盖。
 */
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

/** renderer 侧的历史窗口：它描述当前已挂载的是哪一段轮次，以及更早轮次是否仍可取回。 */
export interface SessionHistoryWindow {
  sessionId: string
  offset: number
  totalTurns: number
  hasOlder: boolean
  completeness: 'complete' | 'partial'
}

export interface OlderSessionPage {
  turns: ParsedTurn[]
  offset: number
  totalTurns: number
  hasOlder: boolean
  completeness: 'complete' | 'partial'
}

export const sessionHistoryWindowOf = (
  sessionId: string,
  page: OlderSessionPage | null | undefined,
  loadedTurns: number
): SessionHistoryWindow =>
  page
    ? {
        sessionId,
        offset: page.offset,
        totalTurns: page.totalTurns,
        hasOlder: page.hasOlder,
        completeness: page.completeness
      }
    : { sessionId, offset: 0, totalTurns: loadedTurns, hasOlder: false, completeness: 'complete' }

/**
 * 只接受严格相邻的更早页：offset + 本页轮数必须等于当前窗口 offset，且 sessionId 与总轮数一致。
 * 任何过期/错位/跨会话的响应都被丢弃而不是拼接，避免把别的会话的轮次混进时间线。
 */
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
      completeness: page.hasOlder ? 'partial' : 'complete'
    }
  }
}

export function buildAgentStartRequest(text: string, options: Omit<AgentStartRequest, 'prompt'> = {}): AgentStartRequest | null {
  const prompt = text.trim()
  const attachments = options.attachments ?? []
  if (!prompt && attachments.length === 0) return null
  return { ...options, prompt, attachments: attachments.map((attachment) => ({ ...attachment })) as AgentInputAttachment[] }
}

export function visibleTurnsBeforeReplacement(turns: Turn[], replaceRunId: string | undefined): Turn[] {
  if (!replaceRunId) return turns
  const index = turns.findIndex((turn) => turn.runId === replaceRunId)
  return index >= 0 ? turns.slice(0, index) : turns
}

export function useAgentSession(callbacks: AgentSessionCallbacks = {}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<AgentQuestionRequest[]>([])
  const [stopStates, setStopStates] = useState<StopStateMap>({})
  const [traceHealth, setTraceHealth] = useState<TraceLiveHealth>(TRACE_LIVE_HEALTHY)
  const [historyWindow, setHistoryWindow] = useState<SessionHistoryWindow | null>(null)
  // 窗口需要同步可读：拼接更早一页时必须在发起前就能判定响应是否过期。
  const historyWindowRef = useRef<SessionHistoryWindow | null>(null)
  const clearedRuns = useRef<Set<string>>(new Set())
  const focusedRunIdRef = useRef<string | null>(null)
  const focusLifecycleDeltasRef = useRef<{ runId: string; deltas: RunLifecycleDelta[] } | null>(null)
  const focusQuestionDeltasRef = useRef<{ runId: string; deltas: PendingQuestionDelta[] } | null>(null)
  const pendingStartLifecycleRef = useRef<RunLifecycleDelta[] | null>(null)
  const traceBuf = useRef<TraceEvent[]>([])
  const rafId = useRef<number | null>(null)
  const flushTimeoutId = useRef<number | null>(null)
  const callbacksRef = useRef(callbacks)

  callbacksRef.current = callbacks

  const currentRunId = useMemo(() => currentVisibleRunId(turns), [turns])
  const busy = useMemo(() => sessionBusy(turns, { restoring, running }), [restoring, running, turns])

  const flushTrace = useCallback((): void => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current)
    if (flushTimeoutId.current != null) window.clearTimeout(flushTimeoutId.current)
    rafId.current = null
    flushTimeoutId.current = null
    const buf = traceBuf.current
    if (buf.length === 0) return
    traceBuf.current = []
    setTurns((prev) => applyTraceBatch(prev, buf, clearedRuns.current))
  }, [])

  const prepareRunFocus = useCallback((runId: string): void => {
    focusedRunIdRef.current = runId
    clearedRuns.current.delete(runId)
    focusLifecycleDeltasRef.current = { runId, deltas: [] }
    focusQuestionDeltasRef.current = { runId, deltas: [] }
  }, [])

  const clearTurns = useCallback((_options: { preserveRunning?: boolean } = {}): void => {
    setTurns((prev) => clearSessionTurns(prev, clearedRuns.current))
    focusedRunIdRef.current = null
    focusLifecycleDeltasRef.current = null
    focusQuestionDeltasRef.current = null
    setSelected(null)
    setPendingQuestions([])
    setStopStates({})
    historyWindowRef.current = null
    setHistoryWindow(null)
    setRunning(false)
  }, [])

  /**
   * 拼接更早一页历史。返回是否真的拼上了；过期或错位的响应返回 false 并保留现有时间线。
   */
  const prependOlderTurns = useCallback((sessionId: string, page: OlderSessionPage | null): boolean => {
    if (!page) return false
    const current = historyWindowRef.current
    const validated = prependOlderSessionTurns([], current, sessionId, page)
    if (!validated) return false
    historyWindowRef.current = validated.window
    setHistoryWindow(validated.window)
    setTurns((prev) => prependOlderSessionTurns(prev, current, sessionId, page)?.turns ?? prev)
    return true
  }, [])

  const replaceWithParsedSession = useCallback(
    (
      sessionId: string,
      parsed: ParsedTurn[],
      options: {
        activeRun?: ActiveRun | null
        preserveFocusDeltas?: boolean
        /** main 交付的分页窗口；缺省表示这一批就是完整历史。 */
        page?: OlderSessionPage | null
      } = {}
    ): void => {
      const activeRun = options.activeRun && !options.activeRun.done ? options.activeRun : null
      focusedRunIdRef.current = activeRun?.runId ?? null
      if (activeRun) clearedRuns.current.delete(activeRun.runId)
      const lifecycleDeltas =
        activeRun && focusLifecycleDeltasRef.current?.runId === activeRun.runId
          ? focusLifecycleDeltasRef.current.deltas
          : []
      const questionDeltas =
        activeRun && focusQuestionDeltasRef.current?.runId === activeRun.runId
          ? focusQuestionDeltasRef.current.deltas
          : []
      const runtimeState = restoredRunRuntimeState(
        activeRun?.runId ?? null,
        activeRun?.pendingQuestions ?? [],
        questionDeltas,
        lifecycleDeltas
      )
      const nextWindow = sessionHistoryWindowOf(sessionId, options.page, parsed.length)
      historyWindowRef.current = nextWindow
      setHistoryWindow(nextWindow)
      setTurns((prev) => {
        const snapshot = sessionTurnsWithActiveRun(sessionId, parsed, activeRun, options.page?.offset ?? 0)
        if (!activeRun) return snapshot
        const local = prev.find((turn) => turn.runId === activeRun.runId)
        const merged = local ? mergeActiveRun([local], activeRun)[0] : activeRun
        return replayRunLifecycleDeltas(
          snapshot.map((turn) => (turn.runId === activeRun.runId ? merged : turn)),
          lifecycleDeltas
        )
      })
      setSelected(null)
      setPendingQuestions(runtimeState.pendingQuestions)
      setStopStates(activeRun?.stopState && runtimeState.running ? { [activeRun.runId]: activeRun.stopState } : {})
      // 用 main 交付的权威历史整体替换了可见时间线，就等于对齐已被证明：
      // 清除本地降级显示，并确认给 main，避免全局降级标记污染后续轮次。
      // 空替换（占位刷新）不算证据，此时只保留原状态。
      if (options.page != null || parsed.length > 0) {
        setTraceHealth(TRACE_LIVE_HEALTHY)
        acknowledgeTraceResync()
      }
      setRunning(runtimeState.running)
      if (!options.preserveFocusDeltas) {
        focusLifecycleDeltasRef.current = null
        focusQuestionDeltasRef.current = null
      }
    },
    []
  )

  const send = useCallback(async (
    text: string,
    options: Omit<AgentStartRequest, 'prompt'> = {}
  ): Promise<string | null> => {
    const request = buildAgentStartRequest(text, options)
    if (!request) return null
    focusedRunIdRef.current = null
    pendingStartLifecycleRef.current = []
    setRunning(true)
    let runId: string
    try {
      runId = (await window.scry.start(request)).runId
    } catch (error) {
      pendingStartLifecycleRef.current = null
      setRunning(false)
      throw error
    }
    focusedRunIdRef.current = runId
    const lifecycleDeltas = (pendingStartLifecycleRef.current ?? []).filter((delta) => delta.event.runId === runId)
    pendingStartLifecycleRef.current = null
    setTurns((prev) => {
      const replaceRunId = request.forkLastTurn?.replaceRunId ?? request.restartLastTurn?.replaceRunId
      const visible = visibleTurnsBeforeReplacement(prev, replaceRunId)
      const index = visible.findIndex((turn) => turn.runId === runId)
      if (index === -1) {
        return replayRunLifecycleDeltas(
          [...visible, { runId, userText: request.prompt, attachments: request.attachments, items: [], done: false }],
          lifecycleDeltas
        )
      }
      const next = [...visible]
      next[index] = { ...next[index], userText: request.prompt, attachments: request.attachments }
      return replayRunLifecycleDeltas(next, lifecycleDeltas)
    })
    if (lifecycleDeltas.length > 0) setRunning(false)
    return runId
  }, [])

  const stopRun = useCallback(async (): Promise<void> => {
    if (!currentRunId) return
    await window.scry.stop(currentRunId)
  }, [currentRunId])

  const answerQuestion = useCallback(async (response: AgentQuestionResponse): Promise<void> => {
    if (typeof window.scry.answerQuestion !== 'function') throw new Error('当前 Scry preload 不支持回答 Claude 提问，请重启应用')
    const accepted = await window.scry.answerQuestion(response)
    if (!accepted) throw new Error('该提问已结束或回答无效')
    setPendingQuestions((prev) => removePendingQuestion(prev, response))
  }, [])

  useEffect(() => {
    let questionSnapshot: AgentQuestionRequest[] | null = null
    let hydratingQuestions = true
    let hydratedRun: ActiveRun | null = null
    let hydratingLifecycle = true
    const questionDeltas: PendingQuestionDelta[] = []
    const lifecycleDeltas: RunLifecycleDelta[] = []
    const receiveQuestionDelta = (delta: PendingQuestionDelta): void => {
      const runId = delta.kind === 'open' ? delta.request.runId : delta.event.runId
      if (clearedRuns.current.has(runId)) return
      if (hydratingQuestions) {
        questionDeltas.push(delta)
        return
      }
      if (focusedRunIdRef.current == null) focusedRunIdRef.current = runId
      if (focusedRunIdRef.current !== runId) return
      if (focusQuestionDeltasRef.current?.runId === runId) {
        focusQuestionDeltasRef.current.deltas.push(delta)
      }
      setPendingQuestions((prev) => replayPendingQuestionDeltas(prev, [delta]))
    }
    const receiveLifecycleDelta = (delta: RunLifecycleDelta): void => {
      const runId = delta.event.runId
      if (hydratingLifecycle) lifecycleDeltas.push(delta)
      if (pendingStartLifecycleRef.current) pendingStartLifecycleRef.current.push(delta)
      if (focusLifecycleDeltasRef.current?.runId === runId) {
        focusLifecycleDeltasRef.current.deltas.push(delta)
      }
      if (clearedRuns.current.has(runId)) return
      if (focusedRunIdRef.current == null) focusedRunIdRef.current = runId
      if (focusedRunIdRef.current !== runId) return
      setTurns((prev) => replayRunLifecycleDeltas(prev, [delta]))
      setPendingQuestions((prev) => removePendingQuestion(prev, delta.event))
      // 终态到达才能摘掉停止进度提示；它之前的每个阶段都只是请求而不是证据。
      setStopStates((prev) => clearStopState(prev, runId))
      setRunning(false)
    }

    const offTrace = window.scry.onTrace((event) => {
      if (clearedRuns.current.has(event.runId)) return
      if (focusedRunIdRef.current == null) focusedRunIdRef.current = event.runId
      if (focusedRunIdRef.current !== event.runId) return
      traceBuf.current.push(event)
      if (rafId.current == null) rafId.current = requestAnimationFrame(flushTrace)
      if (flushTimeoutId.current == null) flushTimeoutId.current = window.setTimeout(flushTrace, 250)
    })

    const offStopState =
      typeof window.scry.onStopState === 'function'
        ? window.scry.onStopState((state) => {
            if (clearedRuns.current.has(state.runId)) return
            setStopStates((prev) => applyStopState(prev, state))
          })
        : () => {}

    // live 镜像降级后，用 main 的权威 run 快照重新对齐。只有真的拿到并应用了快照才确认；
    // 拿不到（null / 抛错 / 已被清空）就保持降级，让 UI 继续如实显示落后状态。
    const offTraceHealth =
      typeof window.scry.onTraceHealth === 'function'
        ? window.scry.onTraceHealth((state) => {
            setTraceHealth(traceLiveHealthOf(state))
            if (!state.resyncRequired) return
            void resynchronizeLiveTrace(
              rendererTraceResyncBridge(),
              (run) => setTurns((prev) => mergeActiveRun(prev, run)),
              (runId) => clearedRuns.current.has(runId)
            )
          })
        : () => {}

    const offQuestion =
      typeof window.scry.onQuestion === 'function'
        ? window.scry.onQuestion((request) => receiveQuestionDelta({ kind: 'open', request }))
        : () => {}
    const offQuestionClosed =
      typeof window.scry.onQuestionClosed === 'function'
        ? window.scry.onQuestionClosed((event) => receiveQuestionDelta({ kind: 'closed', event }))
        : () => {}

    window.scry
      .activeRun()
      .then((run) => {
        hydratedRun = !run || run.done ? null : run
        questionSnapshot = !run || run.done ? [] : run.pendingQuestions ?? []
        if (!run || run.done) return
        focusedRunIdRef.current = run.runId
        clearedRuns.current.delete(run.runId)
        setTurns((prev) => mergeActiveRun(prev, run))
        if (run.stopState) setStopStates((prev) => applyStopState(prev, run.stopState!))
        setRunning(true)
      })
      .finally(() => {
        hydratingLifecycle = false
        hydratingQuestions = false
        const runId = hydratedRun?.runId
        const currentLifecycle = runId ? lifecycleDeltas.filter((delta) => delta.event.runId === runId) : []
        const currentQuestions = runId
          ? questionDeltas.filter((delta) =>
              (delta.kind === 'open' ? delta.request.runId : delta.event.runId) === runId
            )
          : []
        if (currentLifecycle.length > 0) {
          setTurns((prev) => replayRunLifecycleDeltas(prev, currentLifecycle))
        }
        const runtimeState = restoredRunRuntimeState(
          runId ?? null,
          questionSnapshot ?? [],
          currentQuestions,
          currentLifecycle
        )
        setPendingQuestions((prev) =>
          restoredRunRuntimeState(
            runId ?? null,
            questionSnapshot ?? prev,
            currentQuestions,
            currentLifecycle
          ).pendingQuestions
        )
        setRunning(runtimeState.running)
        setRestoring(false)
      })

    const offDone = window.scry.onTurnDone((event) => {
      flushTrace()
      receiveLifecycleDelta({ kind: 'done', event })
      callbacksRef.current.onTurnDone?.(event)
    })

    const offError = window.scry.onError((event) => {
      flushTrace()
      receiveLifecycleDelta({ kind: 'error', event })
      callbacksRef.current.onError?.(event)
    })

    return () => {
      offTrace()
      offStopState()
      offTraceHealth()
      offQuestion()
      offQuestionClosed()
      offDone()
      offError()
      if (rafId.current != null) cancelAnimationFrame(rafId.current)
      if (flushTimeoutId.current != null) window.clearTimeout(flushTimeoutId.current)
    }
  }, [flushTrace])

  return {
    turns,
    selected,
    setSelected,
    pendingQuestions,
    stopStates,
    traceHealth,
    currentRunId,
    running,
    restoring,
    busy,
    send,
    answerQuestion,
    stopRun,
    prepareRunFocus,
    clearTurns,
    replaceWithParsedSession,
    historyWindow,
    prependOlderTurns
  }
}
