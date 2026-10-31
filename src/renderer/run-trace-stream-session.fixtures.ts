import type { ActiveRun, TraceEvent } from '@shared/trace'
import type {
  RunTraceEvent,
  RunTraceResyncResult,
  RunTraceStreamHealth,
  RunTraceSubscribeRequest,
  RunTraceSubscribeResult
} from '@shared/run-traces'
import { RunTraceStreamSession, type RunTraceStreamCommit, type RunTraceStreamPort } from './run-trace-stream-session'
import { type TraceLiveHealth } from './hooks/useAgentSession-helpers'
import type { RunTraceStreamState } from './run-trace-stream'

export const event = (runId: string, id: string, text = id, extra: Partial<TraceEvent> = {}): TraceEvent => ({
  id, ts: '2026-01-01T00:00:00.000Z', runId, kind: 'model', stage: 'text', text, ...extra
})

/** 与 main 里 appendCoalescedTrace 一致的增量：同一条流上的 text_delta 会被拼到最后一格。 */
export const delta = (runId: string, id: string, text: string): TraceEvent => ({
  id,
  ts: '2026-01-01T00:00:00.000Z',
  runId,
  kind: 'model',
  stage: 'text_delta',
  messageId: 'm-1',
  text
})

export const run = (runId: string, items: TraceEvent[] = [], extra: Partial<ActiveRun> = {}): ActiveRun => ({
  runId, userText: runId, items, done: false, providerSettled: false, ...extra
})

export const healthy: RunTraceStreamHealth = {
  generation: 0, degraded: false, skippedEvents: 0, bufferedEvents: 0, bufferedBytes: 0, inFlightBytes: 0, resyncRequired: false
}

export interface Fixture {
  port: RunTraceStreamPort
  states: Array<RunTraceStreamState & { health: TraceLiveHealth }>
  acks: Array<{ subscriptionId: string; batchId: number }>
  confirmed: Array<{ subscriptionId: string; resyncId: number }>
  unsubscribeCalls: string[]
  emit: (event: RunTraceEvent) => void
  subscribeResult: { value: Promise<RunTraceSubscribeResult> }
  resyncResult: { value: Promise<RunTraceResyncResult> }
  flushes: { count: number }
  resyncRequests: { count: number }
}

export interface SessionFixture extends Fixture {
  session: RunTraceStreamSession
  /** 模拟 React 提交：flush → 提交 → 归还额度/对齐确认。 */
  flushAndCommit: () => RunTraceStreamCommit[]
  terminal: Array<ActiveRun | null>
}

export function sessionFixture(runId = 'run-main', subscriptionId = 'sub-main-1'): SessionFixture {
  let listener: ((event: RunTraceEvent) => void) | undefined
  const states: Array<RunTraceStreamState & { health: TraceLiveHealth }> = []
  const acks: Array<{ subscriptionId: string; batchId: number }> = []
  const confirmed: Array<{ subscriptionId: string; resyncId: number }> = []
  const unsubscribeCalls: string[] = []
  const subscribeResult: { value: Promise<RunTraceSubscribeResult> } = {
    value: Promise.resolve({
      status: 'subscribed',
      subscriptionId,
      run: run(runId, [event(runId, 'snapshot-1')]),
      health: healthy
    })
  }
  const resyncResult: { value: Promise<RunTraceResyncResult> } = {
    value: Promise.resolve({
      status: 'ok',
      run: run(runId, [event(runId, 'snapshot-2')]),
      resyncId: 1,
      health: { ...healthy, generation: 1 }
    })
  }
  const flushes = { count: 0 }
  const resyncRequests = { count: 0 }
  const terminal: Array<ActiveRun | null> = []
  const port: RunTraceStreamPort = {
    subscribe: async (_request: RunTraceSubscribeRequest) => subscribeResult.value,
    unsubscribe: async (id) => { unsubscribeCalls.push(id); return true },
    ack: async (id, receipt) => { acks.push({ subscriptionId: id, batchId: receipt.batchId }); return true },
    resync: async () => { resyncRequests.count += 1; return resyncResult.value },
    confirmResync: async (id, resyncId) => { confirmed.push({ subscriptionId: id, resyncId }); return true },
    onEvent: (cb) => { listener = cb; return () => { listener = undefined } }
  }
  let pending: RunTraceStreamCommit[] = []
  const session = new RunTraceStreamSession({
    runId,
    subscriptionId,
    port,
    publish: (next) => states.push(next),
    requestFlush: () => { flushes.count += 1 },
    flushNow: () => { pending = session.drain() },
    onTerminal: (value) => { terminal.push(value) }
  })
  return {
    port, states, acks, confirmed, unsubscribeCalls, subscribeResult, resyncResult, flushes, resyncRequests, session, terminal,
    emit: (value) => listener?.(value),
    flushAndCommit: () => {
      const commits = [...pending, ...session.drain()]
      pending = []
      for (const commit of commits) {
        if (commit.kind === 'batch') void port.ack(commit.subscriptionId, commit.receipt)
        else void port.confirmResync(commit.subscriptionId, commit.resyncId)
      }
      return commits
    }
  }
}

export const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

/** 让 subscribe 停在半路：事件先到、回执后到是真实 IPC 顺序，不是假想。 */
export function deferSubscribe(h: SessionFixture, value: RunTraceSubscribeResult): () => void {
  let release = (): void => undefined
  h.subscribeResult.value = new Promise<RunTraceSubscribeResult>((resolve) => {
    release = () => resolve(value)
  })
  return release
}
