import { ProviderOperationGate, providerOperationKey } from '../provider-operation-gate'
import type { RemoteExecutor, RemoteExecutorInput } from './remote-dispatcher'

// G2 trust + mutual-exclusion seam. Before a remote intent may start a Provider
// run it must (1) target a workspace already authorized through Scry's directory
// picker (never a path smuggled in from the device) and (2) win the provider
// operation lease that is mutually exclusive with authentication. This reuses
// the production ProviderOperationGate and workspace-authorization contract
// rather than inventing a parallel one, and fails closed.
//
// This module does not itself execute a Provider; it decides and leases. The
// real executor (RunRegistry + a Provider adapter) plugs in behind GatedExecutor
// and is only reached once the policy has authorized the run.

export interface WorkspaceAuthorizer {
  // Return the canonical directory, or throw if it is not a known, authorized
  // project. Wraps knownProjectDirectory in production.
  authorize(cwd: string): string
}

export interface RemoteRunTarget {
  cwd: string
  providerId: string
  agentProfileId?: string
}

export type RemoteRunAuthorization =
  | { ok: true; cwd: string; providerKey: string; release(): void }
  | { ok: false; reason: 'workspace_not_authorized' | 'invalid_target' | 'provider_authenticating' }

export class RemoteRunPolicy {
  #gate: ProviderOperationGate
  #workspace: WorkspaceAuthorizer

  constructor(deps: { gate: ProviderOperationGate; workspace: WorkspaceAuthorizer }) {
    this.#gate = deps.gate
    this.#workspace = deps.workspace
  }

  authorize(target: RemoteRunTarget): RemoteRunAuthorization {
    if (!target || typeof target.providerId !== 'string' || target.providerId.length === 0 || target.providerId.length > 128) {
      return { ok: false, reason: 'invalid_target' }
    }
    if (target.agentProfileId !== undefined && (typeof target.agentProfileId !== 'string' || target.agentProfileId.length > 128)) {
      return { ok: false, reason: 'invalid_target' }
    }
    let cwd: string
    try { cwd = this.#workspace.authorize(target.cwd) }
    catch { return { ok: false, reason: 'workspace_not_authorized' } }
    const providerKey = providerOperationKey(target.providerId, target.agentProfileId)
    const lease = this.#gate.acquireOperation(providerKey)
    if (!lease.ok) return { ok: false, reason: 'provider_authenticating' }
    return { ok: true, cwd, providerKey, release: lease.release }
  }
}

export class RemoteRunDenied extends Error {
  reason: string
  constructor(reason: string) {
    super(reason)
    this.name = 'RemoteRunDenied'
    this.reason = reason
  }
}

// Wraps a base executor so the dispatcher only ever reaches the real Provider
// run after the policy authorizes it. The operation lease is always released
// once the base executor settles or throws, so a failure never leaks a lease.
export class GatedExecutor implements RemoteExecutor {
  #policy: RemoteRunPolicy
  #resolveTarget: (input: RemoteExecutorInput) => RemoteRunTarget
  #base: RemoteExecutor

  constructor(deps: {
    policy: RemoteRunPolicy
    resolveTarget: (input: RemoteExecutorInput) => RemoteRunTarget
    base: RemoteExecutor
  }) {
    this.#policy = deps.policy
    this.#resolveTarget = deps.resolveTarget
    this.#base = deps.base
  }

  async execute(input: RemoteExecutorInput): Promise<void> {
    let target: RemoteRunTarget
    try { target = this.#resolveTarget(input) }
    catch { throw new RemoteRunDenied('invalid_target') }
    const authorization = this.#policy.authorize(target)
    if (!authorization.ok) throw new RemoteRunDenied(authorization.reason)
    try {
      await this.#base.execute(input)
    } finally {
      authorization.release()
    }
  }
}
