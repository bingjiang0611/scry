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

/**
 * 单个 run 的 live 流。一个订阅只属于一个视图：事件按帧合并，额度与重对齐确认只在这个
 * 视图的 React 提交之后归还一次；终态、降级与隐藏页签都不会把数据卖给别的视图。
 *
 * 不订阅/不确认都不影响 run 的生命周期——这里只是「谁在看」。页签隐藏时退订，
 * 重新可见时重新订阅并读一份有界权威快照，不自动补发、不后台轮询。
 */
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
    // 单独的提交标记保证「事件全被合并成同一批」时也有一次提交屏障，回执不会永远发不出去。
    setCommitVersion((value) => value + 1)
  }, [])

  const scheduleFlush = useCallback((): void => {
    if (rafId.current == null) rafId.current = requestAnimationFrame(flushNow)
    if (timeoutId.current == null) timeoutId.current = window.setTimeout(flushNow, 250)
  }, [flushNow])

  // 额度与重对齐确认只在这里归还：React 已经提交了这一批 state，和 legacy 通道同一套纪律。
  useCommitEffect(() => {
    const commits = committed.current
    if (commits.length === 0) return
    committed.current = []
    const bridge = port()
    // 没有该桥时不会有订阅，也就不会有待确认项；这里不假装确认成功。
    if (!bridge) return
    for (const commit of commits) {
      if (commit.kind === 'batch') {
        void bridge.ack(commit.subscriptionId, commit.receipt).catch(() => {
          // main 已关闭该订阅或窗口正在重挂：台账随桥关闭，权威证据不受影响。
        })
        continue
      }
      void bridge.confirmResync(commit.subscriptionId, commit.resyncId).catch(() => {
        // 确认没送到不影响正确性：main 仍保持 resyncRequired，下一次健康事件会再对齐一次。
      })
    }
  }, [commitVersion])

  useEffect(() => {
    const bridge = port()
    const plan = planRunTraceStream(runId, visible, Boolean(bridge))
    if (plan.kind !== 'connect' || !bridge) {
      // 没有可见 run = 真的空闲；有 run 却没有 scoped 流 = 明确不可用 + 降级。
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
