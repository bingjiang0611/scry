import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { HostController, type HostControllerDependencies, type RemoteIntentRouting, type RemoteProjectRef, type RemoteProviderRef, type RemoteSessionRef, type RemoteHistoryTurn, type RemoteHistoryQuery } from './host-controller'
import { PairingFileStore } from './pairing-file'
import { SessionLedgerFileStore } from './session-ledger-file'
import { ensureHostIdentity } from './host-identity'
import type { VerifiedPairingCSR, IssuedPairingCertificate } from './pairing'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import type { ProviderOperationGate } from '../provider-operation-gate'

// Production binding for the remote subsystem. It gives HostController the real
// durable persistence (exclusive-lease JSONL ledger + fsynced pairing state) and
// leaves the pieces that require external decisions or the live app as explicit
// injected seams, so this module adds no supply-chain, crypto, or IPC coupling:
//
//   - verifyCSR / issue: the host-side X.509 adapters. Deliberately injected,
//     not implemented here — production must NOT silently gain an X.509
//     dependency or hand-rolled crypto (CLAUDE.md). The proven reference lives
//     in experiments/remote-g0 pending a maintainer dependency decision.
//   - authorizeWorkspace: wraps the app's known-project authority
//     (knownProjectDirectory) so a device can never target an unlisted path.
//   - startRun: delegates to the live run-start path (RunRegistry + Provider
//     adapter). It is the last seam before the IPC handler is touched.
//   - gate: the app-wide ProviderOperationGate, so remote runs share the same
//     auth-vs-run mutual exclusion as local runs.

export interface HostControllerBinding {
  controller: HostController
  // Release the durable leases. Call on app shutdown; a restart re-acquires and
  // the ledger replays any recorded-but-undispatched intents via recover().
  close(): void
}

export interface HostControllerFactoryDependencies {
  // Directory under Scry's userData; 'pairing' and 'ledger' subdirs are created.
  stateDirectory: string
  // A STABLE host identity across restarts. The persisted pairing state fails
  // closed (host_identity_changed) if this differs from a previous launch, so
  // production must derive it deterministically (e.g. persisted once under
  // userData), never a fresh per-process UUID.
  hostId: string
  anchorSHA256: string
  verifyCSR(csrPEM: string): Promise<VerifiedPairingCSR>
  issue(input: VerifiedPairingCSR & { deviceId: string }): Promise<IssuedPairingCertificate>
  authorizeWorkspace(cwd: string): string
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  }): Promise<void>
  gate: ProviderOperationGate
  // Snapshot of host-authorized project directories offered to devices.
  listProjects?(): RemoteProjectRef[]
  listProviders?(): RemoteProviderRef[]
  listSessions?(): RemoteSessionRef[]
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
}

// The file stores require a pre-existing private (0700) directory; create it
// exactly, independent of the process umask.
function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

// Higher-level production entry point: derive the persisted host identity (inner
// CA + stable hostId + verifyCSR/issue) from disk, then bind everything. This is
// what index.ts calls; only the live-app seams (workspace authorization,
// startRun, gate) remain to be supplied.
export async function createHostControllerFromDisk(deps: {
  stateDirectory: string
  authorizeWorkspace(cwd: string): string
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  }): Promise<void>
  gate: ProviderOperationGate
}): Promise<HostControllerBinding & { anchorSHA256: string; caCertificatePEM: string }> {
  const identity = await ensureHostIdentity(join(deps.stateDirectory, 'identity'))
  const binding = createHostController({
    stateDirectory: deps.stateDirectory,
    hostId: identity.hostId,
    anchorSHA256: identity.anchorSHA256,
    verifyCSR: identity.verifyCSR,
    issue: identity.issue,
    authorizeWorkspace: deps.authorizeWorkspace,
    startRun: deps.startRun,
    gate: deps.gate
  })
  return Object.assign(binding, { anchorSHA256: identity.anchorSHA256, caCertificatePEM: identity.caCertificatePEM })
}

export function createHostController(deps: HostControllerFactoryDependencies): HostControllerBinding {
  mkdirSync(deps.stateDirectory, { recursive: true })
  const pairingStore = new PairingFileStore(privateDir(join(deps.stateDirectory, 'pairing')))
  let ledgerStore: SessionLedgerFileStore
  try {
    ledgerStore = new SessionLedgerFileStore(privateDir(join(deps.stateDirectory, 'ledger')))
  } catch (error) {
    // Never leak the pairing lease if the ledger lease cannot be taken.
    pairingStore.close()
    throw error
  }

  const workspace: WorkspaceAuthorizer = { authorize: (cwd) => deps.authorizeWorkspace(cwd) }
  const controllerDeps: HostControllerDependencies = {
    pairing: {
      store: pairingStore,
      hostId: deps.hostId,
      anchorSHA256: deps.anchorSHA256,
      verifyCSR: deps.verifyCSR,
      issue: deps.issue
    },
    ledgerStore,
    workspace,
    gate: deps.gate,
    runProvider: deps.startRun,
    ...(deps.listProjects ? { listProjects: deps.listProjects } : {}),
    ...(deps.listProviders ? { listProviders: deps.listProviders } : {}),
    ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
    ...(deps.readHistory ? { readHistory: deps.readHistory } : {})
  }

  const controller = new HostController(controllerDeps)
  // Crash recovery: dispatch any intent durably recorded before the last exit.
  controller.recover()

  let closed = false
  return {
    controller,
    close: () => {
      if (closed) return
      closed = true
      // Close the ledger first (the authority may still reference pairing state
      // during teardown), then release the pairing lease.
      try { ledgerStore.close() } finally { pairingStore.close() }
    }
  }
}
