import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { ProviderOperationGate, providerOperationKey } from '../provider-operation-gate'
import { RemoteRunPolicy, GatedExecutor, RemoteRunDenied, type WorkspaceAuthorizer } from './remote-run-policy'
import type { RemoteExecutor, RemoteExecutorInput } from './remote-dispatcher'

const AUTHORIZED = '/authorized/project'
const workspace: WorkspaceAuthorizer = {
  authorize(cwd) { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd }
}
const target = (over: Partial<{ cwd: string; providerId: string; agentProfileId?: string }> = {}) =>
  ({ cwd: AUTHORIZED, providerId: 'claude', ...over })

const input = (): RemoteExecutorInput => ({ runId: randomUUID(), detail: undefined, progress() {}, output() {} })

describe('RemoteRunPolicy', () => {
  it('authorizes a known workspace and leases the provider operation', () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    const decision = policy.authorize(target())
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.cwd).toBe(AUTHORIZED)
      expect(decision.providerKey).toBe(providerOperationKey('claude'))
      // While the operation lease is held, authentication is blocked (mutual exclusion).
      expect(gate.acquireAuthentication(decision.providerKey).ok).toBe(false)
      decision.release()
      // After release, authentication can proceed.
      const auth = gate.acquireAuthentication(decision.providerKey)
      expect(auth.ok).toBe(true)
    }
  })

  it('refuses a workspace not authorized through the picker and leases nothing', () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    const decision = policy.authorize(target({ cwd: '/tmp/smuggled' }))
    expect(decision).toEqual({ ok: false, reason: 'workspace_not_authorized' })
    // No lease was taken: a subsequent authentication succeeds immediately.
    expect(gate.acquireAuthentication(providerOperationKey('claude')).ok).toBe(true)
  })

  it('refuses an invalid target', () => {
    const policy = new RemoteRunPolicy({ gate: new ProviderOperationGate(), workspace })
    expect(policy.authorize(target({ providerId: '' })).ok).toBe(false)
    expect(policy.authorize({ cwd: AUTHORIZED, providerId: 'x', agentProfileId: 'z'.repeat(129) }).ok).toBe(false)
  })

  it('refuses a run while the provider is authenticating (mutual exclusion)', () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    const auth = gate.acquireAuthentication(providerOperationKey('claude'))
    expect(auth.ok).toBe(true)
    expect(policy.authorize(target())).toEqual({ ok: false, reason: 'provider_authenticating' })
  })

  it('allows concurrent runs of the same provider (operations stack)', () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    const first = policy.authorize(target())
    const second = policy.authorize(target())
    expect(first.ok && second.ok).toBe(true)
  })
})

describe('GatedExecutor', () => {
  it('reaches the base executor only after authorization and always releases the lease', async () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    let ran = 0
    const base: RemoteExecutor = { async execute() { ran++ } }
    const gated = new GatedExecutor({ policy, resolveTarget: () => target(), base })
    await gated.execute(input())
    expect(ran).toBe(1)
    // Lease released: authentication is free again.
    expect(gate.acquireAuthentication(providerOperationKey('claude')).ok).toBe(true)
  })

  it('never reaches the base executor when the workspace is unauthorized', async () => {
    const policy = new RemoteRunPolicy({ gate: new ProviderOperationGate(), workspace })
    let ran = 0
    const base: RemoteExecutor = { async execute() { ran++ } }
    const gated = new GatedExecutor({ policy, resolveTarget: () => target({ cwd: '/tmp/x' }), base })
    await expect(gated.execute(input())).rejects.toBeInstanceOf(RemoteRunDenied)
    expect(ran).toBe(0)
  })

  it('releases the lease even when the base executor throws', async () => {
    const gate = new ProviderOperationGate()
    const policy = new RemoteRunPolicy({ gate, workspace })
    const base: RemoteExecutor = { async execute() { throw new Error('provider failed') } }
    const gated = new GatedExecutor({ policy, resolveTarget: () => target(), base })
    await expect(gated.execute(input())).rejects.toThrow('provider failed')
    expect(gate.acquireAuthentication(providerOperationKey('claude')).ok).toBe(true)
  })
})
