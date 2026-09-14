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

export interface RemoteDirectoryListing {
  current?: RemoteProjectRef
  parent?: RemoteProjectRef
  directories: RemoteProjectRef[]
}

export interface RemoteDirectorySource {
  // `path` is absent for the authorized-root list. A supplied path must resolve
  // inside one of those roots; authorization belongs to the host source because
  // only it owns the canonical filesystem grants.
  list(path?: string): RemoteDirectoryListing
}

// A Provider the device may target for a new session. `id` is the canonical
// ProviderId the run routing carries; `label` is display-only; `available`
// reflects whether the host currently has that Provider authenticated/usable.
// The device still cannot invent a provider - the run path validates it.
export interface RemoteControlOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
}

export interface RemoteProviderRef {
  id: string
  label: string
  available: boolean
  modelId?: string
  efforts?: RemoteControlOption[]
  permissions?: RemoteControlOption[]
}

export interface RemoteProviderSource {
  // Snapshot of the host's Providers. Called per request so a newly
  // authenticated (or disabled) Provider is reflected without a reconnect.
  list(): RemoteProviderRef[]
}

// A session in the host's catalog the device may browse. `externalSessionId` is
// the Provider's own resumable id (absent => still pending/unresumable). This is
// display metadata only; it exposes nothing the device could not learn by
// listing projects + submitting, and the host re-authorizes any later read.
export interface RemoteSessionRef {
  sessionId: string
  externalSessionId?: string
  providerId: string
  cwd: string
  label: string
  ts: number
  pinnedAt?: number
}

export interface RemoteSessionSource {
  // Snapshot of the host's session catalog (already filtered to device-visible
  // authorized projects host-side). Called per request so a new/removed session
  // is reflected immediately.
  list(): RemoteSessionRef[]
}

// One turn of a session's REAL conversation content, replayed for the device.
// `userText` is the owner/device prompt; `items` are the assistant's ordered
// content chunks (text/reasoning/tool/tool_result), the SAME shape a live run
// streams. This is trace-derived content, never fabricated.
export interface RemoteHistoryTurn {
  userText: string
  items: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }[]
}

export interface RemoteHistoryQuery {
  providerId: string
  cwd: string
  externalSessionId: string
}

