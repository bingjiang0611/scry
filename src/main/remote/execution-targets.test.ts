import { describe, expect, it, vi } from 'vitest'
import { ExecutionTargetRouter, executionTargetPayloadHash } from './execution-targets'

const peer = 'a'.repeat(64)
const target = { id: 'connection-id', binding: 'b'.repeat(64) }
const response = { projects: [{ path: '/mac2/project', label: 'project' }] }

function router(client = {
  executionTargets: vi.fn(async () => [{ ...target, hostId: 'mac2', label: 'Mac2', state: 'connected' as const }]),
  mobileRequest: vi.fn(async () => response),
  mobileSubmit: vi.fn(async (_input: { payloadHash: string; request: Record<string, unknown> }) => ({ runId: 'run', status: 'recorded' })),
  mobileIntentStatus: vi.fn(async () => ({ intent: { runId: 'run', state: 'recorded' } }))
}) {
  let authorized = true
  return {
    client,
    revoke: () => { authorized = false },
    router: new ExecutionTargetRouter({ authorizePeer: (value) => {
      if (value !== peer || !authorized) throw new Error('device_not_authorized')
    }, client, gateway: { hostId: 'mac1', label: 'Mac1' } })
  }
}

describe('execution target production dispatcher', () => {
  it('returns frozen discovery metadata and excludes no-op local routing', async () => {
    const fixture = router()
    await expect(fixture.router.discovery(peer)).resolves.toEqual({ executionTargets: {
      version: 1, gateway: { hostId: 'mac1', label: 'Mac1' },
      targets: [{ ...target, hostId: 'mac2', label: 'Mac2', state: 'connected' }]
    } })
  })

  it('rejects revoked peers, changed bindings, recursive routes, and desktop authority before transport', async () => {
    const client = {
      executionTargets: vi.fn(async () => []),
      mobileRequest: vi.fn(async (value: { id: string; binding: string }) => {
        if (value.binding !== target.binding) throw new Error('execution_target_binding_changed')
        return response
      }),
      mobileSubmit: vi.fn(async () => ({ runId: 'run', status: 'recorded' })),
      mobileIntentStatus: vi.fn(async () => ({ intent: { runId: 'run', state: 'recorded' } }))
    }
    const fixture = router(client)
    await expect(fixture.router.dispatch(peer, { op: 'target', target: { ...target, binding: 'c'.repeat(64) }, request: { op: 'projects' } })).rejects.toThrow('execution_target')
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { op: 'target', target, request: { op: 'projects' } } })).rejects.toThrow('invalid_target_request')
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { op: 'desktopDirectory', query: {} } })).rejects.toThrow('invalid_target_request')
    client.mobileRequest.mockClear()
    fixture.revoke()
    await expect(fixture.router.discovery(peer)).rejects.toThrow('device_not_authorized')
    expect(client.mobileRequest).not.toHaveBeenCalled()
  })

  it('forwards approved mobile operations with a binding stamp and rejects desktop directory selection', async () => {
    const fixture = router()
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { op: 'projects' } })).resolves.toEqual({ ...response, executionTarget: target })
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { op: 'desktopWorkbench', query: {} } })).rejects.toThrow('invalid_target_request')
    expect(fixture.client.mobileRequest).toHaveBeenCalledWith(target, { op: 'projects' }, expect.any(Function))
  })

  it('forwards explicit file downloads without widening the workspace browser or allowing writes', async () => {
    const fixture = router()
    const request = { op: 'fileDownload', query: { action: 'open', cwd: '/mac2/project', target: 'http://127.0.0.1:49732/bolder-v1.html?x=1' } }
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request })).resolves.toHaveProperty('executionTarget', target)
    expect(fixture.client.mobileRequest).toHaveBeenLastCalledWith(target, request, expect.any(Function))
    for (const changed of [{ write: true }, { method: 'POST' }]) {
      await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { ...request, query: { ...request.query, ...changed } } })).rejects.toThrow('invalid_request')
    }
    fixture.client.mobileRequest.mockClear()
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { ...request, query: { ...request.query, target: 'http://example.com/' } } })).rejects.toThrow('invalid_local_url')
    expect(fixture.client.mobileRequest).not.toHaveBeenCalled()
  })

  it('preserves mobile history byte budgets and the authorized workspace root', async () => {
    const fixture = router()
    const page = { op: 'historyPage', agentProfileId: 'profile-b', providerId: 'pi', cwd: '/mac2/project', externalSessionId: 'session', cursor: 0, limit: 256 * 1024 }
    await fixture.router.dispatch(peer, { op: 'target', target, request: page })
    expect(fixture.client.mobileRequest).toHaveBeenLastCalledWith(target, page, expect.any(Function))
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { ...page, limit: 256 * 1024 + 1 } })).rejects.toThrow('invalid_target_request')
    const root = { op: 'workspace', query: { action: 'list', cwd: '/mac2/project', path: '' } }
    await fixture.router.dispatch(peer, { op: 'target', target, request: root })
    expect(fixture.client.mobileRequest).toHaveBeenLastCalledWith(target, root, expect.any(Function))
  })

  it('treats a question ID named target as answer data, not routing authority', async () => {
    const fixture = router()
    const request = { op: 'answerQuestion', runId: 'run', answerId: 'answer', response: { requestId: 'question', answers: { target: ['Mac2'] } } }
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request })).resolves.toHaveProperty('executionTarget', target)
    await expect(fixture.router.dispatch(peer, { op: 'target', target, request: { ...request, deviceLabel: 'spoofed phone' } })).rejects.toThrow('invalid_target_request')
  })

  it('canonicalizes routing JSON so restart key order does not change the durable payload', async () => {
    const fixture = router()
    const request = { op: 'submit', intentId: '123e4567-e89b-42d3-a456-426614174000', detail: '{"providerId":"pi","cwd":"/project"}' }
    await fixture.router.dispatch(peer, { op: 'target', target, request })
    await fixture.router.dispatch(peer, { op: 'target', target, request: { ...request, detail: '{"cwd":"/project","providerId":"pi"}' } })
    const [first, second] = fixture.client.mobileSubmit.mock.calls.map((call) => call[0])
    expect(first.payloadHash).toBe(second.payloadHash)
    expect(first.request).toEqual(second.request)
  })

  it('uses the upstream UUID and stable payload hash for submit while stripping authority metadata', async () => {
    const fixture = router()
    const request = { op: 'submit', intentId: '123e4567-e89b-42d3-a456-426614174000', detail: '{"cwd":"/project","providerId":"claude"}' }
    await fixture.router.dispatch(peer, { op: 'target', target, request })
    expect(fixture.client.mobileSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target, phonePeerFingerprint: peer, phoneIntentId: request.intentId,
      payloadHash: executionTargetPayloadHash(request), request
    }))
  })
})
