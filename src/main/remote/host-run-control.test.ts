import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { adoptRegisteredRun, handleRunControl } from './host-run-control'
import type { ActiveRun } from '../../shared/trace'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'
import type { HostController } from './host-controller'

// App-only run controls over the daemon's registry. Two things matter here: the op is
// absent on the network endpoint (not answered from another process's memory), and an
// unrecognized method is refused instead of guessed.

const empty = { steer: vi.fn(async () => ({ status: 'rejected' as const, message: 'no run' })), stopBackgroundTask: vi.fn(async () => ({ status: 'rejected' as const, message: 'no task' })), adopt: vi.fn(() => null) }

describe('daemon run control op', () => {
  it('refuses an unknown method instead of picking one', async () => {
    const handlers = { ...empty, steer: vi.fn(), stopBackgroundTask: vi.fn(), adopt: vi.fn() }
    expect(await handleRunControl(handlers, { method: 'shutdown' })).toEqual({ error: 'invalid_request' })
    expect(handlers.steer).not.toHaveBeenCalled()
    expect(handlers.adopt).not.toHaveBeenCalled()
  })

  it('delegates steer and stopBackgroundTask to their handlers', async () => {
    const handlers = {
      steer: vi.fn(async () => ({ status: 'accepted' as const, messageId: 'm-1' })),
      stopBackgroundTask: vi.fn(async () => ({ status: 'requested' as const, message: '' })),
      adopt: vi.fn(() => null)
    }
    expect(await handleRunControl(handlers, { method: 'steer', payload: { runId: 'run-1' } })).toEqual({ steer: { status: 'accepted', messageId: 'm-1' } })
    expect(handlers.steer).toHaveBeenCalledWith({ runId: 'run-1' })
    expect(await handleRunControl(handlers, { method: 'stopBackgroundTask', payload: { runId: 'run-1', taskId: 't-1' } }))
      .toEqual({ backgroundTask: { status: 'requested', message: '' } })
  })

  it('requires a usable runId to adopt, and answers absence as null', async () => {
    const handlers = { ...empty, adopt: vi.fn(() => null) }
    expect(await handleRunControl(handlers, { method: 'adopt' })).toEqual({ steer: { status: 'rejected', message: 'runId 无效' } })
    expect(handlers.adopt).not.toHaveBeenCalled()
    expect(await handleRunControl(handlers, { method: 'adopt', runId: 'run-abc-1' })).toEqual({ run: null })
  })

  it('is unknown on an endpoint without the handlers, and answers when they are there', async () => {
    // The network endpoint builds its host without runControl; the local one with it.
    // A missing handler must not fall through to some other answer.
    const controller = { stopRun: vi.fn(), runState: vi.fn() } as unknown as HostController
    const request = { protocol: 3, op: 'runControl', method: 'adopt', runId: 'run-abc-1' }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), request)).toEqual({ error: 'unsupported_op' })
    const handlers = { ...empty, adopt: vi.fn(() => null) }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), request, undefined, { runControl: handlers })).toEqual({ run: null })
  })

  it('rejects a frame carrying fields this op does not define', async () => {
    const controller = {} as unknown as HostController
    const handlers = { ...empty }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 3, op: 'runControl', method: 'adopt', runId: 'run-abc-1', cwd: '/etc' }, undefined, { runControl: handlers }))
      .toEqual({ error: 'invalid_request' })
    expect(handlers.adopt).not.toHaveBeenCalled()
  })

  it('passes a registry refusal through instead of answering the run', async () => {
    const handlers = { ...empty, adopt: vi.fn(() => ({ refused: '统一对话不能由旧会话入口接管，请打开其稳定对话条目' })) }
    expect(await handleRunControl(handlers, { method: 'adopt', runId: 'run-abc-1' }))
      .toEqual({ run: null, refused: '统一对话不能由旧会话入口接管，请打开其稳定对话条目' })
  })
})

describe('adopting a registered run', () => {
  const state = (done = false) => ({ runId: 'run-abc-1', done } as unknown as ActiveRun)

  it('lets the run control refuse, so a unified conversation run is never taken over', () => {
    const control = { adoptSession: vi.fn(() => { throw new Error('统一对话不能由旧会话入口接管，请打开其稳定对话条目') }) }
    expect(adoptRegisteredRun({ state: state(), control })).toEqual({ refused: '统一对话不能由旧会话入口接管，请打开其稳定对话条目' })
    expect(control.adoptSession).toHaveBeenCalledTimes(1)
  })

  it('adopts the session of a live run and answers its state', () => {
    const control = { adoptSession: vi.fn() }
    const live = state()
    expect(adoptRegisteredRun({ state: live, control })).toBe(live)
    expect(control.adoptSession).toHaveBeenCalledTimes(1)
  })

  it('answers a finished run without re-binding its session, and absence as null', () => {
    const control = { adoptSession: vi.fn() }
    const finished = state(true)
    expect(adoptRegisteredRun({ state: finished, control })).toBe(finished)
    expect(control.adoptSession).not.toHaveBeenCalled()
    expect(adoptRegisteredRun(undefined)).toBeNull()
  })
})
