import type { SessionLedger } from './session-ledger'
import type { RunOutputPage } from './run-output-log'
import type { RemoteWorkspaceQuery, RemoteWorkspaceResult } from './remote-workspace'
import type { RemoteFileDownloads } from './remote-file-download'
import type { RemoteProjectRef, RemoteProviderRef, RemoteProviderQuery, RemoteSessionRef, RemoteCommandCatalog } from '../../shared/desktop-remote'

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

export type RemoteHistoryScope = 'session' | 'profile'

export interface RemoteHistoryQuery {
  // `session` is the mobile display scope: one catalog-bound Provider session
  // may contain legacy/fork turns whose Profile provenance is unknown or mixed.
  // `profile` retains the old strict evidence contract for compatibility.
  historyScope?: RemoteHistoryScope
  agentProfileId?: string | null
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
  | { status: 'available'; source: 'active_memory' | 'indexed_archive' | 'index_rebuild' | 'monolithic' | 'pi_native'; turns: RemoteHistoryPreviewTurn[]; partial: true; truncated: boolean; bytes: number }
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
  source: 'active_memory' | 'indexed_archive' | 'index_rebuild' | 'monolithic' | 'claude_transcript' | 'pi_native'
  completeness: 'partial' | 'complete'
  sourceWarning?: 'native_unavailable'
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
  fileDownloads?: RemoteFileDownloads
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

export class RemoteGatewayError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'RemoteGatewayError'
    this.code = code
  }
}

export function historyScopeSelection(query: { historyScope?: unknown }, required = false): Pick<RemoteHistoryQuery, 'historyScope'> {
  if (!Object.hasOwn(query, 'historyScope')) {
    if (required) throw new RemoteGatewayError('history_scope_required')
    return {}
  }
  if (query.historyScope !== 'session' && query.historyScope !== 'profile') throw new RemoteGatewayError('invalid_history_scope')
  return { historyScope: query.historyScope }
}

export function historyProfileSelection(query: { agentProfileId?: unknown }, required = false): Pick<RemoteHistoryQuery, 'agentProfileId'> {
  if (!Object.hasOwn(query, 'agentProfileId')) {
    if (required) throw new RemoteGatewayError('history_profile_required')
    return {}
  }
  if (query.agentProfileId !== null && (typeof query.agentProfileId !== 'string' || !query.agentProfileId || query.agentProfileId.length > 128)) throw new RemoteGatewayError('invalid_history_profile')
  return { agentProfileId: query.agentProfileId }
}
