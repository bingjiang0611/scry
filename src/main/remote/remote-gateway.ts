import { SessionLedger, type RunLifecycle } from './session-ledger'
import { createHash } from 'node:crypto'
import type { RunOutputPage } from './run-output-log'
import { parseRemoteWorkspaceQuery, type RemoteWorkspaceResult } from './remote-workspace'
import { parseRemoteFileDownloadQuery, type RemoteFileDownloads, type RemoteFileDownloadResult } from './remote-file-download'
import type { RemoteProjectRef, RemoteProviderQuery, RemoteProviderRef, RemoteSessionRef, RemoteCommandCatalog } from '../../shared/desktop-remote'
import {
  type DeviceAuthorizer,
  type RemoteProjectSource,
  type RemoteDirectoryListing,
  type RemoteDirectoryPageQuery,
  type RemoteDirectoryPage,
  type RemoteDirectorySource,
  type RemoteProviderSource,
  type RemoteCommandQuery,
  type RemoteCommandSource,
  type RemoteSessionSource,
  type RemoteSessionPageQuery,
  type RemoteSessionPage,
  type RemoteHistoryTurn,
  type RemoteHistoryQuery,
  type RemoteHistoryPreview,
  type RemoteHistoryPreviewSource,
  type RemoteHistoryVersion,
  type RemoteHistoryVersionSource,
  type RemoteHistoryTurnsPageSource,
  type RemoteHistorySource,
  type RemoteOutputReader,
  type RemoteHistoryPageQuery,
  type RemoteHistoryPage,
  type RemoteHistoryTurnsPageQuery,
  type RemoteHistoryTurnsPage,
  type RemoteGatewayDependencies,
  type SubmitIntentInput,
  type SubmitIntentResult,
  RemoteGatewayError
} from './remote-gateway-types'
export {
  type DeviceAuthorizer,
  type RemoteHistoryScope,
  type RemoteProjectSource,
  type RemoteDirectoryListing,
  type RemoteDirectoryPageQuery,
  type RemoteDirectoryPage,
  type RemoteDirectorySource,
  type RemoteProviderSource,
  type RemoteCommandQuery,
  type RemoteCommandSource,
  type RemoteSessionSource,
  type RemoteSessionPageQuery,
  type RemoteSessionPage,
  type RemoteHistoryTurn,
  type RemoteHistoryQuery,
  type RemoteHistoryPreview,
  type RemoteHistoryPreviewSource,
  type RemoteHistoryVersion,
  type RemoteHistoryVersionSource,
  type RemoteHistoryTurnsPageSource,
  type RemoteHistorySource,
  type RemoteOutputReader,
  type RemoteHistoryPageQuery,
  type RemoteHistoryPage,
  type RemoteHistoryTurnsPageQuery,
  type RemoteHistoryTurnsPage,
  type RemoteGatewayDependencies,
  type SubmitIntentInput,
  type SubmitIntentResult,
  RemoteGatewayError,
  historyScopeSelection,
  historyProfileSelection
} from './remote-gateway-types'
export type { RemoteProjectRef, RemoteControlOption, RemoteModelOption, RemoteProviderRef, RemoteProviderQuery, RemoteSessionRef, RemoteCommandCatalog, RemoteCommandRef } from '../../shared/desktop-remote'
import {
  MAX_CATALOG_ITEMS,
  MAX_CATALOG_PAGE,
  projectRefs,
  sessionRefs
} from './remote-gateway-sanitizers'
import {
  readHistory,
  readHistoryPage,
  readHistoryPreview,
  readHistoryTurnsPage,
  readHistoryVersion,
  type RemoteGatewayHistoryContext
} from './remote-gateway-history'
import { listDirectories, listDirectoriesPage, type RemoteGatewayDirectoryContext } from './remote-gateway-directory'
import { listCommands, listProviderControls, listProviders, listProvidersFull, type RemoteGatewayCatalogContext } from './remote-gateway-catalog'

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











const HASH = /^[0-9a-f]{64}$/

