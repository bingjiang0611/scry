import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { AgentQuestionRequest, AgentStartRequest, AgentStartResult } from '@shared/runtime'
import type { Turn } from '../format'
import { startWithWorkspaceReceipt } from '../workspace-drafts'
import { workspaceCopy } from '../constants/workspace-copy'
import {
  applyStopState, beginOptimisticTurn, buildAgentStartRequest, confirmOptimisticTurn, discardOptimisticTurn,
  mergeRecoveredRun, rendererTraceResyncBridge, resynchronizeLiveTrace, restoredRunRuntimeState,
  type OlderSessionPage, type RunLifecycleDelta, type PendingQuestionDelta, type StopStateMap
} from './useAgentSession-helpers'

type Ref<T> = MutableRefObject<T>
type Setter<T> = Dispatch<SetStateAction<T>>

export function useAgentStart(deps: {
  cachedDisplayRef: Ref<boolean>
  cachedHistoryRef: Ref<{ sessionId: string; page: OlderSessionPage | null | undefined } | null>
  resyncGeneration: Ref<number>
  focusedRunIdRef: Ref<string | null>
  pendingStartLifecycleRef: Ref<RunLifecycleDelta[] | null>
  pendingStartSequenceRef: Ref<number>
  focusLifecycleDeltasRef: Ref<{ runId: string; deltas: RunLifecycleDelta[] } | null>
  focusQuestionDeltasRef: Ref<{ runId: string; deltas: PendingQuestionDelta[] } | null>
  clearedRuns: Ref<Set<string>>
  prepareRunFocus: (runId: string) => void
  setRunning: Setter<boolean>
  setTurns: Setter<Turn[]>
  setPendingQuestions: Setter<AgentQuestionRequest[]>
  setStopStates: Setter<StopStateMap>
}) {
  const {
    cachedDisplayRef, cachedHistoryRef, resyncGeneration, focusedRunIdRef, pendingStartLifecycleRef,
    pendingStartSequenceRef, focusLifecycleDeltasRef, focusQuestionDeltasRef, clearedRuns,
    prepareRunFocus, setRunning, setTurns, setPendingQuestions, setStopStates
  } = deps
  const send = useCallback(async (
    text: string, options: Omit<AgentStartRequest, 'prompt'> = {}
  ): Promise<AgentStartResult | null> => {
    const request = buildAgentStartRequest(text, options)
    if (!request) return null
    cachedDisplayRef.current = false
    cachedHistoryRef.current = null
    const generation = ++resyncGeneration.current
    focusedRunIdRef.current = null
    const pendingLifecycle: RunLifecycleDelta[] = []
    pendingStartLifecycleRef.current = pendingLifecycle
    setRunning(true)
    const pendingRunId = `pending-run-${Date.now().toString(36)}-${pendingStartSequenceRef.current++}`
    setTurns(previous => beginOptimisticTurn(previous, pendingRunId, request))
    let result: AgentStartResult
    try {
      result = await startWithWorkspaceReceipt(request)
    } catch (error) {
      if (pendingStartLifecycleRef.current === pendingLifecycle) pendingStartLifecycleRef.current = null
      setTurns(previous => discardOptimisticTurn(previous, pendingRunId))
      if (generation === resyncGeneration.current) setRunning(false)
      throw error
    }
    if (pendingStartLifecycleRef.current === pendingLifecycle) pendingStartLifecycleRef.current = null
    // A long preparation may finish after another draft/history selection. Do not steal its focus.
    if (generation !== resyncGeneration.current && focusedRunIdRef.current !== result.runId) {
      setTurns(previous => discardOptimisticTurn(previous, pendingRunId))
      return result
    }
    focusedRunIdRef.current = result.runId
    const deltas = pendingLifecycle.filter(delta => delta.event.runId === result.runId)
    const actualRequest = result.workspace ? { ...request, cwd: result.workspace.cwd } : request
    setTurns(previous => confirmOptimisticTurn(previous, pendingRunId, result.runId, actualRequest, deltas))
    if (deltas.length) setRunning(false)
    return result
  }, [cachedDisplayRef, cachedHistoryRef, resyncGeneration, focusedRunIdRef, pendingStartLifecycleRef,
    pendingStartSequenceRef, setRunning, setTurns])

  const adoptStartedRun = useCallback(async (runId: string): Promise<
    { status: 'focused'; run: ActiveRun } | { status: 'unavailable' } | { status: 'superseded' }
  > => {
    prepareRunFocus(runId)
    const generation = resyncGeneration.current
    const stale = (candidate = runId) => generation !== resyncGeneration.current || candidate !== runId ||
      focusedRunIdRef.current !== runId || clearedRuns.current.has(runId)
    const focused = await window.scry.focusRun(runId)
    if (stale()) return { status: 'superseded' }
    if (!focused) return { status: 'unavailable' }
    let snapshot: ActiveRun | null = null
    const outcome = await resynchronizeLiveTrace(rendererTraceResyncBridge(), run => {
      snapshot = run
      setTurns(previous => mergeRecoveredRun(previous, run))
      const lifecycle = focusLifecycleDeltasRef.current?.runId === runId ? focusLifecycleDeltasRef.current.deltas : []
      const questions = focusQuestionDeltasRef.current?.runId === runId ? focusQuestionDeltasRef.current.deltas : []
      const state = restoredRunRuntimeState(run.done ? null : runId, run.pendingQuestions ?? [], questions, lifecycle)
      setRunning(state.running)
      setPendingQuestions(state.pendingQuestions)
      if (run.stopState) setStopStates(previous => applyStopState(previous, run.stopState!))
    }, stale)
    if (stale()) return { status: 'superseded' }
    if (!outcome.aligned) throw new Error(workspaceCopy.boundFailed)
    return snapshot ? { status: 'focused', run: snapshot } : { status: 'unavailable' }
  }, [prepareRunFocus, resyncGeneration, focusedRunIdRef, clearedRuns, focusLifecycleDeltasRef,
    focusQuestionDeltasRef, setTurns, setRunning, setPendingQuestions, setStopStates])

  return { send, adoptStartedRun }
}
