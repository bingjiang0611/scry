import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, AgentStartRequest } from '@shared/runtime'
import { applyTraceBatch } from '../format'
import type { ParsedTurn } from '../env'
import type { Turn } from '../format'

interface TurnDoneEvent {
  runId: string
  sessionId?: string
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

export const markTurnDone = (prev: Turn[], runId: string): Turn[] =>
  prev.map((turn) => (turn.runId === runId ? { ...turn, done: true } : turn))

export const markTurnError = (prev: Turn[], event: TurnErrorEvent): Turn[] =>
  prev.map((turn) =>
    turn.runId === event.runId ? { ...turn, done: true, error: event.message, errorHint: event.hint } : turn
  )

export const replayRunLifecycleDeltas = (prev: Turn[], deltas: RunLifecycleDelta[]): Turn[] =>
  deltas.reduce(
    (turns, delta) =>
      delta.kind === 'done' ? markTurnDone(turns, delta.event.runId) : markTurnError(turns, delta.event),
    prev
  )

export const currentVisibleRunId = (turns: Turn[]): string | null =>
  [...turns].reverse().find((turn) => !turn.done && !turn.error)?.runId ?? null

export function clearSessionTurns(prev: Turn[], clearedRuns: Set<string>): Turn[] {
  prev.forEach((turn) => clearedRuns.add(turn.runId))
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

export const parsedSessionTurns = (sessionId: string, parsed: ParsedTurn[]): Turn[] =>
  parsed.map((turn, index) => {
    const restored: Turn = { runId: `${sessionId}-${index}`, userText: turn.userText, items: turn.items, done: true }
    if (turn.attachments) restored.attachments = turn.attachments
    return restored
  })

export function sessionTurnsWithActiveRun(sessionId: string, parsed: ParsedTurn[], activeRun?: ActiveRun | null): Turn[] {
  const turns = parsedSessionTurns(sessionId, parsed)
  if (!activeRun || activeRun.done) return turns
  const activeTurn: Turn = { ...activeRun }
  const last = turns.length - 1
  if (last >= 0 && turns[last].userText === activeRun.userText) turns[last] = activeTurn
  else turns.push(activeTurn)
  return turns
}

export function buildAgentStartRequest(text: string, options: Omit<AgentStartRequest, 'prompt'> = {}): AgentStartRequest | null {
  const prompt = text.trim()
  const attachments = options.attachments ?? []
  if (!prompt && attachments.length === 0) return null
  return { ...options, prompt, attachments: attachments.map((attachment) => ({ ...attachment })) as AgentInputAttachment[] }
}

export function useAgentSession(callbacks: AgentSessionCallbacks = {}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<AgentQuestionRequest[]>([])
  const clearedRuns = useRef<Set<string>>(new Set())
  const focusedRunIdRef = useRef<string | null>(null)
  const focusLifecycleDeltasRef = useRef<{ runId: string; deltas: RunLifecycleDelta[] } | null>(null)
  const focusQuestionDeltasRef = useRef<{ runId: string; deltas: PendingQuestionDelta[] } | null>(null)
  const pendingStartLifecycleRef = useRef<RunLifecycleDelta[] | null>(null)
  const traceBuf = useRef<TraceEvent[]>([])
  const rafId = useRef<number | null>(null)
  const callbacksRef = useRef(callbacks)

  callbacksRef.current = callbacks

  const currentRunId = useMemo(() => currentVisibleRunId(turns), [turns])
  const busy = useMemo(() => restoring || running || turns.some((turn) => !turn.done && !turn.error), [restoring, running, turns])

  const flushTrace = useCallback((): void => {
    rafId.current = null
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
    setRunning(false)
  }, [])

  const replaceWithParsedSession = useCallback(
    (
      sessionId: string,
      parsed: ParsedTurn[],
      options: { activeRun?: ActiveRun | null } = {}
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
      setTurns((prev) => {
        const snapshot = sessionTurnsWithActiveRun(sessionId, parsed, activeRun)
        if (!activeRun) return snapshot
        const local = prev.find((turn) => turn.runId === activeRun.runId)
        const merged = local ? mergeActiveRun([local], activeRun)[0] : activeRun
        return replayRunLifecycleDeltas(
          snapshot.map((turn) => (turn.runId === activeRun.runId ? merged : turn)),
          lifecycleDeltas
        )
      })
      setSelected(null)
      setPendingQuestions(
        replayPendingQuestionDeltas(activeRun?.pendingQuestions ?? [], questionDeltas)
      )
      const terminal = lifecycleDeltas.some((delta) => delta.event.runId === activeRun?.runId)
      setRunning(Boolean(activeRun && !terminal))
      focusLifecycleDeltasRef.current = null
      focusQuestionDeltasRef.current = null
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
      const index = prev.findIndex((turn) => turn.runId === runId)
      if (index === -1) {
        return replayRunLifecycleDeltas(
          [...prev, { runId, userText: request.prompt, attachments: request.attachments, items: [], done: false }],
          lifecycleDeltas
        )
      }
      const next = [...prev]
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
      setRunning(false)
    }

    const offTrace = window.scry.onTrace((event) => {
      if (clearedRuns.current.has(event.runId)) return
      if (focusedRunIdRef.current == null) focusedRunIdRef.current = event.runId
      if (focusedRunIdRef.current !== event.runId) return
      traceBuf.current.push(event)
      if (rafId.current == null) rafId.current = requestAnimationFrame(flushTrace)
    })

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
          setRunning(false)
        }
        setPendingQuestions((prev) =>
          replayPendingQuestionDeltas(questionSnapshot ?? prev, currentQuestions)
        )
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
      offQuestion()
      offQuestionClosed()
      offDone()
      offError()
      if (rafId.current != null) cancelAnimationFrame(rafId.current)
    }
  }, [flushTrace])

  return {
    turns,
    selected,
    setSelected,
    pendingQuestions,
    currentRunId,
    running,
    restoring,
    busy,
    send,
    answerQuestion,
    stopRun,
    prepareRunFocus,
    clearTurns,
    replaceWithParsedSession
  }
}
