import { describe, expect, it, vi } from 'vitest'
import { ExecutionTargetRouter } from './execution-targets'
import type { HostController } from './host-controller'
import { dispatchRemoteRequest } from './inner-mtls-dispatch'

const peer = 'a'.repeat(64)
const target = { id: 'target-id', binding: 'b'.repeat(64) }
const retired = ['liveRuns', 'watch', 'watchStream', 'runState', 'poll', 'questions', 'intentStatus']
const subscribe = { op: 'subscribe', views: ['sessions', 'activeRuns'], waitMs: 0 }

describe('v3 remote wire boundary', () => {
  it('reports the host and client versions before attempting to dispatch a v2 request', async () => {
    const denied = vi.fn(() => { throw new Error('request touched the controller') })
    const controller = new Proxy({}, { get: denied }) as HostController
    await expect(dispatchRemoteRequest(controller, peer, { protocol: 2, ...subscribe })).resolves.toEqual({
      error: 'protocol_mismatch', hostProtocol: 3, clientProtocol: 2
    })
    expect(denied).not.toHaveBeenCalled()
  })

  it.each(retired)('refuses retired operation %s before reading any run data', async op => {
    const controller = {} as HostController
    await expect(dispatchRemoteRequest(controller, peer, {
      protocol: 3, op, runId: 'run-id', intentId: 'intent-id', cursor: 0, outputCursor: 0, waitMs: 0
    })).resolves.toEqual({ error: 'unknown_op' })
  })

  it.each(retired)('does not forward retired operation %s to another execution target', async op => {
    const mobileRequest = vi.fn()
    const mobileIntentStatus = vi.fn()
    const router = new ExecutionTargetRouter({
      authorizePeer: vi.fn(), gateway: { hostId: 'gateway', label: 'Gateway' },
      client: { executionTargets: vi.fn(), mobileRequest, mobileSubmit: vi.fn(), mobileIntentStatus }
    })
    const inputs: Record<string, object> = {
      liveRuns: { waitMs: 0 }, watch: { runId: 'run-id', cursor: 0, outputCursor: 0, waitMs: 0 },
      runState: { runId: 'run-id' }, poll: { cursor: 0 }, questions: { runId: 'run-id' }, intentStatus: { intentId: 'intent-id' }
    }
    await expect(router.dispatch(peer, { op: 'target', target, request: { op, ...inputs[op] } }))
      .rejects.toThrow('invalid_target_request')
    expect(mobileRequest).not.toHaveBeenCalled()
    expect(mobileIntentStatus).not.toHaveBeenCalled()
  })
})
