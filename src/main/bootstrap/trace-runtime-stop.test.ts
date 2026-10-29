import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../../shared/trace'
import type { AgentQuestionRequest } from '../../shared/runtime'
import { createTraceRuntime } from './trace-runtime'
import type { RunControl } from './run-control'

function control(runId: string, calls: { interrupt: string[]; forceKill: string[] }): RunControl {
  return {
    runId,
    providerId: 'claude',
    runtimeProvider: 'claude_sdk',
    interrupt: () => calls.interrupt.push(runId),
    forceKill: () => calls.forceKill.push(runId),
    forceKillScope: () => 'run_scoped',
    getExternalSessionId: () => `native-${runId}`,
    getProviderTurnId: () => `${runId}-turn`,
    canonicalLifecycle: false,
    runState: {} as never,
    adoptSession: () => undefined,
    cleanupProvisional: () => undefined,
    finalizeTurnDiff: async () => undefined,
    cancelTurnDiff: async () => undefined,
    steer: async () => ({ status: 'unavailable' }) as never,
    stopBackgroundTask: async () => ({ status: 'unavailable', message: 'fixture' }) as never,
    settled: Promise.resolve()
  }
}

function runtime() {
  const calls = { interrupt: [] as string[], forceKill: [] as string[] }
  const trace = createTraceRuntime({
    getWindow: () => null,
    rendererCanReceive: () => false,
    activeRunSessionKey: (run: ActiveRun) => run.externalSessionId ?? run.runId,
    dockBadge: { markAttention: () => undefined, view: () => undefined, rekey: () => undefined,
      remove: () => undefined, snapshot: () => ({}) } as never,
    mainEventId: (prefix, runId) => `${prefix}-${runId}`
  })
  const register = (runId: string): void => {
    const state: ActiveRun = { runId, providerId: 'claude', cwd: '/repo', userText: runId, items: [],
      done: false, providerSettled: false }
    trace.runs.register(state, control(runId, calls))
  }
  return { trace, calls, register }
}

const question = (runId: string, questionId: string): AgentQuestionRequest => ({
  runId, questionId, providerId: 'claude',
  questions: [{ header: 'Fixture', question: `answer ${runId}?`, options: [], multiSelect: false }]
})

describe('run-scoped stop and approval routing', () => {
  it('interrupts only the requested run and never the sibling sharing the workspace', () => {
    const { trace, calls, register } = runtime()
    register('run-a')
    register('run-b')
    const pendingA = trace.userQuestionBroker.request(question('run-a', 'q-a'), new AbortController().signal)
    const pendingB = trace.userQuestionBroker.request(question('run-b', 'q-b'), new AbortController().signal)

    expect(trace.requestRunStop('run-a')).toBe(true)
    expect(calls.interrupt).toEqual(['run-a'])
    expect(calls.forceKill).toEqual([])
    expect(trace.runs.get('run-a')?.state.stopState?.phase).toBe('interrupt_requested')
    expect(trace.runs.get('run-b')?.state.stopState).toBeUndefined()
    expect(trace.runs.get('run-b')?.state.done).toBe(false)

    // 停止只取消自己的待处理问答：兄弟审批仍然可以被回答。
    expect(trace.userQuestionBroker.answer({ runId: 'run-a', questionId: 'q-a', behavior: 'cancelled' })).toBe(false)
    expect(trace.userQuestionBroker.answer({ runId: 'run-b', questionId: 'q-b', behavior: 'answered',
      answers: { 'answer run-b?': 'approve' } })).toBe(true)
    expect(trace.userQuestionBroker.answer({ runId: 'run-a', questionId: 'q-b', behavior: 'deny' })).toBe(false)
    return Promise.all([pendingA, pendingB])
  })

  it('refuses to stop an unknown or already finished run', () => {
    const { trace, calls, register } = runtime()
    register('run-a')
    expect(trace.requestRunStop('run-missing')).toBe(false)
    const state = trace.runs.get('run-a')!.state
    state.done = true
    expect(trace.requestRunStop('run-a')).toBe(false)
    expect(calls.interrupt).toEqual([])
  })

  it('settles one stop lifecycle without publishing the sibling as settled', () => {
    const { trace, register } = runtime()
    register('run-a')
    register('run-b')
    trace.requestRunStop('run-a')
    expect(trace.runStopLifecycle.settle('run-a')?.phase).toBe('settled')
    expect(trace.runStopLifecycle.snapshot('run-a')).toBeUndefined()
    expect(trace.runStopLifecycle.snapshot('run-b')).toBeUndefined()
    trace.runStopLifecycle.close()
  })
})
