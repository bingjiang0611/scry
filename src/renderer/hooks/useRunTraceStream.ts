import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveRun } from '@shared/trace'
import { TRACE_LIVE_HEALTHY, TRACE_LIVE_UNAVAILABLE, type TraceLiveHealth } from './useAgentSession-helpers'
import { planRunTraceStream, type RunTraceStreamState } from '../run-trace-stream'
import {
  RunTraceStreamSession,
  type RunTraceStreamCommit,
  type RunTraceStreamPort
} from '../run-trace-stream-session'

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export interface RunTraceStream extends RunTraceStreamState {
  health: TraceLiveHealth
}

const port = (): RunTraceStreamPort | undefined => window.scry.runTraces

export function useRunTraceStream(
  runId: string | undefined,
  onTerminal: (run: ActiveRun | null) => void
): RunTraceStream {
  const [state, setState] = useState<RunTraceStreamState & { health: TraceLiveHealth }>({
    status: runId ? 'connecting' : 'idle',
    health: TRACE_LIVE_HEALTHY
  })
  const [commitVersion, setCommitVersion] = useState(0)
  const [visible, setVisible] = useState(() => (typeof document === 'undefined' ? true : !document.hidden))
  const sessionRef = useRef<RunTraceStreamSession>()
  const committed = useRef<RunTraceStreamCommit[]>([])
  const rafId = useRef<number | null>(null)
  const timeoutId = useRef<number | null>(null)
  const terminalRef = useRef(onTerminal)
  terminalRef.current = onTerminal

  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = (): void => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  const flushNow = useCallback((): void => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current)
    if (timeoutId.current != null) window.clearTimeout(timeoutId.current)
    rafId.current = null
    timeoutId.current = null
    const commits = sessionRef.current?.drain() ?? []
    if (commits.length === 0) return
    committed.current.push(...commits)
    setCommitVersion((value) => value + 1)
  }, [])

  const scheduleFlush = useCallback((): void => {
    if (rafId.current == null) rafId.current = requestAnimationFrame(flushNow)
    if (timeoutId.current == null) timeoutId.current = window.setTimeout(flushNow, 250)
  }, [flushNow])

  useCommitEffect(() => {
    const commits = committed.current
    if (commits.length === 0) return
    committed.current = []
    const bridge = port()
    if (!bridge) return
    for (const commit of commits) {
      if (commit.kind === 'batch') {
        void bridge.ack(commit.subscriptionId, commit.receipt).catch(() => {
        })
        continue
      }
      void bridge.confirmResync(commit.subscriptionId, commit.resyncId).catch(() => {
      })
    }
  }, [commitVersion])

  useEffect(() => {
    const bridge = port()
    const plan = planRunTraceStream(runId, visible, Boolean(bridge))
    if (plan.kind !== 'connect' || !bridge) {
      setState(plan.kind === 'unavailable'
        ? { status: 'unavailable', health: TRACE_LIVE_UNAVAILABLE }
        : { status: 'idle', health: TRACE_LIVE_HEALTHY })
      return
    }
    const session = new RunTraceStreamSession({
      runId: plan.runId,
      port: bridge,
      publish: (next) => setState(next),
      requestFlush: scheduleFlush,
      flushNow,
      onTerminal: (value) => terminalRef.current(value)
    })
    sessionRef.current = session
    setState({ status: 'connecting', health: TRACE_LIVE_HEALTHY })
    session.start()
    return () => {
      session.stop()
      if (sessionRef.current === session) sessionRef.current = undefined
      if (rafId.current != null) cancelAnimationFrame(rafId.current)
      if (timeoutId.current != null) window.clearTimeout(timeoutId.current)
      rafId.current = null
      timeoutId.current = null
    }
  }, [flushNow, runId, visible, scheduleFlush])

  return { run: state.run, status: state.status, health: state.health }
}
