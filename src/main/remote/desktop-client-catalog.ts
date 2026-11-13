import type { DesktopDirectoryPage, DesktopRemoteCatalog, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteCommandCatalog, RemoteProviderRef, RemoteProjectRef, RemoteSessionRef } from '../../shared/desktop-remote'
import type { DeleteSessionResult } from '../../shared/provider'
import type { ScRead } from '../../shared/source-control'
import type { WorkspaceBranchChoice, WorkspaceBranchRef, WorkspaceChoices, WorkspaceChoicesRequest, WorkspaceWorktreeChoice } from '../../shared/workspace-selection'
import { DesktopRemoteClientConnections } from './desktop-client-connections'
import { context, fail, record, text, pathText, HASH, MAX_ITEMS, MAX_PAGES, validateProject, validateProvider, validateSession, validateDeleteSessionResult } from './desktop-client-validation'
import { validateInfo } from './desktop-client-capabilities'

function scReason(value: unknown): string {
  if (!record(value) || !text(value.reason, 16_384)) fail('invalid_workspace_response')
  return value.reason
}

function gitHash(value: unknown): string {
  if (!text(value, 64) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail('invalid_workspace_response')
  return value
}

function branchRef(value: unknown): WorkspaceBranchRef {
  if (!record(value) || (value.kind !== 'local' && value.kind !== 'remote') || !text(value.name, 1024)) fail('invalid_workspace_response')
  if (!value.name.startsWith(value.kind === 'local' ? 'refs/heads/' : 'refs/remotes/')) fail('invalid_workspace_response')
  return { kind: value.kind, name: value.name, head: gitHash(value.head) }
}

function branchChoice(value: unknown): WorkspaceBranchChoice {
  const ref = branchRef(value)
  if (!record(value) || !Array.isArray(value.worktreeIds) || value.worktreeIds.length > MAX_ITEMS ||
      value.worktreeIds.some((id) => !text(id, 24) || !/^[a-f0-9]{24}$/.test(id))) fail('invalid_workspace_response')
  return { ...ref, worktreeIds: [...value.worktreeIds] as string[] }
}

function nullableString(value: unknown, max: number): string | null {
  if (value === null) return null
  if (!text(value, max)) fail('invalid_workspace_response')
  return value
}

function worktreeChoice(value: unknown): WorkspaceWorktreeChoice {
  if (!record(value) || !text(value.id, 24) || !/^[a-f0-9]{24}$/.test(value.id) || !text(value.path, 16_384) ||
      typeof value.current !== 'boolean' || typeof value.busy !== 'boolean' || typeof value.bare !== 'boolean') fail('invalid_workspace_response')
  return {
    id: value.id, path: value.path,
    branchRef: nullableString(value.branchRef, 1024),
    head: value.head === null ? null : gitHash(value.head),
    current: value.current, busy: value.busy, bare: value.bare,
    locked: nullableString(value.locked, 4096), prunable: nullableString(value.prunable, 4096)
  }
}

function workspaceChoicesRead(value: unknown): ScRead<WorkspaceChoices> {
  if (!record(value) || !['available', 'unavailable', 'failed'].includes(String(value.status))) fail('invalid_workspace_choices_response')
  if (value.status !== 'available') return { status: value.status, reason: scReason(value) } as ScRead<WorkspaceChoices>
  const data = value.data
  if (!record(data) || !HASH.test(String(data.repositoryId)) || !text(data.root, 16_384) || !HASH.test(String(data.revision)) ||
      (data.branch !== null && !text(data.branch, 1024)) || (data.head !== null && data.head !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(data.head))) ||
      typeof data.dirty !== 'boolean' || (data.writeBlocker !== null && !text(data.writeBlocker, 16_384)) ||
      typeof data.commonDirBusy !== 'boolean' || typeof data.observedAt !== 'number' || !Number.isFinite(data.observedAt) || data.observedAt < 0 ||
      !record(data.page) || (data.page.kind !== 'branches' && data.page.kind !== 'worktrees') || !Array.isArray(data.page.items) ||
      data.page.items.length > MAX_ITEMS || typeof data.limited !== 'boolean') fail('invalid_workspace_choices_response')
  let nextCursor: WorkspaceChoicesRequest['cursor'] | null = null
  if (data.nextCursor !== null) {
    if (!record(data.nextCursor) || !text(data.nextCursor.revision, 24) || !/^[a-f0-9]{24}$/.test(data.nextCursor.revision) ||
        !Number.isSafeInteger(data.nextCursor.offset) || (data.nextCursor.offset as number) < 0 || (data.nextCursor.offset as number) > 1_000) fail('invalid_workspace_choices_response')
    nextCursor = { revision: data.nextCursor.revision, offset: data.nextCursor.offset as number }
  }
  return { status: 'available', data: {
    repositoryId: data.repositoryId as string, root: data.root as string, revision: data.revision as string,
    branch: data.branch as string | null, head: data.head == null ? null : String(data.head), dirty: data.dirty,
    writeBlocker: data.writeBlocker as string | null, commonDirBusy: data.commonDirBusy, observedAt: data.observedAt,
    ...(data.defaultBase === undefined ? {} : { defaultBase: branchRef(data.defaultBase) }),
    ...(data.selectedWorktree === undefined ? {} : { selectedWorktree: worktreeChoice(data.selectedWorktree) }),
    page: data.page.kind === 'branches'
      ? { kind: 'branches', items: data.page.items.map(branchChoice) }
      : { kind: 'worktrees', items: data.page.items.map(worktreeChoice) },
    nextCursor, limited: data.limited
  } }
}

