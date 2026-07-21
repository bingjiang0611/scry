import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TraceEvent } from '@shared/trace'
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
  const traceBuf = useRef<TraceEvent[]>([])
  const rafId = useRef<number | null>(null)
  const callbacksRef = useRef(callbacks)

  callbacksRef.current = callbacks

  const busy = useMemo(() => restoring || running || turns.some((turn) => !turn.done && !turn.error), [restoring, running, turns])

  const flushTrace = useCallback((): void => {
    rafId.current = null
    const buf = traceBuf.current
    if (buf.length === 0) return
    traceBuf.current = []
    setTurns((prev) => applyTraceBatch(prev, buf, clearedRuns.current))
  }, [])

  const clearTurns = useCallback((): void => {
    setTurns((prev) => clearSessionTurns(prev, clearedRuns.current))
    setSelected(null)
    setPendingQuestions([])
    setRunning(false)
  }, [])

  const replaceWithParsedSession = useCallback((sessionId: string, parsed: ParsedTurn[]): void => {
    setTurns(parsedSessionTurns(sessionId, parsed))
    setSelected(null)
    setPendingQuestions([])
    setRunning(false)
  }, [])

  const send = useCallback(async (text: string, options: Omit<AgentStartRequest, 'prompt'> = {}): Promise<void> => {
    const request = buildAgentStartRequest(text, options)
    if (!request) return
    setRunning(true)
    let runId: string
    try {
      runId = (await window.scry.start(request)).runId
    } catch (error) {
      setRunning(false)
      throw error
    }
    setTurns((prev) => {
      const index = prev.findIndex((turn) => turn.runId === runId)
      if (index === -1) {
        return [...prev, { runId, userText: request.prompt, attachments: request.attachments, items: [], done: false }]
      }
      const next = [...prev]
      next[index] = { ...next[index], userText: request.prompt, attachments: request.attachments }
      return next
    })
  }, [])

  const stopRun = useCallback(async (): Promise<void> => {
    await window.scry.stop()
  }, [])

  const answerQuestion = useCallback(async (response: AgentQuestionResponse): Promise<void> => {
    if (typeof window.scry.answerQuestion !== 'function') throw new Error('当前 Scry preload 不支持回答 Claude 提问，请重启应用')
    const accepted = await window.scry.answerQuestion(response)
    if (!accepted) throw new Error('该提问已结束或回答无效')
    setPendingQuestions((prev) => removePendingQuestion(prev, response))
  }, [])

  useEffect(() => {
    let questionSnapshot: AgentQuestionRequest[] | null = null
    let hydratingQuestions = true
    const questionDeltas: PendingQuestionDelta[] = []
    const receiveQuestionDelta = (delta: PendingQuestionDelta): void => {
      if (hydratingQuestions) {
        questionDeltas.push(delta)
        return
      }
      setPendingQuestions((prev) => replayPendingQuestionDeltas(prev, [delta]))
    }

    const offTrace = window.scry.onTrace((event) => {
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
        questionSnapshot = !run || run.done ? [] : run.pendingQuestions ?? []
        if (!run || run.done) return
        setTurns((prev) => mergeActiveRun(prev, run))
        setRunning(true)
      })
      .finally(() => {
        hydratingQuestions = false
        setPendingQuestions((prev) => replayPendingQuestionDeltas(questionSnapshot ?? prev, questionDeltas))
        setRestoring(false)
      })

    const offDone = window.scry.onTurnDone((event) => {
      flushTrace()
      setTurns((prev) => markTurnDone(prev, event.runId))
      setPendingQuestions((prev) => removePendingQuestion(prev, event))
      setRunning(false)
      callbacksRef.current.onTurnDone?.(event)
    })

    const offError = window.scry.onError((event) => {
      flushTrace()
      setTurns((prev) => markTurnError(prev, event))
      setPendingQuestions((prev) => removePendingQuestion(prev, event))
      setRunning(false)
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
    running,
    restoring,
    busy,
    send,
    answerQuestion,
    stopRun,
    clearTurns,
    replaceWithParsedSession
  }
}