export interface RemoteHistorySource {
  // Read one session's turns. The host re-authorizes the cwd and only serves
  // sessions in device-visible authorized projects; an unknown/unauthorized/
  // unreadable session yields an empty list (honest: no content, not an error).
  read(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
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
  // Absent => hierarchical browsing is unavailable (honest empty root list).
  directories?: RemoteDirectorySource
  // Absent => the device sees an empty (honest) provider list.
  providers?: RemoteProviderSource
  // Absent => the device sees an empty (honest) session catalog.
  sessions?: RemoteSessionSource
  // Absent => opening any session yields an empty (honest) transcript.
  history?: RemoteHistorySource
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
const MAX_SESSIONS = 300
const MAX_HISTORY_TURNS = 400
const MAX_HISTORY_ITEMS_PER_TURN = 500
const MAX_HISTORY_TEXT = 20_000

export class RemoteGateway {
  #authority: DeviceAuthorizer
  #ledger: SessionLedger
  #projects?: RemoteProjectSource
  #directories?: RemoteDirectorySource
  #providers?: RemoteProviderSource
  #sessions?: RemoteSessionSource
  #history?: RemoteHistorySource
  #output?: RemoteOutputReader

  constructor(deps: RemoteGatewayDependencies) {
    this.#authority = deps.authority
    this.#ledger = deps.ledger
    this.#projects = deps.projects
    this.#directories = deps.directories
    this.#providers = deps.providers
    this.#sessions = deps.sessions
    this.#history = deps.history
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

  private projectRefs(raw: RemoteProjectRef[]): RemoteProjectRef[] {
    const seen = new Set<string>()
    const out: RemoteProjectRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.label !== 'string') continue
      if (entry.path.length === 0 || entry.path.length > MAX_PATH || seen.has(entry.path)) continue
      seen.add(entry.path)
      out.push({ path: entry.path, label: entry.label.slice(0, 256) })
      if (out.length >= MAX_PROJECTS) break
    }
    return out
  }

  // The host-authorized project directories a device may target. Authorization
  // is the SAME owner-device check as every other method (a revoked device gets
  // nothing), and the list is a display-only snapshot - selecting one still
  // passes through the workspace authorizer on submit.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    this.#authorize(peerCertSHA256)
    return this.projectRefs(this.#projects?.list() ?? [])
  }

  // Browse immediate folders without widening the Mac's original project grant.
  // The host source canonicalizes and authorizes the requested path; this layer
  // authorizes the device and bounds every path returned over the wire.
  listDirectories(peerCertSHA256: string, input: { path?: string }): RemoteDirectoryListing {
    this.#authorize(peerCertSHA256)
    if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > MAX_PATH)) {
      throw new RemoteGatewayError('invalid_target')
    }
    const listing = this.#directories?.list(input.path) ?? { directories: [] }
    const current = listing.current ? this.projectRefs([listing.current])[0] : undefined
    const parent = listing.parent ? this.projectRefs([listing.parent])[0] : undefined
    return {
      ...(current ? { current } : {}),
      ...(parent ? { parent } : {}),
      directories: this.projectRefs(listing.directories)
    }
  }

  private controlOptions(value: unknown): RemoteControlOption[] {
    if (!Array.isArray(value)) return []
    const out: RemoteControlOption[] = []
    const seen = new Set<string>()
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue
      const option = raw as Record<string, unknown>
      if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 64 || seen.has(option.id)) continue
      if (typeof option.label !== 'string' || option.label.length === 0) continue
      seen.add(option.id)
      out.push({
        id: option.id,
        label: option.label.slice(0, 64),
        ...(typeof option.description === 'string' ? { description: option.description.slice(0, 256) } : {}),
        ...(option.isDefault === true ? { isDefault: true } : {})
      })
      if (out.length >= 16) break
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
      const efforts = this.controlOptions(entry.efforts)
      const permissions = this.controlOptions(entry.permissions)
      out.push({
        id: entry.id,
        label: entry.label.slice(0, 128),
        available: entry.available === true,
        ...(typeof entry.modelId === 'string' && entry.modelId.length > 0 && entry.modelId.length <= 128 ? { modelId: entry.modelId } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
        ...(permissions.length > 0 ? { permissions } : {})
      })
      if (out.length >= MAX_PROVIDERS) break
    }
    return out
  }

  // The host's session catalog this device may browse, authorized by the same
  // owner-device check as every method. Display-only metadata, deduped and
  // bounded; opening a session's content is a separate re-authorized read.
  listSessions(peerCertSHA256: string): RemoteSessionRef[] {
    this.#authorize(peerCertSHA256)
    const raw = this.#sessions?.list() ?? []
    const seen = new Set<string>()
    const out: RemoteSessionRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.sessionId !== 'string' || typeof entry.providerId !== 'string') continue
      if (entry.sessionId.length === 0 || entry.sessionId.length > 128) continue
      if (seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      out.push({
        sessionId: entry.sessionId,
        ...(typeof entry.externalSessionId === 'string' && entry.externalSessionId.length > 0 ? { externalSessionId: entry.externalSessionId } : {}),
        providerId: entry.providerId.slice(0, 64),
        cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, MAX_PATH) : '',
        label: typeof entry.label === 'string' ? entry.label.slice(0, 256) : '',
        ts: Number.isFinite(entry.ts) ? entry.ts : 0,
        ...(typeof entry.pinnedAt === 'number' && Number.isFinite(entry.pinnedAt) && entry.pinnedAt > 0 ? { pinnedAt: entry.pinnedAt } : {})
      })
      if (out.length >= MAX_SESSIONS) break
    }
    return out
  }

  // The REAL conversation content of one session so the device can OPEN it,
  // authorized by the same owner-device check as every method. Bounded (turns,
  // items/turn, text length); an unknown/unauthorized/unreadable session returns
  // an empty list (honest: no content, never a fake transcript).
  async readHistory(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
    this.#authorize(peerCertSHA256)
    if (!query || typeof query.providerId !== 'string' || typeof query.externalSessionId !== 'string') return []
    const raw = (await this.#history?.read({
      providerId: query.providerId.slice(0, 64),
      cwd: typeof query.cwd === 'string' ? query.cwd.slice(0, MAX_PATH) : '',
      externalSessionId: query.externalSessionId.slice(0, 128)
    })) ?? []
    const out: RemoteHistoryTurn[] = []
    for (const turn of raw.slice(0, MAX_HISTORY_TURNS)) {
      if (!turn) continue
      const items: RemoteHistoryTurn['items'] = []
      for (const item of (turn.items ?? []).slice(0, MAX_HISTORY_ITEMS_PER_TURN)) {
        if (!item || typeof item.text !== 'string') continue
        if (item.kind !== 'output' && item.kind !== 'reasoning' && item.kind !== 'tool' && item.kind !== 'tool_result') continue
        items.push({ kind: item.kind, text: item.text.slice(0, MAX_HISTORY_TEXT) })
      }
      out.push({ userText: (typeof turn.userText === 'string' ? turn.userText : '').slice(0, MAX_HISTORY_TEXT), items })
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
