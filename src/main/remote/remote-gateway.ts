import { SessionLedger, type RunLifecycle } from './session-ledger'
import { createHash } from 'node:crypto'
import { isRemoteProviderObservationTime } from '../../shared/desktop-remote'
import type { RunOutputPage } from './run-output-log'
import { parseRemoteWorkspaceQuery, type RemoteWorkspaceQuery, type RemoteWorkspaceResult } from './remote-workspace'
import type { RemoteProjectRef, RemoteControlOption, RemoteModelOption, RemoteProviderRef, RemoteProviderQuery, RemoteSessionRef, RemoteCommandCatalog, RemoteCommandRef } from '../../shared/desktop-remote'
export type { RemoteProjectRef, RemoteControlOption, RemoteModelOption, RemoteProviderRef, RemoteProviderQuery, RemoteSessionRef, RemoteCommandCatalog, RemoteCommandRef } from '../../shared/desktop-remote'

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
// canonical directory granted through the local or explicit authenticated
// desktop picker; `label` is a display-only basename. Reading this catalog or
// the project-scoped browser never creates a grant. The workspace authorizer
// re-checks the cwd on submit regardless.
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

export interface RemoteDirectoryPageQuery {
  path?: string
  cursor?: number
  limit?: number
  snapshot?: string
}

