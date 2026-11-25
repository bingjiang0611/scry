import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest, AgentQuestionResponse } from '@shared/runtime'
import { useAgentStart } from './useAgentStart'
import { useRunStopRequest } from './useRunStopRequest'
import { applyTraceBatch } from '../format'
import type { ParsedTurn, TraceBatchReceipt } from '../env'
import type { Turn } from '../format'
import { readTerminalEvidence, restoreSessionTurns } from './useAgentSession-history'
import {
  acknowledgeTraceResync,
  appendMissingTraceItems,
  applyStopState,
  clearSessionTurns,
  clearStopState,
  currentVisibleRunId,
  needsTerminalEvidence,
  mergeActiveRun,
  mergeRecoveredRun,
  prependOlderSessionTurns,
  removePendingQuestion,
  replayPendingQuestionDeltas,
  replayRunLifecycleDeltas,
  rendererTraceResyncBridge,
  resynchronizeLiveTrace,
  restoredRunRuntimeState,
  sessionBusy,
  sessionHistoryWindowOf,
  terminalEvidenceOf,
  traceLiveHealthOf,
  TRACE_LIVE_HEALTHY,
  type AgentSessionCallbacks,
  type OlderSessionPage,
  type RunLifecycleDelta,
  type PendingQuestionDelta,
  type SessionHistoryWindow,
  type StopStateMap,
  type TraceLiveHealth
} from './useAgentSession-helpers'

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export function useAgentSession(callbacks: AgentSessionCallbacks = {}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [running, setRunning] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [selected, setSelected] = useState<TraceEvent | null>(null)
  const [pendingQuestions, setPendingQuestions] = useState<AgentQuestionRequest[]>([])
  const [stopStates, setStopStates] = useState<StopStateMap>({})
  const [traceHealth, setTraceHealth] = useState<TraceLiveHealth>(TRACE_LIVE_HEALTHY)
  const [historyWindow, setHistoryWindow] = useState<SessionHistoryWindow | null>(null)
  const [traceCommitVersion, setTraceCommitVersion] = useState(0)
  const historyWindowRef = useRef<SessionHistoryWindow | null>(null)
  const clearedRuns = useRef<Set<string>>(new Set())
  const focusedRunIdRef = useRef<string | null>(null)
  const cachedDisplayRef = useRef(false)
  const cachedHistoryRef = useRef<{ sessionId: string; page: OlderSessionPage | null | undefined } | null>(null)
  const resyncGeneration = useRef(0)
  const focusLifecycleDeltasRef = useRef<{ runId: string; deltas: RunLifecycleDelta[] } | null>(null)
  const focusTraceDeltasRef = useRef<{ runId: string; events: TraceEvent[] } | null>(null)
  const focusQuestionDeltasRef = useRef<{ runId: string; deltas: PendingQuestionDelta[] } | null>(null)
  const pendingStartLifecycleRef = useRef<RunLifecycleDelta[] | null>(null)
  const traceBuf = useRef<TraceEvent[]>([])
  const pendingTraceReceipts = useRef<TraceBatchReceipt[]>([])
  const committedTraceReceipts = useRef<TraceBatchReceipt[]>([])
  const rafId = useRef<number | null>(null)
  const flushTimeoutId = useRef<number | null>(null)
  const callbacksRef = useRef(callbacks)
  const pendingStartSequenceRef = useRef(0)
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns

  const backfillTerminalEvidence = useCallback((runId: string): void => {
    const turn = turnsRef.current.find((candidate) => candidate.runId === runId)
    if (!turn || !needsTerminalEvidence(turn)) return
    void readTerminalEvidence(turn).then((evidence) => {
      const terminal = terminalEvidenceOf(evidence)
      if (terminal.length > 0) setTurns((prev) => appendMissingTraceItems(prev, runId, terminal))
    }).catch(() => undefined)
  }, [])

  callbacksRef.current = callbacks

  const currentRunId = useMemo(() => currentVisibleRunId(turns), [turns])
  const { stopRequest, stopRun } = useRunStopRequest(currentRunId)
  const busy = useMemo(() => sessionBusy(turns, { restoring, running }), [restoring, running, turns])

  const flushTrace = useCallback((): void => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current)
    if (flushTimeoutId.current != null) window.clearTimeout(flushTimeoutId.current)
    rafId.current = null
    flushTimeoutId.current = null
    const buf = traceBuf.current
    const receipts = pendingTraceReceipts.current
    if (buf.length === 0 && receipts.length === 0) return
    traceBuf.current = []
    pendingTraceReceipts.current = []
    if (buf.length > 0) setTurns((prev) => applyTraceBatch(prev, buf, clearedRuns.current))
    committedTraceReceipts.current.push(...receipts)
    setTraceCommitVersion((value) => value + 1)
  }, [])

  useCommitEffect(() => {
    const receipts = committedTraceReceipts.current
    if (receipts.length === 0) return
    committedTraceReceipts.current = []
    for (const receipt of receipts) {
      void window.scry.traceAck?.(receipt).catch(() => {
      })
    }
  }, [traceCommitVersion])

  const prepareRunFocus = useCallback((runId: string, captureTrace = false) => {
    cachedDisplayRef.current = false
    cachedHistoryRef.current = null
    resyncGeneration.current++
    focusedRunIdRef.current = runId
    clearedRuns.current.delete(runId)
    focusLifecycleDeltasRef.current = { runId, deltas: [] }
    const capture = captureTrace ? { runId, events: [] as TraceEvent[] } : null
    focusTraceDeltasRef.current = capture
    focusQuestionDeltasRef.current = { runId, deltas: [] }
    return () => {
      if (focusTraceDeltasRef.current === capture) focusTraceDeltasRef.current = null
    }
  }, [])

  const clearTurns = useCallback((_options: { preserveRunning?: boolean } = {}): void => {
    flushTrace()
    cachedDisplayRef.current = false
    cachedHistoryRef.current = null
    resyncGeneration.current++
    setTurns((prev) => clearSessionTurns(prev, clearedRuns.current))
    focusedRunIdRef.current = null
    focusLifecycleDeltasRef.current = null
    focusTraceDeltasRef.current = null
    focusQuestionDeltasRef.current = null
    setSelected(null)
    setPendingQuestions([])
    setStopStates({})
    historyWindowRef.current = null
    setHistoryWindow(null)
    setRunning(false)
  }, [flushTrace])

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
        page?: OlderSessionPage | null
        source?: 'cache' | 'authoritative'
      } = {}
    ): void => {
      const cached = options.source === 'cache'
      if (cached || options.page?.projection) flushTrace()
      cachedDisplayRef.current = cached
      cachedHistoryRef.current = cached ? { sessionId, page: options.page } : null
      const run = cached ? null : options.page?.projection ? options.page.projection.activeRun : options.activeRun
      const activeRun = run && !run.done ? run : null
      resyncGeneration.current++
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
      const focus = focusTraceDeltasRef.current
      const traceDeltas = focus && focus.runId === activeRun?.runId ? focus.events : []
      setTurns((prev) => {
        if (cached) clearSessionTurns(prev, clearedRuns.current)
        return restoreSessionTurns(prev, sessionId, parsed, activeRun, options.page, traceDeltas, lifecycleDeltas, clearedRuns.current)
      })
      setSelected(null)
      setPendingQuestions(runtimeState.pendingQuestions)
      setStopStates(activeRun?.stopState && runtimeState.running ? { [activeRun.runId]: activeRun.stopState } : {})
      if (!cached && (options.page != null || parsed.length > 0)) {
        setTraceHealth(TRACE_LIVE_HEALTHY)
        acknowledgeTraceResync()
      }
      setRunning(runtimeState.running)
      if (!options.preserveFocusDeltas) {
        focusLifecycleDeltasRef.current = null
        focusTraceDeltasRef.current = null
        focusQuestionDeltasRef.current = null
      }
    },
    [flushTrace]
  )

  const confirmCachedSession = useCallback((sessionId: string, page: OlderSessionPage): boolean => {
    const cached = cachedHistoryRef.current
    if (!cachedDisplayRef.current || cached?.sessionId !== sessionId || cached.page !== page) return false
    cachedDisplayRef.current = false
    cachedHistoryRef.current = null
    resyncGeneration.current++
    setTraceHealth(TRACE_LIVE_HEALTHY)
    acknowledgeTraceResync()
    return true
  }, [])

  const { send, adoptStartedRun } = useAgentStart({
    cachedDisplayRef, cachedHistoryRef, resyncGeneration, focusedRunIdRef,
    pendingStartLifecycleRef, pendingStartSequenceRef, focusLifecycleDeltasRef, focusQuestionDeltasRef,
    clearedRuns, prepareRunFocus, setRunning, setTurns, setPendingQuestions, setStopStates
  })

  const answerQuestion = useCallback(async (response: AgentQuestionResponse): Promise<void> => {
    if (typeof window.scry.answerQuestion !== 'function') throw new Error('当前 Scry preload 不支持回答 Claude 提问，请重启应用')
    const accepted = await window.scry.answerQuestion(response)
    if (!accepted) throw new Error('该提问已结束或回答无效')
    setPendingQuestions((prev) => removePendingQuestion(prev, response))
  }, [])

  useEffect(() => {
    const initialFocusGeneration = resyncGeneration.current
    let questionSnapshot: AgentQuestionRequest[] | null = null
    let hydratingQuestions = true
    let hydratedRun: ActiveRun | null = null
    let hydratingLifecycle = true
    const questionDeltas: PendingQuestionDelta[] = []
    const lifecycleDeltas: RunLifecycleDelta[] = []
    const receiveQuestionDelta = (delta: PendingQuestionDelta): void => {
      if (cachedDisplayRef.current) return
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
      if (cachedDisplayRef.current) return
      const runId = delta.event.runId
      if (hydratingLifecycle) lifecycleDeltas.push(delta)
      if (pendingStartLifecycleRef.current) pendingStartLifecycleRef.current.push(delta)
      if (focusLifecycleDeltasRef.current?.runId === runId) {
        focusLifecycleDeltasRef.current.deltas.push(delta)
      }
      if (clearedRuns.current.has(runId)) return
      if (focusedRunIdRef.current == null) focusedRunIdRef.current = runId
      const focused = focusedRunIdRef.current === runId
      if (!focused && !turnsRef.current.some((turn) => turn.runId === runId)) return
      setTurns((prev) => replayRunLifecycleDeltas(prev, [delta]))
      setPendingQuestions((prev) => removePendingQuestion(prev, delta.event))
      setStopStates((prev) => clearStopState(prev, runId))
      if (focused) setRunning(false)
      backfillTerminalEvidence(runId)
    }

    const offTrace = window.scry.onTrace((events, receipt) => {
      let accepted = 0
      for (const event of events) {
        if (cachedDisplayRef.current || clearedRuns.current.has(event.runId)) continue
        if (focusedRunIdRef.current == null) focusedRunIdRef.current = event.runId
        if (focusedRunIdRef.current !== event.runId) continue
        if (focusTraceDeltasRef.current?.runId === event.runId) focusTraceDeltasRef.current.events.push(event)
        traceBuf.current.push(event)
        accepted += 1
      }
      if (receipt) pendingTraceReceipts.current.push(receipt)
      if (accepted === 0) {
        const ignoredReceipt = pendingTraceReceipts.current.pop()
        if (ignoredReceipt) void window.scry.traceAck?.(ignoredReceipt).catch(() => {})
        return
      }
      if (rafId.current == null) rafId.current = requestAnimationFrame(flushTrace)
      if (flushTimeoutId.current == null) flushTimeoutId.current = window.setTimeout(flushTrace, 250)
    })

    const offStopState =
      typeof window.scry.onStopState === 'function'
        ? window.scry.onStopState((state) => {
            if (cachedDisplayRef.current || clearedRuns.current.has(state.runId)) return
            setStopStates((prev) => applyStopState(prev, state))
          })
        : () => {}

    const offTraceHealth =
      typeof window.scry.onTraceHealth === 'function'
        ? window.scry.onTraceHealth((state) => {
            setTraceHealth(traceLiveHealthOf(state))
            if (!state.resyncRequired || cachedDisplayRef.current) return
            const generation = ++resyncGeneration.current
            void resynchronizeLiveTrace(
              rendererTraceResyncBridge(),
              (run) => setTurns((prev) => mergeRecoveredRun(prev, run)),
              (runId) => generation !== resyncGeneration.current || clearedRuns.current.has(runId) ||
                (focusedRunIdRef.current !== null && focusedRunIdRef.current !== runId)
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
        if (initialFocusGeneration !== resyncGeneration.current) return
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
        setRestoring(false)
        if (initialFocusGeneration !== resyncGeneration.current) return
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
      resyncGeneration.current++
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
    stopRequest,
    traceHealth,
    currentRunId,
    running,
    restoring,
    busy,
    send,
    adoptStartedRun,
    answerQuestion,
    stopRun,
    prepareRunFocus,
    clearTurns,
    replaceWithParsedSession,
    confirmCachedSession,
    historyWindow,
    prependOlderTurns
  }
}

export * from './useAgentSession-api'