function workspaceBranchRead(value: unknown): ScRead<{ name: string }> {
  if (!record(value) || !['available', 'unavailable', 'failed'].includes(String(value.status))) fail('invalid_workspace_branch_response')
  if (value.status !== 'available') return { status: value.status, reason: scReason(value) } as ScRead<{ name: string }>
  if (!record(value.data) || !text(value.data.name, 240)) fail('invalid_workspace_branch_response')
  return { status: 'available', data: { name: value.data.name } }
}

export abstract class DesktopRemoteClientCatalog extends DesktopRemoteClientConnections {
  async workspaceChoices(connectionIdValue: string, request: WorkspaceChoicesRequest): Promise<ScRead<WorkspaceChoices>> {
    const result = await this.desktop(connectionIdValue, { kind: 'workspaceChoices', request })
    if (result.kind !== 'workspaceChoices') fail('invalid_workspace_choices_response')
    return workspaceChoicesRead(result.value)
  }

  async validateWorkspaceBranch(connectionIdValue: string, request: { cwd: string; repositoryId: string; name: string }): Promise<ScRead<{ name: string }>> {
    const result = await this.desktop(connectionIdValue, { kind: 'validateWorkspaceBranch', request })
    if (result.kind !== 'validateWorkspaceBranch') fail('invalid_workspace_branch_response')
    return workspaceBranchRead(result.value)
  }

