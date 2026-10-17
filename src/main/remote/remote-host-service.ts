import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { DesktopHostListeners, type DesktopHostListenerPorts } from './desktop-host-listeners'
import type { DesktopHostAccess, DesktopHostInvitation, DesktopRemoteContext, DesktopRemoteSessionAction } from '../../shared/desktop-remote'
import { ensureHostIdentity } from './host-identity'
import { createHostController, type HostControllerBinding, type HostControllerFactoryDependencies } from './host-controller-factory'
import { HostController, type RemoteIntentRouting, type RemoteProjectRef, type RemoteDirectoryListing, type RemoteProviderRef, type RemoteCommandCatalog, type RemoteCommandQuery, type RemoteSessionRef, type RemoteHistoryTurn, type RemoteHistoryQuery, type RemoteHistoryPreview } from './host-controller'
import { InnerMtlsHost } from './inner-mtls-host'
import { PairingTransport } from './pairing-transport'
import { RelayClient, type RelayTransport } from './relay-client'
import type { PairingAuthority } from './pairing'
import type { RunOutputStore } from './run-output-log'
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
// opened, so the subsystem is dormant until its owner supplies a relay. The
// app composition layer decides whether to inject the official default or a
// private override. The human-in-the-loop pairing
// confirmation (begin/confirmLocal/cancel/revoke) is exposed for the trusted
// LOCAL Scry UI only; it is never reachable from a device.

