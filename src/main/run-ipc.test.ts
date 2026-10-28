import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ActiveRun } from '../shared/trace'
import type { AgentStartRequest } from '../shared/runtime'
import { RunRegistry } from './run-registry'
import { registerRunIpc } from './run-ipc'

type Dependencies = Parameters<typeof registerRunIpc>[0]
type Control = NonNullable<ReturnType<Dependencies['runs']['get']>>['control'] & { runId: string }
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => unknown>()
  const runs = new RunRegistry<ActiveRun, Control>()
  const startAppRun = vi.fn(async (_request: AgentStartRequest) => ({ runId: 'created-run' }))
  const boundedLiveRun = vi.fn((run: ActiveRun) => ({ ...run, items: [] }))
  const dockBadge = { snapshot: vi.fn(() => ({ revision: 0, unreadSessionKeys: [] })), view: vi.fn() }
  const userQuestionBroker = { answer: vi.fn(() => true) }
  const answerRemoteQuestion = vi.fn(() => true)
  const traceOutput = { ack: vi.fn(() => true), resynchronized: vi.fn() }
  const requestRunStop = vi.fn(() => true)
  let window: ReturnType<Dependencies['window']> = { isFocused: () => true, webContents: { id: 7 } }
  registerRunIpc({
    handleTrusted: (channel, listener) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, listener) },
    runs, startAppRun, boundedLiveRun, activeRunSessionKey: run => run.externalSessionId ?? null,
    dockBadge, window: () => window, userQuestionBroker, answerRemoteQuestion,
    remoteRunLedgerId: runId => runId === 'remote-run' ? 'remote-ledger' : undefined,
    traceOutput, requestRunStop
  })
  // Registration/payload seam only, not proof of Electron sender/frame/origin validation.
  // Production wrappers are exercised by the isolated ownership App fixture.
  const invokeFrom = (sender: number, channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: { id: sender } } as IpcMainInvokeEvent, ...args as never[])
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom(7, channel, ...args)
  const register = (runId: string) => {
    const state: ActiveRun = { runId, done: false, providerSettled: false, userText: 'synthetic task',
      externalSessionId: `session-${runId}`, items: [] }
    const control: Control = { runId, adoptSession: vi.fn(),
      stopBackgroundTask: vi.fn(async () => ({ status: 'requested' as const, message: 'Synthetic stop acknowledgement' })),
      steer: vi.fn(async () => ({ status: 'accepted' as const })) }
    runs.register(state, control)
    return { state, control }
  }
  return { handlers, runs, invoke, invokeFrom, register, startAppRun, boundedLiveRun, dockBadge,
    userQuestionBroker, answerRemoteQuestion, traceOutput, requestRunStop,
    setWindow: (next: typeof window) => { window = next } }
}

describe('run IPC extraction', () => {
  it('registers the thirteen original handlers without starting or stopping work', () => {
    const f = fixture()
    expect([...f.handlers.keys()].sort()).toEqual(['start', 'activeRun', 'unreadSessions', 'focusedRunSnapshot',
      'activeRuns', 'focusRun', 'adoptActiveRun', 'answerQuestion', 'traceAck', 'traceResynchronized',
      'stopBackgroundTask', 'stop', 'steer'].map(name => `agent:${name}`).sort())
    expect(f.startAppRun).not.toHaveBeenCalled()
    expect(f.requestRunStop).not.toHaveBeenCalled()
    expect(f.userQuestionBroker.answer).not.toHaveBeenCalled()
  })

  it('keeps duplicate start receipts on the same registered execution', async () => {
    const f = fixture(), request = { commandId: 'stable-command', prompt: 'synthetic task' }
    const [first, duplicate] = await Promise.all([f.invoke('agent:start', request), f.invoke('agent:start', request)])
    expect(first).toMatchObject({ runId: 'created-run', commandStatus: 'executed', commandSequence: 1 })
    expect(duplicate).toMatchObject({ runId: 'created-run', commandStatus: 'duplicate', commandSequence: 1 })
    expect(f.startAppRun).toHaveBeenCalledExactlyOnceWith(request)
  })

  it('retains the completed-but-unsettled authoritative snapshot without reporting it active', () => {
    const f = fixture(), run = f.register('first-run')
    expect(f.invoke('agent:activeRun')).toMatchObject({ runId: run.state.runId })
    run.state.done = true
    expect(f.invoke('agent:activeRun')).toBeNull()
    expect(f.invoke('agent:activeRuns')).toEqual([])
    expect(f.invoke('agent:focusedRunSnapshot')).toMatchObject({ runId: run.state.runId, done: true, providerSettled: false })
    expect(f.runs.unsettledStates()).toEqual([run.state])
    expect(f.boundedLiveRun).toHaveBeenCalledTimes(2)
  })

  it('uses live focus and refuses missing or completed adoption targets', () => {
    const f = fixture(), first = f.register('first-run'), second = f.register('second-run')
    expect(f.invoke('agent:focusRun', 'first-run')).toBe(true)
    expect(f.dockBadge.view).toHaveBeenLastCalledWith('session-first-run', true)
    f.setWindow(null)
    expect(f.invoke('agent:adoptActiveRun', 'second-run')).toMatchObject({ runId: 'second-run' })
    expect(second.control.adoptSession).toHaveBeenCalledOnce()
    expect(f.dockBadge.view).toHaveBeenLastCalledWith('session-second-run', false)
    first.state.done = true
    expect(f.invoke('agent:adoptActiveRun', 'first-run')).toBeNull()
    expect(f.invoke('agent:adoptActiveRun', 'missing')).toBeNull()
    expect(first.control.adoptSession).not.toHaveBeenCalled()
  })

  it('routes questions only from the current window and preserves the remote broker identity', () => {
    const f = fixture(), local = { runId: 'local-run', questionId: 'one', behavior: 'cancelled' }
    expect(f.invokeFrom(99, 'agent:answerQuestion', local)).toBe(false)
    expect(f.userQuestionBroker.answer).not.toHaveBeenCalled()
    expect(f.answerRemoteQuestion).not.toHaveBeenCalled()
    expect(f.invoke('agent:answerQuestion', local)).toBe(true)
    expect(f.userQuestionBroker.answer).toHaveBeenCalledExactlyOnceWith(local)
    const remote = { ...local, runId: 'remote-run' }
    expect(f.invoke('agent:answerQuestion', remote)).toBe(true)
    expect(f.answerRemoteQuestion).toHaveBeenCalledExactlyOnceWith('remote-ledger', remote)
    f.setWindow({ isFocused: () => true, webContents: { id: 99 } })
    expect(f.invoke('agent:answerQuestion', local)).toBe(false)
    expect(f.userQuestionBroker.answer).toHaveBeenCalledOnce()
  })

  it('forwards trace receipts and stop acknowledgement without manufacturing settlement', () => {
    const f = fixture(), run = f.register('first-run'), receipt = { generation: 3, sequence: 5 }
    expect(f.invoke('agent:traceAck', receipt)).toBe(true)
    expect(f.traceOutput.ack).toHaveBeenCalledExactlyOnceWith(receipt)
    expect(f.invoke('agent:traceResynchronized')).toBe(true)
    expect(f.traceOutput.resynchronized).toHaveBeenCalledOnce()
    expect(f.invoke('agent:stop', 'first-run')).toBe(true)
    expect(f.requestRunStop).toHaveBeenCalledExactlyOnceWith('first-run')
    expect(run.state.done).toBe(false)
    expect(run.state.providerSettled).toBe(false)
    expect(f.runs.unsettledStates()).toEqual([run.state])
  })
})
