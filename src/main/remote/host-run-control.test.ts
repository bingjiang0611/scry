import 'reflect-metadata'
import { describe, expect, it, vi } from 'vitest'
import { handleRunControl } from './host-run-control'
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
    const request = { protocol: 2, op: 'runControl', method: 'adopt', runId: 'run-abc-1' }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), request)).toEqual({ error: 'unsupported_op' })
    const handlers = { ...empty, adopt: vi.fn(() => null) }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), request, undefined, handlers)).toEqual({ run: null })
  })

  it('rejects a frame carrying fields this op does not define', async () => {
    const controller = {} as unknown as HostController
    const handlers = { ...empty }
    expect(await dispatchRemoteRequest(controller, 'a'.repeat(64), { protocol: 2, op: 'runControl', method: 'adopt', runId: 'run-abc-1', cwd: '/etc' }, undefined, handlers))
      .toEqual({ error: 'invalid_request' })
    expect(handlers.adopt).not.toHaveBeenCalled()
  })
})