export interface RemoteHostServiceDependencies {
  readDesktop?: HostControllerFactoryDependencies['readDesktop']
  desktopWorkbench?: import('./desktop-workbench').DesktopWorkbenchHost
  desktopDirectories?: HostControllerFactoryDependencies['desktopDirectories']
  // Directory under Scry userData; identity/pairing/ledger subdirs live here.
  stateDirectory: string
  // Maps a device-requested cwd to an already directory-picker-authorized
  // workspace, or throws. A device can never smuggle an unlisted path.
  authorizeWorkspace(cwd: string): string
  // Delegates a fully-authorized remote intent to the live run-start path.
  startRun(input: {
    runId: string
    routing: RemoteIntentRouting
    progress(detail?: string): void
    output(chunk: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }): void
  }): Promise<void>
  // Snapshot of the host's already directory-picker-authorized project dirs, so
  // the phone's new-session picker chooses only among real authorized targets.
  // Absent => the device sees an honest empty list.
  listProjects?(): RemoteProjectRef[]
  listDirectories?(path?: string): RemoteDirectoryListing
  listProviders?(): RemoteProviderRef[]
  listCommands?(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
  sessionAction?: (context: DesktopRemoteContext, action: DesktopRemoteSessionAction, authorize: () => void) => Promise<boolean> | boolean
  listSessions?(): RemoteSessionRef[]
  sessionCatalogRevision?(): string
  readSessionStatus?: HostControllerFactoryDependencies['readSessionStatus']
  macRuns?: HostControllerFactoryDependencies['macRuns']
  readHistory?(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
  readHistoryPreview?(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
  readHistoryVersion?(query: RemoteHistoryQuery): Promise<import('./remote-gateway').RemoteHistoryVersion>
  readHistoryTurnsPage?(query: import('./remote-gateway').RemoteHistoryTurnsPageQuery): Promise<import('./remote-gateway').RemoteHistoryTurnsPage>
  // The app-wide gate, so remote runs share auth-vs-run mutual exclusion.
  gate: ProviderOperationGate
  createOutputStore?(directory: string): RunOutputStore | Promise<RunOutputStore>
  // How to reach the relay (deployed ws/net connector). Absent => dormant. Called
  // once per mode ('run' for the granted-device mTLS host, 'pair' for the pairing
  // prove endpoint), so the relay keeps a separate warm pool per mode. The
  // context carries the stable hostId + anchor the relay routes/authenticates by.
  createTransport?: (ctx: { hostId: string; anchorSHA256: string; mode: 'run' | 'pair' }) => RelayTransport
  // The device-facing coordinates of the SAME relay, embedded in the scannable
  // pairing code so the phone can reach this host. For a public wss relay
  // (Cloudflare) this is { host: '<name>.workers.dev', port: 443, tls: 'system' };
  // a local dev relay uses tls: 'plaintext'. Absent => no device code is emitted.
  relayAdvertisement?: { host: string; port: number; tls: 'system' | 'plaintext' }
}

export class RemoteHostService {
  #binding: HostControllerBinding
  #host: InnerMtlsHost
  #pairing: PairingTransport
  #clients: RelayClient[]
  #relayAdvertisement: { host: string; port: number; tls: 'system' | 'plaintext' } | null
  #starting: Promise<void> | null = null
  #disposing: Promise<void> | null = null
  #disposed = false
  #desktopListeners: DesktopHostListeners | null = null
  #desktopPorts: DesktopHostListenerPorts | null = null
  #desktopRestoreError: string | undefined
  #desktopChanging: Promise<unknown> | null = null
  #desktopSettingsPath: string
  readonly anchorSHA256: string
  readonly caCertificatePEM: string
  readonly hostId: string

  private constructor(init: {
    binding: HostControllerBinding
    stateDirectory: string
    host: InnerMtlsHost
    pairing: PairingTransport
    clients: RelayClient[]
    anchorSHA256: string
    caCertificatePEM: string
    hostId: string
    relayAdvertisement: { host: string; port: number; tls: 'system' | 'plaintext' } | null
  }) {
    this.#binding = init.binding
    this.#desktopSettingsPath = join(init.stateDirectory, 'desktop-listeners.json')
    this.#host = init.host
    this.#pairing = init.pairing
    this.#clients = init.clients
    this.anchorSHA256 = init.anchorSHA256
    this.caCertificatePEM = init.caCertificatePEM
    this.hostId = init.hostId
    this.#relayAdvertisement = init.relayAdvertisement ?? null
  }

  static async create(deps: RemoteHostServiceDependencies): Promise<RemoteHostService> {
    const identity = await ensureHostIdentity(join(deps.stateDirectory, 'identity'))
    const binding = await createHostController({
      stateDirectory: deps.stateDirectory,
      ...(deps.readDesktop ? { readDesktop: deps.readDesktop } : {}),
      ...(deps.desktopWorkbench ? { desktopWorkbench: deps.desktopWorkbench } : {}),
      ...(deps.desktopDirectories ? { desktopDirectories: deps.desktopDirectories } : {}),
      hostId: identity.hostId,
      anchorSHA256: identity.anchorSHA256,
      verifyCSR: identity.verifyCSR,
      issue: identity.issue,
      authorizeWorkspace: deps.authorizeWorkspace,
      startRun: deps.startRun,
      gate: deps.gate,
      ...(deps.createOutputStore ? { createOutputStore: deps.createOutputStore } : {}),
      ...(deps.listProjects ? { listProjects: deps.listProjects } : {}),
      ...(deps.listDirectories ? { listDirectories: deps.listDirectories } : {}),
      ...(deps.listProviders ? { listProviders: deps.listProviders } : {}),
      ...(deps.listCommands ? { listCommands: deps.listCommands } : {}),
      ...(deps.sessionAction ? { sessionAction: deps.sessionAction } : {}),
      ...(deps.listSessions ? { listSessions: deps.listSessions } : {}),
      ...(deps.sessionCatalogRevision ? { sessionCatalogRevision: deps.sessionCatalogRevision } : {}),
      ...(deps.readSessionStatus ? { readSessionStatus: deps.readSessionStatus } : {}),
      ...(deps.macRuns ? { macRuns: deps.macRuns } : {}),
      ...(deps.readHistory ? { readHistory: deps.readHistory } : {}),
      ...(deps.readHistoryPreview ? { readHistoryPreview: deps.readHistoryPreview } : {}),
      ...(deps.readHistoryVersion ? { readHistoryVersion: deps.readHistoryVersion } : {}),
      ...(deps.readHistoryTurnsPage ? { readHistoryTurnsPage: deps.readHistoryTurnsPage } : {})    })
    let host: InnerMtlsHost
    let pairing: PairingTransport
    try {
      const server = await identity.issueHostServer()
      host = new InnerMtlsHost({
        controller: binding.controller,
        serverCertPEM: server.certificatePEM,
        serverKeyPEM: server.privateKeyPEM,
        caPEM: identity.caCertificatePEM
      })
      pairing = new PairingTransport({
        authority: binding.controller.authority,
        serverCertPEM: server.certificatePEM,
        serverKeyPEM: server.privateKeyPEM
      })
    } catch (error) {
      // Never leak the durable leases if host assembly fails.
      await binding.close()
      throw error
    }
    const clients: RelayClient[] = []
    if (deps.createTransport) {
      const ctx = { hostId: identity.hostId, anchorSHA256: identity.anchorSHA256 }
      clients.push(new RelayClient({ host, transport: deps.createTransport({ ...ctx, mode: 'run' }) }))
      clients.push(new RelayClient({ host: pairing, transport: deps.createTransport({ ...ctx, mode: 'pair' }) }))
    }
    return new RemoteHostService({
      binding, host, pairing, clients,
      stateDirectory: deps.stateDirectory,
      anchorSHA256: identity.anchorSHA256,
      caCertificatePEM: identity.caCertificatePEM,
      hostId: identity.hostId,
      relayAdvertisement: deps.relayAdvertisement ?? null
    })
  }

  // Trusted LOCAL pairing-confirmation surface. HostController exposes the
  // authority whose begin/confirmLocal/cancel/revoke are only ever called by the
  // Mac's own UI, never from a device (devices reach only prove/status over the
  // verified transport).
  get authority(): PairingAuthority { return this.#binding.controller.authority }
  get controller(): HostController { return this.#binding.controller }
  get host(): InnerMtlsHost { return this.#host }
  get pairingTransport(): PairingTransport { return this.#pairing }
  get relayConfigured(): boolean { return this.#clients.length > 0 }

  // --- Trusted-LOCAL pairing UI operations (sanitized; renderer-facing) -------
  // These project only display-safe fields; the pairing secret verifier, private
  // keys, and certificate PEMs never cross to the renderer.

  desktopStatus(): DesktopHostAccess {
    return this.#desktopPorts ? { enabled: true, ...this.#desktopPorts } : {
      enabled: false, ...(this.#desktopRestoreError ? { reason: this.#desktopRestoreError } : {})
    }
  }

  async beginDesktopPairing(): Promise<string> {
    await this.start()
    return this.#changeDesktop(async () => {
      if (!this.#desktopPorts) await this.#enableDesktop()
      if (this.#disposed) throw new Error('remote_host_service_disposed')
      const code = await this.authority.begin()
      if (this.#disposed) throw new Error('remote_host_service_disposed')
      const invitation: DesktopHostInvitation = {
        version: 1, hostId: this.hostId, anchorPEM: this.caCertificatePEM,
        ...this.#desktopPorts!, pairingId: code.pairingId, secret: code.secret, expiresAt: code.expiresAt
      }
      return `scry-desktop1:${Buffer.from(JSON.stringify(invitation)).toString('base64url')}`
    })
  }

  async disableDesktop(): Promise<void> {
    await this.start()
    return this.#changeDesktop(async () => {
      // Persist the user's off decision before acknowledging it. Do not revoke
      // unrelated iOS grants or interrupt tasks already running on this host.
      rmSync(this.#desktopSettingsPath, { force: true })
      await this.#desktopListeners?.close()
      this.#desktopListeners = null
      this.#desktopPorts = null
      this.#desktopRestoreError = undefined
    })
  }

  async #changeDesktop<T>(action: () => Promise<T>): Promise<T> {
    if (this.#disposed) throw new Error('remote_host_service_disposed')
    if (this.#desktopChanging) throw new Error('desktop_access_busy')
    const pending = action()
    this.#desktopChanging = pending
    try { return await pending } finally { this.#desktopChanging = null }
  }

  async #enableDesktop(ports?: DesktopHostListenerPorts): Promise<void> {
    const listeners = new DesktopHostListeners({ pair: this.#pairing, run: this.#host, ...ports })
    // Own the instance before awaiting bind, so dispose can close a pending start.
    this.#desktopListeners = listeners
    try {
      const bound = await listeners.start()
      if (this.#disposed) throw new Error('remote_host_service_disposed')
      const temp = `${this.#desktopSettingsPath}.tmp`
      writeFileSync(temp, JSON.stringify(bound), { mode: 0o600 })
      renameSync(temp, this.#desktopSettingsPath)
      this.#desktopPorts = bound
      this.#desktopRestoreError = undefined
    } catch (error) {
      await listeners.close()
      if (this.#desktopListeners === listeners) this.#desktopListeners = null
      throw error
    }
  }

  async beginPairing(): Promise<RemotePairingCode> {
    const code = await this.authority.begin()
    return { ...code, deviceCode: this.#encodeDeviceCode(code) }
  }

  // Build the scannable `scry1:` code the phone consumes. It embeds the relay
  // coordinates + the full host anchor PEM so the device can reach this host and
  // pin its inner CA. Only emitted when a relay is advertised; the anchor PEM is
  // a public certificate, and the secret is the same single-use value already in
  // the code, so nothing extra is leaked.
  #encodeDeviceCode(code: { pairingId: string; secret: string }): string | null {
    const relay = this.#relayAdvertisement
    // Only emit a scannable code when the host is actually dialing a relay; a
    // code the device could never reach would be a dishonest 'ready' signal.
    if (!relay || !this.relayConfigured) return null
    const payload = {
      relayHost: relay.host,
      relayPort: relay.port,
      relayTLS: relay.tls,
      hostId: this.hostId,
      pairingId: code.pairingId,
      secret: code.secret,
      anchorPEM: this.caCertificatePEM
    }
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return `scry1:${b64}`
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

  async revokeDevice(deviceId: string): Promise<void> {
    const peers = this.authority.inspectLocal().grants.filter((grant) => grant.deviceId === deviceId).map((grant) => grant.certificateSHA256)
    await this.authority.revoke(deviceId)
    await Promise.all(peers.map((peer) => this.#binding.controller.releaseDesktopPeer(peer)))
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
    return this.#starting ??= this.#start()
  }

  async #start(): Promise<void> {
    try {
      let saved: unknown
      try { saved = JSON.parse(readFileSync(this.#desktopSettingsPath, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (saved !== undefined) {
        const ports = saved as Partial<DesktopHostListenerPorts> | null
        if (!ports || !Number.isInteger(ports.pairPort) || !Number.isInteger(ports.runPort) ||
            Number(ports.pairPort) < 1 || Number(ports.runPort) < 1 ||
            Number(ports.pairPort) > 65535 || Number(ports.runPort) > 65535 || ports.pairPort === ports.runPort) {
          throw new Error('desktop_listener_settings_invalid')
        }
        await this.#enableDesktop(ports as DesktopHostListenerPorts)
      }
    } catch (error) {
      if (this.#disposed) throw error
      // SSH restore is an independent optional transport. Keep it closed and
      // expose the failure; a port collision must not disable existing phone grants.
      this.#desktopRestoreError = `desktop_listener_restore_failed: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`
    }
    for (const client of this.#clients) {
      if (this.#disposed) throw new Error('remote_host_service_disposed')
      await client.start()
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    return this.#disposing ??= this.#dispose()
  }

  async #dispose(): Promise<void> {
    try { await this.#desktopListeners?.close() } finally {
      this.#desktopListeners = null
      this.#desktopPorts = null
      try { await Promise.all(this.#clients.map(client => client.close())) } finally {
        // Startup/enable callers receive their own failure. Drain them before
        // releasing the authority leases; none may publish a listener afterward.
        await this.#starting?.catch(() => undefined)
        await this.#desktopChanging?.catch(() => undefined)
        try { await this.#host.close() } finally {
          try { await this.#pairing.close() } finally { await this.#binding.close() }
        }
      }
    }
  }
}
