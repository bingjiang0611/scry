import type { DesktopDirectoryPage, DesktopRemoteCatalog, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteCommandCatalog, RemoteProviderRef, RemoteProjectRef, RemoteProviderQuery, RemoteSessionRef } from '../../shared/desktop-remote'
import type { DeleteSessionResult } from '../../shared/provider'
import { DesktopRemoteClientConnections } from './desktop-client-connections'
import { context, fail, record, text, pathText, HASH, MAX_ITEMS, MAX_PAGES, validateInfo, validateProject, validateProvider, validateSession, validateDeleteSessionResult } from './desktop-client-validation'

export abstract class DesktopRemoteClientCatalog extends DesktopRemoteClientConnections {
  async catalog(connectionIdValue: string): Promise<DesktopRemoteCatalog> {
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    const state = await this.state()
    const item = this.connection(state, connectionIdValue)
    const capabilities = validateInfo({ desktop: info }, item.hostId)
    const rawProjects = await this.catalogRequest<unknown>(connectionIdValue, { op: 'projects' }, 'projects')
    const rawProviders = await this.catalogRequest<unknown>(connectionIdValue, {
      op: 'providers', ...(capabilities.providerDiscovery === 2 ? { detail: 'metadata' satisfies RemoteProviderQuery['detail'] } : {})
    }, 'providers')
    if (!Array.isArray(rawProjects) || !Array.isArray(rawProviders) || rawProjects.length > MAX_ITEMS || rawProviders.length > MAX_ITEMS) fail('catalog_too_large')
    const sessions: RemoteSessionRef[] = []; let cursor = 0; let snapshot: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await this.catalogRequest<Record<string, unknown>>(connectionIdValue, { op: 'sessionsPage', includeArchived: true, cursor, limit: 100, ...(snapshot ? { snapshot } : {}) }, 'sessionsPage')
      if (!Array.isArray(response.sessions) || !Number.isSafeInteger(response.cursor) || !Number.isSafeInteger(response.total) || typeof response.hasMore !== 'boolean' || !text(response.snapshot, 256)) fail('invalid_catalog_response')
      if (snapshot !== undefined && response.snapshot !== snapshot) fail('catalog_snapshot_changed')
      if (response.sessions.length > 100 || sessions.length + response.sessions.length > MAX_ITEMS) fail('catalog_too_large')
      sessions.push(...response.sessions.map((item) => validateSession(item)))
      if (!response.hasMore) break
      if ((response.cursor as number) <= cursor) fail('invalid_catalog_cursor')
      cursor = response.cursor as number; snapshot = response.snapshot as string
      if (page === MAX_PAGES - 1) fail('catalog_too_large')
    }
    return { projects: rawProjects.map((item) => validateProject(item)), providers: rawProviders.map((item) => validateProvider(item)), sessions, providerEvidence: capabilities.providerDiscovery === 2 ? 'host_snapshot' : 'legacy_host', ...capabilities }
  }

  async providerControls(connectionIdValue: string, value: DesktopRemoteContext): Promise<RemoteProviderRef> {
    const query = context(value)
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    const state = await this.state()
    const item = this.connection(state, connectionIdValue)
    const capabilities = validateInfo({ desktop: info }, item.hostId)
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