  // One round trip for info, projects, provider metadata and the first session
  // page. A host that reports the same revision costs the request and nothing
  // else: the whole payload is skipped, not re-sent and re-validated.
  async catalog(connectionIdValue: string): Promise<DesktopRemoteCatalog> {
    let cached = this.catalogCache.get(connectionIdValue)
    let response = await this.requestForConnection(connectionIdValue, { op: 'catalogSnapshot', ...(cached ? { revision: cached.revision } : {}) })
    if (!record(response) || !record(response.catalogSnapshot)) fail('invalid_catalog_response')
    if (response.catalogSnapshot.unchanged === true && !cached) {
      // The cache can be dropped by a disconnect between the request and the reply.
      // Ask again from scratch rather than report a failure the host did not cause.
      response = await this.requestForConnection(connectionIdValue, { op: 'catalogSnapshot' })
      if (!record(response) || !record(response.catalogSnapshot)) fail('invalid_catalog_response')
      cached = undefined
    }
    const snapshot = response.catalogSnapshot
    if (snapshot.unchanged === true) {
      // Only a fully paged catalog is cached, so unchanged always has an answer.
      if (!cached || !text(snapshot.revision, 64)) fail('invalid_catalog_response')
      return this.withAttention(connectionIdValue, cached.catalog)
    }
    if (!text(snapshot.revision, 64)) fail('invalid_catalog_response')
    const item = this.connection(await this.state(), connectionIdValue)
    const capabilities = validateInfo({ desktop: snapshot.info }, item.hostId)
    const rawProjects = snapshot.projects
    const rawProviders = snapshot.providers
    if (!Array.isArray(rawProjects) || !Array.isArray(rawProviders) || rawProjects.length > MAX_ITEMS || rawProviders.length > MAX_ITEMS) fail('catalog_too_large')
    const sessions: RemoteSessionRef[] = []; let cursor = 0; let pageSnapshot: string | undefined
    const first = snapshot.sessionsPage
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageResponse = page === 0 ? first : await this.catalogRequest<Record<string, unknown>>(connectionIdValue, { op: 'sessionsPage', includeArchived: true, cursor, limit: 100, ...(pageSnapshot ? { snapshot: pageSnapshot } : {}) }, 'sessionsPage')
      if (!record(pageResponse) || !Array.isArray(pageResponse.sessions) || !Number.isSafeInteger(pageResponse.cursor) || !Number.isSafeInteger(pageResponse.total) || typeof pageResponse.hasMore !== 'boolean' || !text(pageResponse.snapshot, 256)) fail('invalid_catalog_response')
      if (pageSnapshot !== undefined && pageResponse.snapshot !== pageSnapshot) fail('catalog_snapshot_changed')
      if (pageResponse.sessions.length > 100 || sessions.length + pageResponse.sessions.length > MAX_ITEMS) fail('catalog_too_large')
      sessions.push(...pageResponse.sessions.map((session) => validateSession(session)))
      if (!pageResponse.hasMore) break
      if ((pageResponse.cursor as number) <= cursor) fail('invalid_catalog_cursor')
      cursor = pageResponse.cursor as number; pageSnapshot = pageResponse.snapshot as string
      if (page === MAX_PAGES - 1) fail('catalog_too_large')
    }
    const catalog: DesktopRemoteCatalog = { projects: rawProjects.map((project) => validateProject(project)), providers: rawProviders.map((provider) => validateProvider(provider)), sessions, providerEvidence: capabilities.providerDiscovery === 2 ? 'host_snapshot' : 'legacy_host', ...capabilities }
    this.catalogCache.set(connectionIdValue, { revision: snapshot.revision, catalog, capabilities })
    return this.withAttention(connectionIdValue, catalog)
  }

  // Unread keys are this client's view state, derived from the host's catalog evidence
  // on every read (cached or fresh); they are never stored in the cached catalog.
  private withAttention(connectionIdValue: string, catalog: DesktopRemoteCatalog): DesktopRemoteCatalog {
    const unreadSessionKeys = this.attention?.catalog(connectionIdValue, { sessions: catalog.sessions })
    return unreadSessionKeys ? { ...catalog, unreadSessionKeys: [...unreadSessionKeys] } : catalog
  }

  async providerControls(connectionIdValue: string, value: DesktopRemoteContext): Promise<RemoteProviderRef> {
    const query = context(value)
    // Capabilities come from the catalog snapshot this device just read. Without
    // one, read them now rather than guess: an older host must fail closed.
    let capabilities = this.catalogCache.get(connectionIdValue)?.capabilities
    if (!capabilities) {
      const state = await this.state()
      capabilities = validateInfo({ desktop: await this.desktop(connectionIdValue, { kind: 'info' }) }, this.connection(state, connectionIdValue).hostId)
    }
    if (capabilities.providerDiscovery !== 2) fail('provider_controls_unavailable')
    const raw = await this.catalogRequest<unknown>(connectionIdValue, {
      op: 'providers', detail: 'selected', providerId: query.providerId, cwd: query.cwd,
      ...(query.agentProfileId ? { agentProfileId: query.agentProfileId } : {})
    }, 'providers')
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) fail('provider_controls_unavailable')
    const refs = raw.map((item) => validateProvider(item))
    const selected = refs.find((item) => item.id === query.providerId && (item.agentProfileId ?? '') === (query.agentProfileId ?? ''))
    if (!selected) fail('provider_controls_unavailable')
    return selected
  }

  async commands(connectionIdValue: string, value: DesktopRemoteContext): Promise<RemoteCommandCatalog> {
    const query = context(value)
    const raw = await this.catalogRequest<unknown>(connectionIdValue, { op: 'commands', providerId: query.providerId, cwd: query.cwd, ...(query.agentProfileId ? { agentProfileId: query.agentProfileId } : {}) }, 'commands')
    if (!record(raw) || !Array.isArray(raw.commands) || raw.commands.length > MAX_ITEMS || (raw.reason !== undefined && !text(raw.reason, 512))) fail('invalid_catalog_response')
    const commands = raw.commands.map((item): RemoteCommandCatalog['commands'][number] => {
      if (!record(item) || !text(item.name, 128) || !pathText(item.description, 512) ||
          (item.argumentHint !== undefined && !text(item.argumentHint, 256)) ||
          (item.source !== undefined && !['builtin', 'skill', 'mcp', 'custom'].includes(String(item.source)))) fail('invalid_catalog_response')
      return { name: item.name, description: item.description, ...(text(item.argumentHint, 256) ? { argumentHint: item.argumentHint } : {}), ...(item.source !== undefined ? { source: item.source as RemoteCommandCatalog['commands'][number]['source'] } : {}) }
    })
    return { commands, ...(text(raw.reason, 512) ? { reason: raw.reason } : {}) }
  }

  async sessionAction(connectionIdValue: string, value: DesktopRemoteContext, action: DesktopRemoteSessionAction): Promise<boolean> {
    const query = context(value)
    if (!query.externalSessionId || !record(action)) fail('invalid_session_action')
    if (action.kind === 'rename') {
      if (typeof action.title !== 'string' || action.title.length > 256) fail('invalid_session_action')
    } else if (action.kind === 'pin') {
      if (typeof action.pinned !== 'boolean') fail('invalid_session_action')
    } else if (action.kind === 'archive') {
      if (typeof action.archived !== 'boolean') fail('invalid_session_action')
    } else fail('invalid_session_action')
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    const state = await this.state()
    const item = this.connection(state, connectionIdValue)
    const capabilities = validateInfo({ desktop: info }, item.hostId)
    if (capabilities.sessionActions !== true) fail('desktop_session_actions_unsupported')
    const response = await this.write(connectionIdValue, { op: 'sessionAction', context: query, action })
    if (!record(response) || typeof response.sessionAction !== 'boolean') fail('invalid_session_action_response')
    return response.sessionAction
  }

  async forkSession(connectionIdValue: string, request: DesktopRemoteForkSessionRequest): Promise<{ externalSessionId: string }> {
    if (!record(request) || !text(request.providerId, 256) || !text(request.cwd, 16_384) ||
        (request.agentProfileId !== undefined && !text(request.agentProfileId, 256)) || !text(request.sourceSessionId, 256) || !text(request.sourceRunId, 256) ||
        !text(request.sourceProviderTurnId, 256) || !text(request.sourceForkTurnId, 256)) fail('invalid_session_fork')
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    const state = await this.state(); const item = this.connection(state, connectionIdValue)
    if (validateInfo({ desktop: info }, item.hostId).sessionFork !== true) fail('desktop_session_fork_unsupported')
    let response: unknown
    try { response = await this.write(connectionIdValue, { op: 'sessionFork', request }) }
    catch (error) { if (this.isUnknown(error)) fail('desktop_session_operation_unknown'); throw error }
    if (!record(response) || !record(response.sessionFork) || !text(response.sessionFork.externalSessionId, 256)) fail('desktop_session_operation_unknown')
    return { externalSessionId: response.sessionFork.externalSessionId }
  }

  async deleteSession(connectionIdValue: string, request: DesktopRemoteDeleteSessionRequest): Promise<DeleteSessionResult> {
    if (!record(request) || !text(request.providerId, 256) || !text(request.cwd, 16_384) || !text(request.externalSessionId, 256) || request.confirmed !== true ||
        (request.agentProfileId !== undefined && !text(request.agentProfileId, 256))) fail('invalid_session_delete')
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    const state = await this.state(); const item = this.connection(state, connectionIdValue)
    if (validateInfo({ desktop: info }, item.hostId).sessionDelete !== true) fail('desktop_session_delete_unsupported')
    let response: unknown
    try { response = await this.write(connectionIdValue, { op: 'sessionDelete', request }) }
    catch (error) { if (this.isUnknown(error)) fail('desktop_session_operation_unknown'); throw error }
    if (!record(response) || !record(response.sessionDelete)) fail('desktop_session_operation_unknown')
    try { return validateDeleteSessionResult(response.sessionDelete) }
    catch { return fail('desktop_session_operation_unknown') }
  }

  async directories(connectionIdValue: string, path?: string, cursor?: number, snapshot?: string): Promise<DesktopDirectoryPage> {
    if (path !== undefined && !text(path, 4096) || cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0) || snapshot !== undefined && !HASH.test(snapshot) || Number(cursor) > 0 && snapshot === undefined) fail('invalid_directory_request')
    const result = await this.catalogRequest<unknown>(connectionIdValue, { op: 'desktopDirectory', query: { action: 'list', ...(path === undefined ? {} : { path }), ...(cursor === undefined ? {} : { cursor }), ...(snapshot === undefined ? {} : { snapshot }) } }, 'directory')
    if (!record(result)) fail('invalid_directory_response')
    const page = result.page
    if (result.action !== 'list' || !record(page) || !Array.isArray(page.directories) || page.directories.length > 100 || !Number.isSafeInteger(page.cursor) || !Number.isSafeInteger(page.total) || Number(page.cursor) < 0 || Number(page.total) < Number(page.cursor) || Number(page.total) > MAX_ITEMS || typeof page.hasMore !== 'boolean' || typeof page.snapshot !== 'string' || !HASH.test(page.snapshot)) fail('invalid_directory_response')
    if (page.hasMore !== (Number(page.cursor) < Number(page.total)) || Number(page.cursor) !== (cursor ?? 0) + page.directories.length || snapshot !== undefined && snapshot !== page.snapshot) fail('invalid_directory_response')
    return { current: validateProject(page.current), ...(page.parent === undefined ? {} : { parent: validateProject(page.parent) }), directories: page.directories.map(item => validateProject(item)), cursor: page.cursor as number, total: page.total as number, hasMore: page.hasMore, snapshot: page.snapshot }
  }

  async selectDirectory(connectionIdValue: string, path: string): Promise<RemoteProjectRef> {
    if (!text(path, 4096)) fail('invalid_directory_path')
    const result = await this.catalogRequest<unknown>(connectionIdValue, { op: 'desktopDirectory', query: { action: 'select', path } }, 'directory')
    if (!record(result) || result.action !== 'select') fail('invalid_directory_response')
    return validateProject(result.project)
  }

}