export interface RemoteDirectoryPage extends RemoteDirectoryListing {
  cursor: number
  total: number
  hasMore: boolean
  snapshot: string
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
export interface RemoteProviderSource {
  // Metadata is cheap and never probes Provider controls.
  list?(): RemoteProviderRef[]
  // Explicit legacy requests may still ask for the old all-controls response.
  listFull?(): Promise<RemoteProviderRef[]>
  // A selected context is the only new path that may read Provider controls.
  selected?(query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef>
}

export interface RemoteCommandQuery {
  providerId: string
  cwd: string
  agentProfileId?: string
}

export interface RemoteCommandSource {
  // Commands are Provider- and cwd-specific (skills/custom commands included),
  // so resolve them on demand instead of shipping a misleading static list.
  list(query: RemoteCommandQuery): Promise<RemoteCommandCatalog>
}

// A session in the host's catalog the device may browse. `externalSessionId` is
// the Provider's own resumable id (absent => still pending/unresumable). This is
// display metadata only; it exposes nothing the device could not learn by
// listing projects + submitting, and the host re-authorizes any later read.
export interface RemoteSessionSource {
  // Snapshot of the host's session catalog (already filtered to device-visible
  // authorized projects host-side). Called per request so a new/removed session
  // is reflected immediately.
  list(): RemoteSessionRef[]
  // Cheap source revision for retaining a frozen page walk. Without it, use
  // the compatibility path and rebuild on each page to preserve invalidation.
  revision?(): string
}

export interface RemoteSessionPageQuery {
  includeArchived?: boolean
  cursor?: number
  limit?: number
  snapshot?: string
}

export interface RemoteSessionPage {
  sessions: RemoteSessionRef[]
  cursor: number
  total: number
  hasMore: boolean
  snapshot: string
}

// One turn of a session's REAL conversation content, replayed for the device.
// `userText` is the owner/device prompt; `items` are the assistant's ordered
// content chunks (text/reasoning/tool/tool_result), the SAME shape a live run
// streams. This is trace-derived content, never fabricated.
export interface RemoteHistoryTurn {
  // Scry run id, only on structured turn pages (see history-reader pageTurn).
  runId?: string
  userText: string
  items: { kind: 'output' | 'reasoning' | 'tool' | 'tool_result'; text: string }[]
}

export interface RemoteHistoryQuery {
  providerId: string
  cwd: string
  externalSessionId: string
}

export interface RemoteHistoryPreviewItem {
  kind: 'output' | 'reasoning' | 'tool' | 'tool_result'
  text: string
  truncated: boolean
}

export interface RemoteHistoryPreviewTurn {
  userText: string
  userTextTruncated: boolean
  items: RemoteHistoryPreviewItem[]
  truncated: boolean
}

export type RemoteHistoryPreview =
  | { status: 'available'; source: 'active_memory' | 'indexed_archive' | 'index_rebuild' | 'monolithic'; turns: RemoteHistoryPreviewTurn[]; partial: true; truncated: boolean; bytes: number }
  | { status: 'unavailable'; reason: 'no_fast_evidence' | 'session_not_found' | 'provider_unsupported' }

export interface RemoteHistoryPreviewSource {
  read(query: RemoteHistoryQuery): Promise<RemoteHistoryPreview>
}

export interface RemoteHistoryVersion {
  version: string
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
}

export interface RemoteHistoryVersionSource {
  read(query: RemoteHistoryQuery): Promise<RemoteHistoryVersion>
}

export interface RemoteHistoryPageQuery extends RemoteHistoryQuery {
  cursor?: number
  limit?: number
  snapshot?: string
}

export interface RemoteHistoryPage {
  dataBase64: string
  cursor: number
  totalBytes: number
  hasMore: boolean
  snapshot: string
}

export interface RemoteHistoryTurnsPageQuery extends RemoteHistoryQuery {
  before?: number
  limit?: number
  snapshot?: string
}

export interface RemoteHistoryTurnsPage {
  turns: RemoteHistoryTurn[]
  offset: number
  totalTurns: number
  hasOlder: boolean
  snapshot: string
  source: 'active_memory' | 'indexed_archive' | 'index_rebuild' | 'monolithic' | 'claude_transcript'
  completeness: 'partial' | 'complete'
}

export interface RemoteHistoryTurnsPageSource {
  read(query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage>
}

export interface RemoteHistorySource {
  // Read one session's turns. The host re-authorizes the cwd and only serves
  // sessions in device-visible authorized projects; an unknown/unauthorized/
  // unreadable session yields an empty list (honest: no content, not an error).
  read(query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]>
}

export interface RemoteOutputReader {
  // Chunks strictly after `cursor` for a run (bounded page) + the next cursor.
  since(runId: string, cursor: number): RunOutputPage | Promise<RunOutputPage>
}

export interface RemoteGatewayDependencies {
  authority: DeviceAuthorizer
  ledger: SessionLedger
  workspace?: { read(query: RemoteWorkspaceQuery): Promise<RemoteWorkspaceResult> }
  // Absent => the device sees an empty (honest) authorized-project list.
  projects?: RemoteProjectSource
  // Absent => hierarchical browsing is unavailable (honest empty root list).
  directories?: RemoteDirectorySource
  // Absent => the device sees an empty (honest) provider list.
  providers?: RemoteProviderSource
  // Absent => slash completion is honestly unavailable.
  commands?: RemoteCommandSource
  // Absent => the device sees an empty (honest) session catalog.
  sessions?: RemoteSessionSource
  // Absent => opening any session yields an empty (honest) transcript.
  history?: RemoteHistorySource
  // Absent => a first-screen preview is explicitly unavailable; it is not an empty transcript.
  historyPreview?: RemoteHistoryPreviewSource
  historyVersion?: RemoteHistoryVersionSource
  historyTurnsPage?: RemoteHistoryTurnsPageSource
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

function scopedIntentId(peerCertSHA256: string, intentId: string): string {
  const hex = createHash('sha256').update(`${peerCertSHA256}\0${intentId}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

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
const MAX_COMMANDS = 256
const MAX_SESSIONS = 300
const MAX_CATALOG_PAGE = 100
const MAX_CATALOG_ITEMS = 100_000
const MAX_HISTORY_TURNS = 400
const MAX_HISTORY_ITEMS_PER_TURN = 500
const MAX_HISTORY_TEXT = 20_000
// The Swift transport rejects frames above 8 MiB. Reserve 2 MiB for the wire
// response envelope and JSON framing so every accepted history result remains
// deliverable instead of repeatedly failing as one oversized all-or-nothing page.
const MAX_HISTORY_RESPONSE_BYTES = 6 * 1024 * 1024
const MAX_HISTORY_PAGE_BYTES = 256 * 1024
const MAX_HISTORY_SNAPSHOT_BYTES = 256 * 1024 * 1024
const MAX_HISTORY_PREVIEW_BYTES = 16 * 1024
const MAX_HISTORY_PREVIEW_TURNS = 2
const MAX_HISTORY_PREVIEW_ITEMS = 2
const MAX_HISTORY_PREVIEW_TEXT_BYTES = 1_024

function clipPreviewText(value: string, maxBytes = MAX_HISTORY_PREVIEW_TEXT_BYTES): { text: string; truncated: boolean } {
  let text = ''
  let bytes = 0
  // Budget the encoded string, not raw UTF-8: control characters can expand
  // sixfold in JSON. Iterate lazily so a giant source is never copied first.
  for (const char of value) {
    const charBytes = Buffer.byteLength(JSON.stringify(char), 'utf8') - 2
    if (bytes + charBytes > maxBytes) return { text, truncated: true }
    text += char
    bytes += charBytes
  }
  return { text, truncated: false }
}

export class RemoteGateway {
  #authority: DeviceAuthorizer
  #ledger: SessionLedger
  #projects?: RemoteProjectSource
  #directories?: RemoteDirectorySource
  #providers?: RemoteProviderSource
  #commands?: RemoteCommandSource
  #sessions?: RemoteSessionSource
  #history?: RemoteHistorySource
  #historyPreview?: RemoteHistoryPreviewSource
  #historyVersion?: RemoteHistoryVersionSource
  #historyTurnsPage?: RemoteHistoryTurnsPageSource
  #output?: RemoteOutputReader
  #workspace?: RemoteGatewayDependencies['workspace']
  #historySnapshots = new Map<string, { bytes: Buffer; expiresAt: number }>()
  #historyBuilds = new Map<string, Promise<{ bytes: Buffer; snapshot: string }>>()
  // A catalog page is a frozen view. Keep the materialized source only for the
  // short lifetime of a page walk; authorization is still checked on every
  // request, so revocation never relies on this cache.
  #sessionCatalogs = new Map<string, { sessions: RemoteSessionRef[]; snapshot: string; revision: string; expiresAt: number }>()

  constructor(deps: RemoteGatewayDependencies) {
    this.#authority = deps.authority
    this.#ledger = deps.ledger
    this.#projects = deps.projects
    this.#directories = deps.directories
    this.#providers = deps.providers
    this.#commands = deps.commands
    this.#sessions = deps.sessions
    this.#history = deps.history
    this.#historyPreview = deps.historyPreview
    this.#historyVersion = deps.historyVersion
    this.#historyTurnsPage = deps.historyTurnsPage
    this.#output = deps.output
    this.#workspace = deps.workspace
  }

  // Fail closed on anything that is not a currently-authorized owner device.
  #authorize(peerCertSHA256: string): void {
    if (typeof peerCertSHA256 !== 'string' || !HASH.test(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
    if (!this.#authority.authorizesCertificate(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
  }

  async readWorkspace(peerCertSHA256: string, query: unknown): Promise<RemoteWorkspaceResult> {
    this.#authorize(peerCertSHA256)
    const parsed = parseRemoteWorkspaceQuery(query)
    if (!this.#workspace) throw new RemoteGatewayError('workspace_unavailable')
    return this.#workspace.read(parsed)
  }

  // Durably record a device's task submission. The runId is assigned by the
  // host, never by the device. Idempotent on the authenticated device plus its
  // intentId: a retry returns the same runId without aliasing another device.
  submitIntent(peerCertSHA256: string, input: SubmitIntentInput): SubmitIntentResult {
    this.#authorize(peerCertSHA256)
    const candidateRunId = SessionLedger.newRunId()
    const receipt = this.#ledger.recordIntent({
      intentId: scopedIntentId(peerCertSHA256, input.intentId),
      runId: candidateRunId,
      detail: input.detail
    })
    return { runId: receipt.event.runId, status: receipt.status }
  }

  // Reconcile a submit whose receipt was lost. Scoped like submitIntent, so a
  // device can only learn about its own intent ids.
  intentStatus(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    this.#authorize(peerCertSHA256)
    if (typeof input?.intentId !== 'string') throw new RemoteGatewayError('invalid_intent_id')
    const found = this.#ledger.intentRun(scopedIntentId(peerCertSHA256, input.intentId))
    if (!found) throw new RemoteGatewayError('unknown_intent')
    return { runId: found.runId, state: found.lifecycle }
  }

  // Read the durable event stream after the caller's cursor. The intent body
  // (prompt + base64 attachments, up to ~1 MB) is the host's dispatch input,
  // not device evidence: every watch would otherwise download it again.
  poll(peerCertSHA256: string, input: { cursor: number }): ReturnType<SessionLedger['since']> {
    this.#authorize(peerCertSHA256)
    const page = this.#ledger.since(input.cursor)
    return {
      ...page,
      events: page.events.map((event) => {
        if (event.kind !== 'intent_recorded' || event.detail === undefined) return event
        const { detail: _detail, ...rest } = event
        return rest
      })
    }
  }

  runState(peerCertSHA256: string, input: { runId: string }): RunLifecycle | undefined {
    this.#authorize(peerCertSHA256)
    return this.#ledger.runState(input.runId)
  }

  private projectRefs(raw: RemoteProjectRef[], limit = MAX_PROJECTS): RemoteProjectRef[] {
    const seen = new Set<string>()
    const out: RemoteProjectRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.path !== 'string' || typeof entry.label !== 'string') continue
      if (entry.path.length === 0 || entry.path.length > MAX_PATH || seen.has(entry.path)) continue
      seen.add(entry.path)
      out.push({ path: entry.path, label: entry.label.slice(0, 256) })
      if (out.length >= limit) break
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

  listDirectoriesPage(peerCertSHA256: string, input: RemoteDirectoryPageQuery): RemoteDirectoryPage {
    this.#authorize(peerCertSHA256)
    const cursor = input?.cursor ?? 0
    const limit = input?.limit ?? MAX_CATALOG_PAGE
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_directory_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE) throw new RemoteGatewayError('invalid_directory_limit')
    if (input.path !== undefined && (typeof input.path !== 'string' || input.path.length === 0 || input.path.length > MAX_PATH)) {
      throw new RemoteGatewayError('invalid_target')
    }
    const raw = this.#directories?.list(input.path) ?? { directories: [] }
    const current = raw.current ? this.projectRefs([raw.current])[0] : undefined
    const parent = raw.parent ? this.projectRefs([raw.parent])[0] : undefined
    const directories = this.projectRefs(raw.directories, MAX_CATALOG_ITEMS + 1)
    if (directories.length > MAX_CATALOG_ITEMS) throw new RemoteGatewayError('directory_capacity_exceeded')
    const snapshot = createHash('sha256').update(JSON.stringify({ current, parent, directories })).digest('hex')
    if (input.snapshot !== undefined && input.snapshot !== snapshot) throw new RemoteGatewayError('directory_snapshot_changed')
    if (cursor > directories.length) throw new RemoteGatewayError('invalid_directory_cursor')
    const end = Math.min(directories.length, cursor + limit)
    return {
      ...(current ? { current } : {}),
      ...(parent ? { parent } : {}),
      directories: directories.slice(cursor, end),
      cursor: end,
      total: directories.length,
      hasMore: end < directories.length,
      snapshot
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

  private modelOptions(value: unknown): RemoteModelOption[] {
    if (!Array.isArray(value)) return []
    const out: RemoteModelOption[] = []
    const seen = new Set<string>()
    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue
      const option = raw as Record<string, unknown>
      if (typeof option.id !== 'string' || option.id.length === 0 || option.id.length > 128) continue
      if (typeof option.label !== 'string' || option.label.length === 0) continue
      const providerId = typeof option.providerId === 'string' && option.providerId.length > 0 && option.providerId.length <= 128
        ? option.providerId : undefined
      const modelKey = `${providerId ?? ''}\0${option.id}`
      if (seen.has(modelKey)) continue
      seen.add(modelKey)
      const efforts = this.controlOptions(option.efforts)
      out.push({
        id: option.id,
        ...(providerId ? { providerId } : {}),
        label: option.label.slice(0, 128),
        ...(typeof option.description === 'string' ? { description: option.description.slice(0, 256) } : {}),
        ...(option.isDefault === true ? { isDefault: true } : {}),
        ...(efforts.length > 0 ? { efforts } : {})
      })
      if (out.length >= 128) break
    }
    return out
  }

  // One entry is one selectable Provider context. Pi profiles deliberately
  // share the canonical Provider id but carry distinct agentProfileId values.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    this.#authorize(peerCertSHA256)
    const raw = this.#providers?.list?.() ?? []
    const seen = new Set<string>()
    const out: RemoteProviderRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') continue
      if (entry.id.length === 0 || entry.id.length > 64) continue
      const agentProfileId = typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128
        ? entry.agentProfileId : undefined
      const contextKey = `${entry.id}\0${agentProfileId ?? ''}`
      if (seen.has(contextKey)) continue
      seen.add(contextKey)
      out.push({
        id: entry.id,
        label: entry.label.slice(0, 128),
        available: entry.available === true,
        ...(agentProfileId ? { agentProfileId } : {})
      })
      if (out.length >= MAX_PROVIDERS) break
    }
    return out
  }

  async listProviderControls(peerCertSHA256: string, query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef> {
    this.#authorize(peerCertSHA256)
    if (!query || query.detail !== 'selected' || typeof query.providerId !== 'string' || query.providerId.length === 0 || query.providerId.length > 64 ||
        typeof query.cwd !== 'string' || query.cwd.length === 0 || query.cwd.length > MAX_PATH ||
        (query.agentProfileId !== undefined && (typeof query.agentProfileId !== 'string' || query.agentProfileId.length === 0 || query.agentProfileId.length > 128))) {
      throw new RemoteGatewayError('invalid_provider_context')
    }
    if (!this.#providers?.selected) throw new RemoteGatewayError('provider_controls_unavailable')
    const listed = this.#providers.list?.() ?? []
    const selected = listed.find((entry) => entry.id === query.providerId && (entry.agentProfileId ?? '') === (query.agentProfileId ?? ''))
    if (!selected || selected.available !== true) throw new RemoteGatewayError('provider_not_authorized')
    return this.#providerRef(await this.#providers.selected(query))
  }

  async listProvidersFull(peerCertSHA256: string): Promise<RemoteProviderRef[]> {
    this.#authorize(peerCertSHA256)
    const raw = this.#providers?.listFull ? await this.#providers.listFull() : this.#providers?.list?.() ?? []
    return this.providerRefs(raw)
  }

  private providerRefs(raw: RemoteProviderRef[]): RemoteProviderRef[] {
    const seen = new Set<string>()
    const out: RemoteProviderRef[] = []
    for (const entry of raw) {
      const ref = this.#providerRef(entry)
      const contextKey = `${ref.id}\0${ref.agentProfileId ?? ''}`
      if (seen.has(contextKey)) continue
      seen.add(contextKey)
      out.push(ref)
      if (out.length >= MAX_PROVIDERS) break
    }
    return out
  }

  #providerRef(entry: RemoteProviderRef): RemoteProviderRef {
    if (!entry || typeof entry.id !== 'string' || typeof entry.label !== 'string') throw new RemoteGatewayError('invalid_provider_response')
    if (entry.id.length === 0 || entry.id.length > 64) throw new RemoteGatewayError('invalid_provider_response')
    const agentProfileId = typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128 ? entry.agentProfileId : undefined
    const models = this.modelOptions(entry.models)
    const efforts = this.controlOptions(entry.efforts)
    const permissions = this.controlOptions(entry.permissions)
    return {
      id: entry.id,
      label: entry.label.slice(0, 128),
      available: entry.available === true,
      ...(agentProfileId ? { agentProfileId } : {}),
      ...(typeof entry.modelId === 'string' && entry.modelId.length > 0 && entry.modelId.length <= 128 ? { modelId: entry.modelId } : {}),
      ...(models.length > 0 ? { models } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(permissions.length > 0 ? { permissions } : {}),
      ...(isRemoteProviderObservationTime(entry.observedAt) ? { observedAt: entry.observedAt } : {}),
      ...(typeof entry.metadataRevision === 'number' && Number.isSafeInteger(entry.metadataRevision) && entry.metadataRevision >= 0 ? { metadataRevision: entry.metadataRevision } : {})
    }
  }

  async listCommands(peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
    this.#authorize(peerCertSHA256)
    if (!query || typeof query.providerId !== 'string' || query.providerId.length === 0 || query.providerId.length > 64 ||
        typeof query.cwd !== 'string' || query.cwd.length === 0 || query.cwd.length > MAX_PATH) {
      return { commands: [], reason: 'invalid_context' }
    }
    if (!this.#commands) return { commands: [], reason: 'unsupported' }
    const raw = await this.#commands.list({
      providerId: query.providerId,
      cwd: query.cwd,
      ...(typeof query.agentProfileId === 'string' && query.agentProfileId.length <= 128 ? { agentProfileId: query.agentProfileId } : {})
    })
    const seen = new Set<string>()
    const commands: RemoteCommandRef[] = []
    for (const entry of raw.commands ?? []) {
      const name = typeof entry?.name === 'string' ? entry.name.replace(/^\/+/, '').trim() : ''
      if (!name || name.length > 128 || /\s/.test(name) || seen.has(name)) continue
      seen.add(name)
      commands.push({
        name,
        description: typeof entry.description === 'string' ? entry.description.slice(0, 512) : '',
        ...(typeof entry.argumentHint === 'string' && entry.argumentHint.length > 0 ? { argumentHint: entry.argumentHint.slice(0, 256) } : {}),
        ...(['builtin', 'skill', 'mcp', 'custom'].includes(String(entry.source)) ? { source: entry.source } : {})
      })
      if (commands.length >= MAX_COMMANDS) break
    }
    return { commands, ...(typeof raw.reason === 'string' && raw.reason.length > 0 ? { reason: raw.reason.slice(0, 512) } : {}) }
  }

  private sessionRefs(raw: RemoteSessionRef[], limit = MAX_SESSIONS): RemoteSessionRef[] {
    const seen = new Set<string>()
    const out: RemoteSessionRef[] = []
    for (const entry of raw) {
      if (!entry || typeof entry.sessionId !== 'string' || typeof entry.providerId !== 'string') continue
      if (entry.sessionId.length === 0 || entry.sessionId.length > 128 || seen.has(entry.sessionId)) continue
      seen.add(entry.sessionId)
      out.push({
        sessionId: entry.sessionId,
        ...(typeof entry.externalSessionId === 'string' && entry.externalSessionId.length > 0 ? { externalSessionId: entry.externalSessionId } : {}),
        providerId: entry.providerId.slice(0, 64),
        ...(typeof entry.agentProfileId === 'string' && entry.agentProfileId.length > 0 && entry.agentProfileId.length <= 128 ? { agentProfileId: entry.agentProfileId } : {}),
        cwd: typeof entry.cwd === 'string' ? entry.cwd.slice(0, MAX_PATH) : '',
        label: typeof entry.label === 'string' ? entry.label.slice(0, 256) : '',
        ts: Number.isFinite(entry.ts) ? entry.ts : 0,
        ...(typeof entry.pinnedAt === 'number' && Number.isFinite(entry.pinnedAt) && entry.pinnedAt > 0 ? { pinnedAt: entry.pinnedAt } : {}),
        ...(typeof entry.archivedAt === 'number' && Number.isFinite(entry.archivedAt) && entry.archivedAt > 0 ? { archivedAt: entry.archivedAt } : {}),
        ...(entry.isActive === true ? { isActive: true } : {})
      })
      if (out.length >= limit) break
    }
    return out
  }

  // Compatibility endpoint for older clients. New clients drain listSessionsPage.
  listSessions(peerCertSHA256: string): RemoteSessionRef[] {
    this.#authorize(peerCertSHA256)
    return this.sessionRefs((this.#sessions?.list() ?? []).filter(session => !session.archivedAt))
  }

  listSessionsPage(peerCertSHA256: string, input: RemoteSessionPageQuery): RemoteSessionPage {
    this.#authorize(peerCertSHA256)
    const cursor = input?.cursor ?? 0
    const limit = input?.limit ?? MAX_CATALOG_PAGE
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_session_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE) throw new RemoteGatewayError('invalid_session_limit')
    if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw new RemoteGatewayError('invalid_session_query')
    const key = `${peerCertSHA256}:${input.includeArchived === true}`
    const now = Date.now()
    if (!this.#sessions?.revision) this.#sessionCatalogs.delete(key)
    const revision = this.#sessions?.revision?.() ?? ''
    const fresh = cursor === 0 && input.snapshot === undefined
    let cached = this.#sessionCatalogs.get(key)
    if (fresh || !cached || cached.expiresAt <= now || cached.revision !== revision) {
      const sessions = this.sessionRefs((this.#sessions?.list() ?? []).filter(session => input.includeArchived || !session.archivedAt), MAX_CATALOG_ITEMS + 1)
      if (sessions.length > MAX_CATALOG_ITEMS) throw new RemoteGatewayError('session_capacity_exceeded')
      const snapshot = createHash('sha256').update(JSON.stringify(sessions)).digest('hex')
      cached = { sessions, snapshot, revision, expiresAt: now + 30_000 }
      this.#sessionCatalogs.set(key, cached)
    }
    if (input.snapshot !== undefined && input.snapshot !== cached.snapshot) throw new RemoteGatewayError('session_snapshot_changed')
    if (input.snapshot !== undefined) cached.expiresAt = now + 30_000
    if (cursor > cached.sessions.length) throw new RemoteGatewayError('invalid_session_cursor')
    const end = Math.min(cached.sessions.length, cursor + limit)
    return {
      sessions: cached.sessions.slice(cursor, end),
      cursor: end,
      total: cached.sessions.length,
      hasMore: end < cached.sessions.length,
      snapshot: cached.snapshot
    }
  }

  // Small structured first-screen evidence. This deliberately does not call the
  // complete history source: a slow/unsupported provider remains unavailable.
  async readHistoryPreview(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryPreview> {
    this.#authorize(peerCertSHA256)
    if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
      throw new RemoteGatewayError('invalid_history_preview_query')
    }
    const raw = (await this.#historyPreview?.read({
      providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH), externalSessionId: query.externalSessionId.slice(0, 128)
    })) ?? { status: 'unavailable' as const, reason: 'no_fast_evidence' as const }
    if (raw.status === 'unavailable') return raw
    const turns: RemoteHistoryPreviewTurn[] = []
    let truncated = raw.truncated || raw.turns.length > MAX_HISTORY_PREVIEW_TURNS
    for (const turn of raw.turns.slice(-MAX_HISTORY_PREVIEW_TURNS)) {
      const prompt = clipPreviewText(typeof turn.userText === 'string' ? turn.userText : '')
      const items: RemoteHistoryPreviewItem[] = []
      let turnTruncated = Boolean(turn.truncated || turn.userTextTruncated || prompt.truncated || turn.items.length > MAX_HISTORY_PREVIEW_ITEMS)
      for (const item of (turn.items ?? []).slice(-MAX_HISTORY_PREVIEW_ITEMS)) {
        if (!item || !['output', 'reasoning', 'tool', 'tool_result'].includes(item.kind) || typeof item.text !== 'string') continue
        const clipped = clipPreviewText(item.text)
        items.push({ kind: item.kind, text: clipped.text, truncated: Boolean(item.truncated || clipped.truncated) })
        turnTruncated ||= items[items.length - 1].truncated
      }
      turns.push({ userText: prompt.text, userTextTruncated: Boolean(turn.userTextTruncated || prompt.truncated), items, truncated: turnTruncated })
      truncated ||= turnTruncated
    }
    const result: RemoteHistoryPreview = { status: 'available', source: raw.source, turns, partial: true, truncated, bytes: 0 }
    // Six individually JSON-bounded strings plus framing fit within 16 KiB.
    // Count the bytes field itself; dropping a whole turn would fabricate empty
    // evidence for a genuine oversized response.
    let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    while (result.bytes !== bytes) {
      result.bytes = bytes
      bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    }
    if (bytes > MAX_HISTORY_PREVIEW_BYTES) throw new RemoteGatewayError('history_preview_capacity_exceeded')
    return result
  }

  async readHistoryVersion(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryVersion> {
    this.#authorize(peerCertSHA256)
    if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
      throw new RemoteGatewayError('invalid_history_version_query')
    }
    if (!this.#historyVersion) throw new RemoteGatewayError('history_unavailable')
    return this.#historyVersion.read({
      providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH), externalSessionId: query.externalSessionId.slice(0, 128)
    })
  }

  async readHistoryTurnsPage(peerCertSHA256: string, query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage> {
    this.#authorize(peerCertSHA256)
    if (!query || typeof query.providerId !== 'string' || typeof query.cwd !== 'string' || typeof query.externalSessionId !== 'string') {
      throw new RemoteGatewayError('invalid_history_turns_query')
    }
    const before = query.before
    const limit = query.limit ?? 3
    if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new RemoteGatewayError('invalid_history_turns_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RemoteGatewayError('invalid_history_turns_limit')
    if (!this.#historyTurnsPage) throw new RemoteGatewayError('history_unavailable')
    let result = await this.#historyTurnsPage.read({
      providerId: query.providerId.slice(0, 64), cwd: query.cwd.slice(0, MAX_PATH),
      externalSessionId: query.externalSessionId.slice(0, 128), before, limit, snapshot: query.snapshot
    })
    if (!Array.isArray(result.turns) || !Number.isSafeInteger(result.offset) || !Number.isSafeInteger(result.totalTurns) ||
        result.offset < 0 || result.totalTurns < 0 || result.turns.length > limit ||
        result.offset + result.turns.length !== (before ?? result.totalTurns) ||
        (before !== undefined && before > result.totalTurns)) {
      throw new RemoteGatewayError('invalid_history_turns_reply')
    }
    if (query.snapshot !== undefined && result.snapshot !== query.snapshot) throw new RemoteGatewayError('history_snapshot_changed')
    if (result.hasOlder !== (result.offset > 0) ||
        !['partial', 'complete'].includes(result.completeness) ||
        (result.completeness === 'complete' && (result.hasOlder || before !== undefined && before < result.totalTurns || result.source === 'active_memory'))) {
      throw new RemoteGatewayError('invalid_history_turns_reply')
    }
    // limit is an upper bound. Reduce only whole older turns, never text or
    // tool evidence; the shifted cursor keeps every omitted turn retrievable.
    while (result.turns.length > 1 && Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) {
      result = { ...result, turns: result.turns.slice(1), offset: result.offset + 1, hasOlder: true, completeness: 'partial' }
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_HISTORY_RESPONSE_BYTES) throw new RemoteGatewayError('history_capacity_exceeded')
    return result
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
    // Track the exact JSON byte contribution while preserving chronological
    // order. The UI already labels history as possibly incomplete; returning a
    // bounded prefix is truthful and usable, unlike a frame the device rejects.
    let responseBytes = 2 // []
    let budgetReached = false
    for (const turn of raw.slice(0, MAX_HISTORY_TURNS)) {
      if (budgetReached) break
      if (!turn) continue
      const clean: RemoteHistoryTurn = {
        userText: (typeof turn.userText === 'string' ? turn.userText : '').slice(0, MAX_HISTORY_TEXT),
        items: []
      }
      const turnBaseBytes = Buffer.byteLength(JSON.stringify(clean), 'utf8')
      const turnSeparator = out.length > 0 ? 1 : 0
      if (responseBytes + turnSeparator + turnBaseBytes > MAX_HISTORY_RESPONSE_BYTES) break
      responseBytes += turnSeparator + turnBaseBytes
      out.push(clean)
      for (const item of (turn.items ?? []).slice(0, MAX_HISTORY_ITEMS_PER_TURN)) {
        if (!item || typeof item.text !== 'string') continue
        if (item.kind !== 'output' && item.kind !== 'reasoning' && item.kind !== 'tool' && item.kind !== 'tool_result') continue
        const normalized = { kind: item.kind, text: item.text.slice(0, MAX_HISTORY_TEXT) }
        const itemBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8') + (clean.items.length > 0 ? 1 : 0)
        if (responseBytes + itemBytes > MAX_HISTORY_RESPONSE_BYTES) {
          budgetReached = true
          break
        }
        clean.items.push(normalized)
        responseBytes += itemBytes
      }
    }
    return out
  }

  // Complete history bytes with a stable snapshot fence. Unlike the legacy
  // compatibility endpoint, this never truncates turns/items/text to fit a frame.
  async readHistoryPage(peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
    this.#authorize(peerCertSHA256)
    const cursor = query?.cursor ?? 0
    const limit = query?.limit ?? 64 * 1024
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_history_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_BYTES) throw new RemoteGatewayError('invalid_history_limit')
    if (!query || typeof query.providerId !== 'string' || typeof query.externalSessionId !== 'string') {
      throw new RemoteGatewayError('invalid_history_query')
    }
    const providerId = query.providerId.slice(0, 64)
    const cwd = typeof query.cwd === 'string' ? query.cwd.slice(0, MAX_PATH) : ''
    const externalSessionId = query.externalSessionId.slice(0, 128)
    const scope = `${providerId}\0${cwd}\0${externalSessionId}`
    const now = Date.now()
    for (const [key, value] of this.#historySnapshots) {
      if (value.expiresAt <= now) this.#historySnapshots.delete(key)
    }
    let bytes: Buffer
    let snapshot: string
    const cacheKey = query.snapshot ? `${scope}\0${query.snapshot}` : undefined
    const cached = cacheKey ? this.#historySnapshots.get(cacheKey) : undefined
    if (cached && cached.expiresAt > now) {
      bytes = cached.bytes
      snapshot = query.snapshot!
      cached.expiresAt = now + 30_000
      this.#historySnapshots.delete(cacheKey!)
      this.#historySnapshots.set(cacheKey!, cached)
    } else {
      let build = this.#historyBuilds.get(scope)
      if (!build) {
        build = this.#buildHistory({ providerId, cwd, externalSessionId })
        this.#historyBuilds.set(scope, build)
      }
      try { ({ bytes, snapshot } = await build) }
      finally { if (this.#historyBuilds.get(scope) === build) this.#historyBuilds.delete(scope) }
      if (query.snapshot !== undefined && query.snapshot !== snapshot) throw new RemoteGatewayError('history_snapshot_changed')
      this.#historySnapshots.set(`${scope}\0${snapshot}`, { bytes, expiresAt: Date.now() + 30_000 })
      let total = [...this.#historySnapshots.values()].reduce((sum, value) => sum + value.bytes.length, 0)
      while (this.#historySnapshots.size > 4 || total > MAX_HISTORY_SNAPSHOT_BYTES) {
        const oldest = this.#historySnapshots.keys().next().value!
        total -= this.#historySnapshots.get(oldest)!.bytes.length
        this.#historySnapshots.delete(oldest)
      }
    }
    if (cursor > bytes.length) throw new RemoteGatewayError('invalid_history_cursor')
    const end = Math.min(bytes.length, cursor + limit)
    return {
      dataBase64: bytes.subarray(cursor, end).toString('base64'),
      cursor: end,
      totalBytes: bytes.length,
      hasMore: end < bytes.length,
      snapshot
    }
  }

  // Serialize one turn at a time, yielding between turns so a full backfill
  // cannot monopolize the main loop or duplicate the whole-history JSON string.
  async #buildHistory(query: RemoteHistoryQuery): Promise<{ bytes: Buffer; snapshot: string }> {
    const raw = (await this.#history?.read(query)) ?? []
    const parts = [Buffer.from('[')]
    let total = 2
    for (const [index, turn] of raw.entries()) {
      const normalized: RemoteHistoryTurn = {
        userText: typeof turn?.userText === 'string' ? turn.userText : '',
        items: (turn?.items ?? []).flatMap((item) =>
          item && typeof item.text === 'string' && ['output', 'reasoning', 'tool', 'tool_result'].includes(item.kind)
            ? [{ kind: item.kind, text: item.text } as RemoteHistoryTurn['items'][number]] : [])
      }
      const bytes = Buffer.from(JSON.stringify(normalized), 'utf8')
      total += bytes.length + (index > 0 ? 1 : 0)
      if (total > MAX_HISTORY_SNAPSHOT_BYTES) throw new RemoteGatewayError('history_capacity_exceeded')
      if (index > 0) parts.push(Buffer.from(','))
      parts.push(bytes)
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    parts.push(Buffer.from(']'))
    const bytes = Buffer.concat(parts, total)
    return { bytes, snapshot: createHash('sha256').update(bytes).digest('hex') }
  }

  // The assistant's real streamed output CONTENT for one run, strictly after the
  // caller's cursor. Authorized by the same verified owner-device check as poll;
  // an unknown/evicted run yields an honest empty page (never fabricated).
  async pollOutput(peerCertSHA256: string, input: { runId: string; cursor: number }): Promise<RunOutputPage> {
    this.#authorize(peerCertSHA256)
    const cursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0 ? input.cursor : 0
    if (typeof input.runId !== 'string' || input.runId.length === 0 || input.runId.length > 128) return { chunks: [], cursor }
    return this.#output?.since(input.runId, cursor) ?? { chunks: [], cursor }
  }
}
