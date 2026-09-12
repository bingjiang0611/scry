import { join } from 'node:path'
import { ensureHostIdentity } from './host-identity'
import { createHostController, type HostControllerBinding } from './host-controller-factory'
import { HostController, type RemoteIntentRouting } from './host-controller'
import { InnerMtlsHost } from './inner-mtls-host'
import { RelayClient, type RelayTransport } from './relay-client'
import type { PairingAuthority } from './pairing'
import type { ProviderOperationGate } from '../provider-operation-gate'
import type { RemotePairingCode, RemotePendingPairing, RemoteDevice, RemoteStatus } from '../../shared/remote'

// The single object Electron main owns for the remote-access subsystem. It
// composes the already-proven pieces (persisted host identity + inner CA,
// HostController with durable pairing/ledger, the inner-mTLS host, and the Mac
// relay client) into one lifecycle with start()/dispose(). It adds NO new
// security decisions - authorization stays inside HostController/PairingAuthority
// and the inner-mTLS fingerprint check.
//
// The relay transport is INJECTED. When it is absent the host is fully
// constructed and can pair and serve locally, but no outbound relay leg is
// opened - so the subsystem is dormant until a relay endpoint is configured,
// and default app behaviour is unchanged. The human-in-the-loop pairing
// confirmation (begin/confirmLocal/cancel/revoke) is exposed for the trusted
// LOCAL Scry UI only; it is never reachable from a device.

export interface RemoteHostServiceDependencies {
  // Directory under Scry userData; identity/pairing/ledger subdirs live here.
  stateDirectory: string
  // Maps a device-requested cwd to an already directory-picker-authorized
  // workspace, or throws. A device can never smuggle an unlisted path.
  authorizeWorkspace(cwd: string): string
  // Delegates a fully-authorized remote intent to the live run-start path.
  startRun(input: { runId: string; routing: RemoteIntentRouting; progress(detail?: string): void }): Promise<void>
  // The app-wide gate, so remote runs share auth-vs-run mutual exclusion.
  gate: ProviderOperationGate
  // How to reach the relay (deployed ws/net connector). Absent => dormant. The
  // context carries the stable hostId + anchor the relay routes/authenticates by.
  createTransport?: (ctx: { host: InnerMtlsHost; hostId: string; anchorSHA256: string }) => RelayTransport
}

export class RemoteHostService {
  #binding: HostControllerBinding
  #host: InnerMtlsHost
  #client: RelayClient | null
  #started = false
  #disposed = false
  readonly anchorSHA256: string
  readonly caCertificatePEM: string
  readonly hostId: string

  private constructor(init: {
    binding: HostControllerBinding
    host: InnerMtlsHost
    client: RelayClient | null
    anchorSHA256: string
    caCertificatePEM: string
    hostId: string
  }) {
    this.#binding = init.binding
    this.#host = init.host
    this.#client = init.client
    this.anchorSHA256 = init.anchorSHA256
    this.caCertificatePEM = init.caCertificatePEM
    this.hostId = init.hostId
  }

  static async create(deps: RemoteHostServiceDependencies): Promise<RemoteHostService> {
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
    let host: InnerMtlsHost
    try {
      const server = await identity.issueHostServer()
      host = new InnerMtlsHost({
        controller: binding.controller,
        serverCertPEM: server.certificatePEM,
        serverKeyPEM: server.privateKeyPEM,
        caPEM: identity.caCertificatePEM
      })
    } catch (error) {
      // Never leak the durable leases if host assembly fails.
      binding.close()
      throw error
    }
    const client = deps.createTransport
      ? new RelayClient({ host, transport: deps.createTransport({ host, hostId: identity.hostId, anchorSHA256: identity.anchorSHA256 }) })
      : null
    return new RemoteHostService({
      binding, host, client,
      anchorSHA256: identity.anchorSHA256,
      caCertificatePEM: identity.caCertificatePEM,
      hostId: identity.hostId
    })
  }

  // Trusted LOCAL pairing-confirmation surface. HostController exposes the
  // authority whose begin/confirmLocal/cancel/revoke are only ever called by the
  // Mac's own UI, never from a device (devices reach only prove/status over the
  // verified transport).
  get authority(): PairingAuthority { return this.#binding.controller.authority }
  get controller(): HostController { return this.#binding.controller }
  get host(): InnerMtlsHost { return this.#host }
  get relayConfigured(): boolean { return this.#client !== null }

  // --- Trusted-LOCAL pairing UI operations (sanitized; renderer-facing) -------
  // These project only display-safe fields; the pairing secret verifier, private
  // keys, and certificate PEMs never cross to the renderer.

  beginPairing(): Promise<RemotePairingCode> {
    return this.authority.begin()
  }

  // Confirm a proved pairing. The operator passes back the exact key fingerprint
  // shown on the Mac (and compared against the device), so a racing device that
  // proved a different key cannot be confirmed by accident - confirmLocal fails
  // closed unless the pairing's proven key matches.
  async confirmPairing(pairingId: string, expectedPublicKeySHA256: string): Promise<RemoteDevice> {
    const grant = await this.authority.confirmLocal(pairingId, expectedPublicKeySHA256)
    return { deviceId: grant.deviceId, deviceLabel: grant.deviceLabel, expiresAt: grant.expiresAt, confirmedAt: grant.confirmedAt, revoked: grant.revokedAt !== null }
  }

  cancelPairing(pairingId: string): Promise<void> {
    return this.authority.cancel(pairingId)
  }

  revokeDevice(deviceId: string): Promise<void> {
    return this.authority.revoke(deviceId)
  }

  // Display-safe snapshot for the pairing screen.
  status(): RemoteStatus {
    const state = this.authority.inspectLocal()
    const pending: RemotePendingPairing[] = state.pairings
      .filter((p): p is typeof p & { state: 'created' | 'awaiting_local_confirmation' } => p.state === 'created' || p.state === 'awaiting_local_confirmation')
      .map((p) => p.state === 'awaiting_local_confirmation'
        ? { pairingId: p.pairingId, state: p.state, expiresAt: p.expiresAt, deviceLabel: p.proof.deviceLabel, publicKeySHA256: p.proof.publicKeySHA256 }
        : { pairingId: p.pairingId, state: p.state, expiresAt: p.expiresAt })
    const devices: RemoteDevice[] = state.grants.map((g) => ({ deviceId: g.deviceId, deviceLabel: g.deviceLabel, expiresAt: g.expiresAt, confirmedAt: g.confirmedAt, revoked: g.revokedAt !== null }))
    return { enabled: true, hostId: this.hostId, anchorSHA256: this.anchorSHA256, relayConfigured: this.relayConfigured, pending, devices }
  }

  // Open the outbound relay leg(s), if a transport was configured. Idempotent;
  // a no-op when dormant.
  async start(): Promise<void> {
    if (this.#disposed) throw new Error('remote_host_service_disposed')
    if (this.#started) return
    this.#started = true
    if (this.#client) await this.#client.start()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    try { if (this.#client) await this.#client.close() } finally {
      try { await this.#host.close() } finally { this.#binding.close() }
    }
  }
}