export function scopedIntentId(peerCertSHA256: string, intentId: string): string {
  const hex = createHash('sha256').update(`${peerCertSHA256}\0${intentId}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`
}

const SESSION_SNAPSHOT_TTL_MS = 30_000
const MAX_SESSION_SNAPSHOTS = 32
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
  #fileDownloads?: RemoteFileDownloads
  #historySnapshots = new Map<string, { bytes: Buffer; expiresAt: number }>()
  #historyBuilds = new Map<string, Promise<{ bytes: Buffer; snapshot: string }>>()
  // A catalog page is a frozen view. Keep the materialized source only for the
  // short lifetime of a page walk; authorization is still checked on every
  // request, so revocation never relies on this cache.
  // Keep each immutable page walk by its authenticated peer, filter and
  // snapshot. A newer first page must not overwrite a still-active walk from
  // the same peer, while the finite cap prevents unbounded retention.
  #sessionCatalogs = new Map<string, { sessions: readonly RemoteSessionRef[]; snapshot: string; revision: string; expiresAt: number }>()

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
    this.#fileDownloads = deps.fileDownloads
  }

  // Fail closed on anything that is not a currently-authorized owner device.
  #authorize(peerCertSHA256: string): void {
    if (typeof peerCertSHA256 !== 'string' || !HASH.test(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
    if (!this.#authority.authorizesCertificate(peerCertSHA256)) throw new RemoteGatewayError('device_not_authorized')
  }

  async readFileDownload(peerCertSHA256: string, query: unknown): Promise<RemoteFileDownloadResult> {
    this.#authorize(peerCertSHA256)
    const parsed = parseRemoteFileDownloadQuery(query)
    if (!this.#fileDownloads) throw new RemoteGatewayError('file_download_unavailable')
    return this.#fileDownloads.read(peerCertSHA256, parsed, () => this.#authorize(peerCertSHA256))
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

  // An absent lookup alone cannot fence a delayed submit. Explicit recovery
  // reserves that same peer-scoped id with no executable routing, then cancels
  // it. A late original payload conflicts with the durable digest. Even a crash
  // between the two writes leaves no valid routing for the production executor.
  resolveIntent(peerCertSHA256: string, input: { intentId: string }): { runId: string; state: RunLifecycle } {
    this.#authorize(peerCertSHA256)
    if (typeof input?.intentId !== 'string') throw new RemoteGatewayError('invalid_intent_id')
    const intentId = scopedIntentId(peerCertSHA256, input.intentId)
    const found = this.#ledger.intentRun(intentId)
    if (found) return { runId: found.runId, state: found.lifecycle }
    const receipt = this.#ledger.recordIntent({ intentId, runId: SessionLedger.newRunId() })
    this.#ledger.markCancelled(receipt.event.runId)
    return { runId: receipt.event.runId, state: 'cancelled' }
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


  // The host-authorized project directories a device may target. Authorization
  // is the SAME owner-device check as every other method (a revoked device gets
  // nothing), and the list is a display-only snapshot - selecting one still
  // passes through the workspace authorizer on submit.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    this.#authorize(peerCertSHA256)
    return projectRefs(this.#projects?.list() ?? [])
  }

  // Browse immediate folders without widening the Mac's original project grant.
  // The host source canonicalizes and authorizes the requested path; this layer
  // authorizes the device and bounds every path returned over the wire.
  listDirectories(peerCertSHA256: string, input: { path?: string }): RemoteDirectoryListing {
    return listDirectories(this.#directoryContext(), peerCertSHA256, input)
  }

  listDirectoriesPage(peerCertSHA256: string, input: RemoteDirectoryPageQuery): RemoteDirectoryPage {
    return listDirectoriesPage(this.#directoryContext(), peerCertSHA256, input)
  }

  // One entry is one selectable Provider context. Pi profiles deliberately
  // share the canonical Provider id but carry distinct agentProfileId values.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    return listProviders(this.#catalogContext(), peerCertSHA256)
  }

  async listProviderControls(peerCertSHA256: string, query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef> {
    return listProviderControls(this.#catalogContext(), peerCertSHA256, query)
  }

  async listProvidersFull(peerCertSHA256: string): Promise<RemoteProviderRef[]> {
    return listProvidersFull(this.#catalogContext(), peerCertSHA256)
  }

  async listCommands(peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
    return listCommands(this.#catalogContext(), peerCertSHA256, query)
  }

  // Compatibility endpoint for older clients. New clients drain listSessionsPage.
  listSessions(peerCertSHA256: string): RemoteSessionRef[] {
    this.#authorize(peerCertSHA256)
    return sessionRefs((this.#sessions?.list() ?? []).filter(session => !session.archivedAt))
  }

  listSessionsPage(peerCertSHA256: string, input: RemoteSessionPageQuery): RemoteSessionPage {
    this.#authorize(peerCertSHA256)
    const cursor = input?.cursor ?? 0
    const limit = input?.limit ?? MAX_CATALOG_PAGE
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RemoteGatewayError('invalid_session_cursor')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CATALOG_PAGE) throw new RemoteGatewayError('invalid_session_limit')
    if (input.includeArchived !== undefined && typeof input.includeArchived !== 'boolean') throw new RemoteGatewayError('invalid_session_query')
    const filter = input.includeArchived === true
    const baseKey = `${peerCertSHA256}:${filter}`
    const now = Date.now()
    for (const [key, cached] of this.#sessionCatalogs) {
      if (cached.expiresAt <= now) this.#sessionCatalogs.delete(key)
    }
    const revision = this.#sessions?.revision?.() ?? ''
    let cached: { sessions: readonly RemoteSessionRef[]; snapshot: string; revision: string; expiresAt: number } | undefined

    if (input.snapshot !== undefined) {
      const key = `${baseKey}:${revision}:${input.snapshot}`
      cached = this.#sessionCatalogs.get(key)
      // An expired/evicted token, or one issued under an older source
      // revision, cannot be rebuilt from current content: doing so could make
      // a stale cursor appear valid after a concurrent refresh.
      if (!cached || cached.revision !== revision) throw new RemoteGatewayError('session_snapshot_changed')
      // Without a source revision there is no second invalidation signal. The
      // retained object is the honest frozen page walk until TTL/cap eviction;
      // authorization is still checked above on every request.
      // Refresh recency without changing the immutable catalog itself.
      cached.expiresAt = now + SESSION_SNAPSHOT_TTL_MS
      this.#sessionCatalogs.delete(key)
      this.#sessionCatalogs.set(key, cached)
    } else {
      const sessions = sessionRefs((this.#sessions?.list() ?? []).filter(session => filter || !session.archivedAt), MAX_CATALOG_ITEMS + 1)
      if (sessions.length > MAX_CATALOG_ITEMS) throw new RemoteGatewayError('session_capacity_exceeded')
      const immutable = Object.freeze(sessions.map((session) => Object.freeze(session)))
      const snapshot = createHash('sha256').update(JSON.stringify(immutable)).digest('hex')
      cached = { sessions: immutable, snapshot, revision, expiresAt: now + SESSION_SNAPSHOT_TTL_MS }
      const key = `${baseKey}:${revision}:${snapshot}`
      this.#sessionCatalogs.delete(key)
      this.#sessionCatalogs.set(key, cached)
      while (this.#sessionCatalogs.size > MAX_SESSION_SNAPSHOTS) {
        const oldest = this.#sessionCatalogs.keys().next().value
        if (oldest === undefined) break
        this.#sessionCatalogs.delete(oldest)
      }
    }

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
    return readHistoryPreview(this.#historyContext(), peerCertSHA256, query)
  }

  async readHistoryVersion(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryVersion> {
    return readHistoryVersion(this.#historyContext(), peerCertSHA256, query)
  }

  async readHistoryTurnsPage(peerCertSHA256: string, query: RemoteHistoryTurnsPageQuery): Promise<RemoteHistoryTurnsPage> {
    return readHistoryTurnsPage(this.#historyContext(), peerCertSHA256, query)
  }

  // The REAL conversation content of one session so the device can OPEN it,
  // authorized by the same owner-device check as every method. Bounded (turns,
  // items/turn, text length); an unknown/unauthorized/unreadable session returns
  // an empty list (honest: no content, never a fake transcript).
  async readHistory(peerCertSHA256: string, query: RemoteHistoryQuery): Promise<RemoteHistoryTurn[]> {
    return readHistory(this.#historyContext(), peerCertSHA256, query)
  }

  // Complete history bytes with a stable snapshot fence. Unlike the legacy
  // compatibility endpoint, this never truncates turns/items/text to fit a frame.
  async readHistoryPage(peerCertSHA256: string, query: RemoteHistoryPageQuery): Promise<RemoteHistoryPage> {
    return readHistoryPage(this.#historyContext(), peerCertSHA256, query)
  }

  #catalogContext(): RemoteGatewayCatalogContext {
    return {
      authorize: (peerCertSHA256) => this.#authorize(peerCertSHA256),
      providers: this.#providers,
      commands: this.#commands
    }
  }

  #directoryContext(): RemoteGatewayDirectoryContext {
    return {
      authorize: (peerCertSHA256) => this.#authorize(peerCertSHA256),
      directories: this.#directories
    }
  }

  #historyContext(): RemoteGatewayHistoryContext {
    return {
      authorize: (peerCertSHA256) => this.#authorize(peerCertSHA256),
      history: this.#history,
      historyPreview: this.#historyPreview,
      historyVersion: this.#historyVersion,
      historyTurnsPage: this.#historyTurnsPage,
      historySnapshots: this.#historySnapshots,
      historyBuilds: this.#historyBuilds
    }
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
