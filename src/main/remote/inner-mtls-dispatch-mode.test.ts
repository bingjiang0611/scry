import { describe, expect, it, vi } from 'vitest'
import type { HostController } from './host-controller'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'

const peer = 'd'.repeat(64)

function controllerWith(submitReceivedIntent: ReturnType<typeof vi.fn>) {
  return { submitReceivedIntent } as unknown as HostController
}

// D2: a device states how its message should reach the session. `queue` becomes the durable
// queue (D1); an unknown or host-local mode is refused instead of silently dispatched.

describe('device submit dispatch mode', () => {
  it('passes queue as the queued claim mode', async () => {
    const submit = vi.fn(async () => ({ runId: 'run-1', status: 'recorded', seq: 1 }))
    await expect(dispatchRemoteRequest(controllerWith(submit), peer, {
      protocol: 3, op: 'submit', intentId: 'intent-1', detail: '{}', mode: 'queue'
    })).resolves.toMatchObject({ runId: 'run-1' })
    expect(submit).toHaveBeenCalledWith(peer, expect.objectContaining({ claimMode: 'queued', intentId: 'intent-1' }))
  })

  it('keeps the immediate claim for an unstated or explicit immediate mode', async () => {
    const submit = vi.fn(async () => ({ runId: 'run-1', status: 'recorded', seq: 1 }))
    await dispatchRemoteRequest(controllerWith(submit), peer, { protocol: 3, op: 'submit', intentId: 'intent-1' })
    await dispatchRemoteRequest(controllerWith(submit), peer, { protocol: 3, op: 'submit', intentId: 'intent-2', mode: 'immediate' })
    const calls = submit.mock.calls as unknown as Array<[string, Record<string, unknown>]>
    expect(calls[0]?.[1]).not.toHaveProperty('claimMode')
    expect(calls[1]?.[1]).toMatchObject({ claimMode: 'immediate' })
  })

  it('refuses steer and restart, which need the host-local live run', async () => {
    const submit = vi.fn()
    for (const mode of ['steer', 'restart', 'nonsense']) {
      await expect(dispatchRemoteRequest(controllerWith(submit), peer, {
        protocol: 3, op: 'submit', intentId: 'intent-1', mode: mode as never
      })).resolves.toEqual({ error: 'invalid_request' })
    }
    expect(submit).not.toHaveBeenCalled()
  })
})
