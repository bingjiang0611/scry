import { PairingAuthority, type PairingDependencies } from './pairing'
import { SessionLedger, type LedgerStore, type RunLifecycle } from './session-ledger'
import { RemoteGateway, type RemoteProjectRef, type RemoteProviderRef } from './remote-gateway'
import { RunOutputLog, type RunOutputPage } from './run-output-log'
export type { RemoteProjectRef, RemoteProviderRef } from './remote-gateway'
export type { RunOutputPage, OutputChunk } from './run-output-log'
import { RemoteDispatcher, type RemoteExecutor, type RemoteExecutorInput } from './remote-dispatcher'
import { RemoteRunPolicy, GatedExecutor, RemoteRunDenied, type WorkspaceAuthorizer, type RemoteRunTarget } from './remote-run-policy'
import { RemoteTerminalOwnership } from './remote-terminal-ownership'
import { ProviderOperationGate } from '../provider-operation-gate'

// Trusted-local composition root for the remote subsystem. It wires the six
// modules proven in isolation (PairingAuthority, SessionLedger, RemoteGateway,
// RemoteDispatcher, RemoteRunPolicy/GatedExecutor, RemoteTerminalOwnership) into
// one object that Electron main constructs. Only trusted local UI calls the
// pairing/lifecycle methods; the device-facing surface is reached over
// inner-mTLS and always carries the VERIFIED peer certificate fingerprint.
//
// The controller adds no new security decisions — it composes the existing ones
// and keeps the truthful boundary intact: a device submission is a durable
// intent (recorded ≠ executed); the dispatcher drives exactly-once execution
// through the gated executor (workspace + provider-operation mutual exclusion);
// the base executor is the only injected leaf, where the real RunRegistry +
// Provider adapter will plug in.

// The structured routing a device intent must resolve to before any Provider
// run. Carried in the intent detail as JSON; malformed detail is denied.
export interface RemoteIntentRouting extends RemoteRunTarget {
  prompt?: string
}

export interface HostControllerDependencies {
  // Pairing adapters (CSR verification + certificate issuance + persistence).
  pairing: PairingDependencies
  // Durable ledger backing store (JSONL file store in production).
  ledgerStore: LedgerStore
  // Resolves and authorizes a workspace against the known-project authority.
  workspace: WorkspaceAuthorizer
  // The only injected leaf: performs the real Provider run for a routed intent.
  // `output` streams the assistant's real trace CONTENT (masked, bounded) to the
  // device; distinct from the opaque lifecycle `progress` markers.
  runProvider(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  }): Promise<void>
  // Snapshot of host-authorized project directories a device may target. Absent
  // => the device sees an honest empty list (never a fabricated one).
  listProjects?(): RemoteProjectRef[]
  // Snapshot of the host's Providers a device may target. Absent => honest empty.
  listProviders?(): RemoteProviderRef[]
  // Optional shared operation gate (auth vs run mutual exclusion). A fresh one
  // is created when omitted; production passes the app-wide gate.
  gate?: ProviderOperationGate
}

function parseRouting(detail: string | undefined): RemoteIntentRouting {
  if (typeof detail !== 'string' || detail.length === 0 || detail.length > 4096) throw new RemoteRunDenied('invalid_target')
  let parsed: unknown
  try { parsed = JSON.parse(detail) } catch { throw new RemoteRunDenied('invalid_target') }
  if (!parsed || typeof parsed !== 'object') throw new RemoteRunDenied('invalid_target')
  const routing = parsed as Record<string, unknown>
  if (typeof routing.cwd !== 'string' || typeof routing.providerId !== 'string') throw new RemoteRunDenied('invalid_target')
  return {
    cwd: routing.cwd,
    providerId: routing.providerId,
    ...(typeof routing.agentProfileId === 'string' ? { agentProfileId: routing.agentProfileId } : {}),
    ...(typeof routing.prompt === 'string' ? { prompt: routing.prompt } : {})
  }
}

export class HostController {
  readonly authority: PairingAuthority
  readonly terminals = new RemoteTerminalOwnership()
  #ledger: SessionLedger
  #gateway: RemoteGateway
  #dispatcher: RemoteDispatcher
  #output = new RunOutputLog()

  constructor(deps: HostControllerDependencies) {
    this.authority = new PairingAuthority(deps.pairing)
    this.#ledger = new SessionLedger({ store: deps.ledgerStore })
    this.#gateway = new RemoteGateway({
      authority: this.authority,
      ledger: this.#ledger,
      output: this.#output,
      ...(deps.listProjects ? { projects: { list: deps.listProjects } } : {}),
      ...(deps.listProviders ? { providers: { list: deps.listProviders } } : {})
    })

    const policy = new RemoteRunPolicy({ gate: deps.gate ?? new ProviderOperationGate(), workspace: deps.workspace })
    const base: RemoteExecutor = {
      execute: (input: RemoteExecutorInput) =>
        deps.runProvider({ runId: input.runId, routing: parseRouting(input.detail), progress: input.progress, output: input.output })
    }
    const gated = new GatedExecutor({ policy, resolveTarget: (input) => parseRouting(input.detail), base })
    this.#dispatcher = new RemoteDispatcher({ ledger: this.#ledger, executor: gated, outputSink: this.#output })
  }

  // On startup, dispatch any intent that was durably recorded but never
  // dispatched (crash recovery), exactly once.
  recover(): void {
    this.#dispatcher.pump()
  }

  // Device-facing (inner-mTLS): submit a durable intent, then drive the
  // dispatcher so the gated executor picks it up exactly once.
  submitIntent(peerCertSHA256: string, input: { intentId: string; detail?: string }): { runId: string; status: 'recorded' | 'duplicate' } {
    const result = this.#gateway.submitIntent(peerCertSHA256, input)
    this.#dispatcher.pump()
    return result
  }

  poll(peerCertSHA256: string, input: { cursor: number }): ReturnType<SessionLedger['since']> {
    return this.#gateway.poll(peerCertSHA256, input)
  }

  runState(peerCertSHA256: string, input: { runId: string }): RunLifecycle | undefined {
    return this.#gateway.runState(peerCertSHA256, input)
  }

  // Device-facing: the host-authorized project directories this device may
  // target, authorized by the same verified peer certificate as every method.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    return this.#gateway.listProjects(peerCertSHA256)
  }

  // Device-facing: the Providers this device may target, authorized by the same
  // verified peer certificate as every method.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    return this.#gateway.listProviders(peerCertSHA256)
  }

  // Device-facing: the assistant's real streamed output CONTENT for one run,
  // strictly after the caller's cursor, authorized by the verified peer cert.
  runOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): RunOutputPage {
    return this.#gateway.pollOutput(peerCertSHA256, input)
  }

  // Test/shutdown aid: wait for in-flight executor work to settle.
  async idle(): Promise<void> {
    await this.#dispatcher.idle()
  }
}
