import { SessionLedger, type RunLifecycle } from './session-ledger'
import type { RunOutputPage } from './run-output-log'

// G1 application service: the device-facing surface that a verified remote peer
// reaches once its inner-mTLS identity is established. It composes the two host
// subsystems already proven in isolation — the pairing authority (who is an
// authorized owner device) and the session ledger (durable intents + cursor).
//
// Security boundary (mirrors PairingAuthority.prove):
//   - The peer's certificate fingerprint is supplied by the transport from the
//     VERIFIED inner-mTLS peer certificate, never from a field in the request
//     body. Every method re-authorizes it, so a mid-session revocation denies
//     the very next call.
//   - The gateway never executes anything. A device submission is recorded as a
//     durable intent (recorded ≠ executed); the trusted host executor drives
//     dispatch/settle on the ledger directly, and those events are reflected to
//     the device only through poll(). This preserves the truthful lifecycle.
//   - Single-owner model: authorized owner devices share the host feed, so poll
//     returns the host-global cursor stream. Per-device partitioning is a later
//     concern and is not faked here.
//
// This module is pure and NOT wired into live IPC/network/RunRegistry yet.

export interface DeviceAuthorizer {
  // True only for a non-revoked, non-expired owner-device grant.
  authorizesCertificate(certificateSHA256: string): boolean
}

// One host-authorized project directory the device may target. `path` is a
// canonical directory already authorized locally through Scry's directory
// picker; `label` is a display-only basename. The device can never authorize a
// new directory - it only chooses among these, and the workspace authorizer
// re-checks the cwd on submit regardless.
export interface RemoteProjectRef {
  path: string
  label: string
}

export interface RemoteProjectSource {
  // Snapshot of the currently host-authorized project directories. Called per
  // request so a directory removed locally stops being offered immediately.
  list(): RemoteProjectRef[]
}

// A Provider the device may target for a new session. `id` is the canonical
// ProviderId the run routing carries; `label` is display-only; `available`
// reflects whether the host currently has that Provider authenticated/usable.
// The device still cannot invent a provider - the run path validates it.
export interface RemoteProviderRef {
  id: string
  label: string
  available: boolean
}

export interface RemoteProviderSource {
  // Snapshot of the host's Providers. Called per request so a newly
  // authenticated (or disabled) Provider is reflected without a reconnect.
  list(): RemoteProviderRef[]
}

export interface RemoteOutputReader {
  // Chunks strictly after `cursor` for a run (bounded page) + the next cursor.
  since(runId: string, cursor: number): RunOutputPage
}

export interface RemoteGatewayDependencies {
  authority: DeviceAuthorizer
  ledger: SessionLedger
  // Absent => the device sees an empty (honest) authorized-project list.
  projects?: RemoteProjectSource
  // Absent => the device sees an empty (honest) provider list.
  providers?: RemoteProviderSource
  // Absent => the device sees an empty (honest) output page.
  output?: RemoteOutputReader
}

export interface SubmitIntentInput {
  intentId: string
  detail?: string
}
export interface SubmitIntentResult {
  runId: string
  status: 'recorded' | 'duplicate'
}

const HASH = /^[0-9a-f]{64}$/

export class RemoteGatewayError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'RemoteGatewayError'
    this.code = code
  }
}

// Bound the list so a pathological local project catalog can never turn a poll
// into an unbounded frame. The device UI only needs a chooser, not the world.
const MAX_PROJECTS = 200
const MAX_PATH = 4_096
const MAX_PROVIDERS = 32

export class RemoteGateway {
  #authority: DeviceAuthorizer
  #ledger: SessionLedger
  #projects?: RemoteProjectSource
  #providers?: RemoteProviderSource
  #output?: RemoteOutputReader

  constructor(deps: RemoteGatewayDependencies) {
    this.#authority = deps.authority
    this.#ledger = deps.ledger
    this.#projects = deps.projects
    this.#providers = deps.providers
    this.#output = deps.output
  }

  // Fail closed on anything that is not a currently-authorized owner device.
  #authorize(peerCertSHA256: string): void {
    if (typeof peerCertSHA256 !== 'string' || !HASH.test(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
    if (!this.#authority.authorizesCertificate(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
  }

  // Durably record a device's task submission. The runId is assigned by the
  // host, never by the device. Idempotent on intentId: a retry returns the same
  // runId and creates no second run.
  submitIntent(peerCertSHA256: string, input: SubmitIntentInput): SubmitIntentResult {
    this.#authorize(peerCertSHA256)
    const candidateRunId = SessionLedger.newRunId()
    const receipt = this.#ledger.recordIntent({ intentId: input.intentId, runId: candidateRunId, detail: input.detail })
    return { runId: receipt.event.runId, status: receipt.status }
  }

  // Read the durable event stream after the caller's cursor.
  poll(peerCertSHA256: string, input: { cursor: number }): ReturnType<SessionLedger['since']> {
    this.#authorize(peerCertSHA256)
    return this.#ledger.since(input.cursor)
  }

  runState(peerCertSHA256: string, input: { runId: string }): RunLifecycle | undefined {
    this.#authorize(peerCertSHA256)
    return this.#ledger.runState(input.runId)
  }

  // The host-authorized project directories a device may target. Authorization
  // is the SAME owner-device check as every other method (a revoked device gets
  // nothing), and the list is a display-only snapshot - selecting one still
  // passes through the workspace authorizer on submit, so this leaks no path the
  // device could not already discover by submitting.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    this.#authorize(peerCertSHA256)
    const raw = this.#projects?.list() ?? []
    const seen = new Set<string>()
    const out: RemoteProjectRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.label !== 'string') continue
      if (entry.path.length === 0 || entry.path.length > MAX_PATH) continue
      if (seen.has(entry.path)) continue
      seen.add(entry.path)
      out.push({ path: entry.path, label: entry.label.slice(0, 256) })
      if (out.length >= MAX_PROJECTS) break
    }
    return out
  }

  // The Providers this device may target for a new session, authorized by the
  // same owner-device check as every method. Display-only snapshot; the run path
  // still validates the chosen providerId, so this leaks nothing a submit could
  // not already discover. Deduped and bounded.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    this.#authorize(peerCertSHA256)
    const raw = this.#providers?.list() ?? []
    const seen = new Set<string>()
    const out: RemoteProviderRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') continue
      if (entry.id.length === 0 || entry.id.length > 64) continue
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push({ id: entry.id, label: entry.label.slice(0, 128), available: entry.available === true })
      if (out.length >= MAX_PROVIDERS) break
    }
    return out
  }

  // The assistant's real streamed output CONTENT for one run, strictly after the
  // caller's cursor. Authorized by the same verified owner-device check as poll;
  // an unknown/evicted run yields an honest empty page (never fabricated).
  pollOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): RunOutputPage {
    this.#authorize(peerCertSHA256)
    const cursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0 ? input.cursor : 0
    if (typeof input.runId !== 'string' || input.runId.length === 0 || input.runId.length > 128) return { chunks: [], cursor }
    return this.#output?.since(input.runId, cursor) ?? { chunks: [], cursor }
  }
}
