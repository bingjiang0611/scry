import type { DesktopDirectoryPage, DesktopRemoteCatalog, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteCommandCatalog, RemoteProviderRef, RemoteProjectRef } from '../../shared/desktop-remote'
import type { HostMetricsSnapshot, HostProviderUsage } from '../../shared/host-metrics'
import { isHostAdminNotice, type HostAdminNotice } from '../../shared/host-admin'
import type { DeleteSessionResult } from '../../shared/provider'
import type { ScRead } from '../../shared/source-control'
import type { WorkspaceChoices, WorkspaceChoicesRequest } from '../../shared/workspace-selection'
import { DesktopRemoteClientConnections } from './desktop-client-connections'
import { context, fail, record, text, pathText, HASH, MAX_ITEMS, validateProject, validateProvider, validateDeleteSessionResult } from './desktop-client-validation'
import { workspaceBranchRead, workspaceChoicesRead } from './desktop-client-workspace-validation'
import { validateInfo } from './desktop-client-capabilities'
import { isUnknownFailure } from './desktop-client-intent-rules'

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

  // Session rows come from the subscription. The revision covers host metadata.
  async catalog(connectionIdValue: string): Promise<DesktopRemoteCatalog> {
    const status = await this.statusSubscription(connectionIdValue)
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
      if (!cached || !text(snapshot.revision, 64)) fail('invalid_catalog_response')
      return this.withAttention(connectionIdValue, { ...cached.catalog, sessions: status.sessions() })
    }
    if (!text(snapshot.revision, 64)) fail('invalid_catalog_response')
    const item = this.connection(await this.state(), connectionIdValue)
    const capabilities = validateInfo({ desktop: snapshot.info }, item.hostId)
    const rawProjects = snapshot.projects
    const rawProviders = snapshot.providers
    if (!Array.isArray(rawProjects) || !Array.isArray(rawProviders) || rawProjects.length > MAX_ITEMS || rawProviders.length > MAX_ITEMS) fail('catalog_too_large')
    let hostAdminNoticeItems: HostAdminNotice[] | undefined
    if (Array.isArray(snapshot.hostAdminNoticeItems)) {
      // Forward-compatible: drop unknown/malformed notice items and cap to 32 rather than failing the whole catalog read.
      const valid = snapshot.hostAdminNoticeItems.filter((entry): entry is HostAdminNotice => isHostAdminNotice(entry)).slice(0, 32)
      if (valid.length > 0) hostAdminNoticeItems = valid
    }
    const catalog: DesktopRemoteCatalog = {
      projects: rawProjects.map((project) => validateProject(project)),
      providers: rawProviders.map((provider) => validateProvider(provider)),
      sessions: status.sessions(),
      providerEvidence: capabilities.providerDiscovery === 2 ? 'host_snapshot' : 'legacy_host',
      ...capabilities,
      ...(hostAdminNoticeItems && hostAdminNoticeItems.length > 0 ? { hostAdminNoticeItems } : {})
    }
    this.catalogCache.set(connectionIdValue, { revision: snapshot.revision, catalog, capabilities })
    return this.withAttention(connectionIdValue, catalog)
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

  /**
   * P8 §5: one execution target's resource summary. Only a host that declared
   * `hostMetrics: 1` is asked; an older host is named as such so the card can say
   * 「请升级」 instead of drawing an empty machine.
   */
  async hostMetrics(connectionIdValue: string): Promise<HostMetricsSnapshot> {
    if (!text(connectionIdValue, 128)) fail('invalid_connection')
    const item = this.connection(await this.state(), connectionIdValue)
    const info = await this.desktop(connectionIdValue, { kind: 'info' })
    if (validateInfo({ desktop: info }, item.hostId).hostMetrics !== 1) fail('desktop_host_metrics_unsupported')
    const raw = await this.catalogRequest<unknown>(connectionIdValue, { op: 'hostMetrics' }, 'hostMetrics')
    return hostMetricsSnapshot(raw)
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
    catch (error) { if (isUnknownFailure(error)) fail('desktop_session_operation_unknown'); throw error }
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
    catch (error) { if (isUnknownFailure(error)) fail('desktop_session_operation_unknown'); throw error }
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

// The only fields the Desktop keeps from a host's answer: anything else (a PID, a
// process name, a path) is dropped rather than forwarded to the renderer.
function hostMetricsSnapshot(value: unknown): HostMetricsSnapshot {
  if (!record(value)) fail('invalid_host_metrics')
  const count = (entry: unknown, max = Number.MAX_SAFE_INTEGER): number | null =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0 && entry <= max ? entry : null
  const sampledAt = count(value.sampledAt)
  if (sampledAt === null) fail('invalid_host_metrics')
  const cpu = record(value.cpu) ? value.cpu : fail('invalid_host_metrics')
  const memory = record(value.memory) ? value.memory : fail('invalid_host_metrics')
  const scry = record(value.scry) ? value.scry : fail('invalid_host_metrics')
  const daemon = record(scry.daemon) ? scry.daemon : fail('invalid_host_metrics')
  const runs = record(value.runs) ? value.runs : fail('invalid_host_metrics')
  const cores = count(cpu.cores, 4096)
  const rssBytes = count(daemon.rssBytes)
  const totalBytes = count(memory.totalBytes)
  if (cores === null || cores < 1 || rssBytes === null || totalBytes === null || totalBytes < 1) fail('invalid_host_metrics')
  const percent = (entry: unknown): number | null =>
    typeof entry === 'number' && Number.isFinite(entry) && entry >= 0 && entry <= 100 ? entry : null
  const pressure = memory.pressure === undefined || memory.pressure === null
    ? null
    : memory.pressure === 'low' || memory.pressure === 'medium' || memory.pressure === 'high' ? memory.pressure : fail('invalid_host_metrics')
  const disks = Array.isArray(value.disks) ? value.disks.slice(0, 64).map((disk): HostMetricsSnapshot['disks'][number] => {
    if (!record(disk) || (disk.role !== 'data' && disk.role !== 'workspace')) fail('invalid_host_metrics')
    const total = count(disk.totalBytes)
    const free = count(disk.freeBytes)
    if (total === null || free === null) fail('invalid_host_metrics')
    return { role: disk.role, totalBytes: total as number, freeBytes: free as number }
  }) : fail('invalid_host_metrics')
  const providers: HostProviderUsage[] | null = scry.providers === null || scry.providers === undefined
    ? null
    : Array.isArray(scry.providers) ? scry.providers.slice(0, 64).map((entry): HostProviderUsage => {
      if (!record(entry) || !text(entry.providerId, 64)) fail('invalid_host_metrics')
      const processes = count(entry.processes)
      const providerRss = count(entry.rssBytes)
      if (processes === null || providerRss === null) fail('invalid_host_metrics')
      return { providerId: entry.providerId as string, processes: processes as number, cpuPercent: percent(entry.cpuPercent), rssBytes: providerRss as number }
    }) : fail('invalid_host_metrics')
  const active = count(runs.active)
  // 排队数可以是 null：宿主没接编排投影时报不出这个数。那是「不可用」，不是坏数据，
  // 拒绝整个快照会让这台主机的资源读取永远失败。非空但不成数才算坏。
  const unmeasuredQueue = runs.queued === null || runs.queued === undefined
  const queued = unmeasuredQueue ? null : count(runs.queued)
  if (active === null || (queued === null && !unmeasuredQueue)) fail('invalid_host_metrics')
  return {
    sampledAt: sampledAt as number,
    uptimeSec: count(value.uptimeSec),
    cpu: { percent: percent(cpu.percent), cores: cores as number, load1: typeof cpu.load1 === 'number' && Number.isFinite(cpu.load1) && cpu.load1 >= 0 ? cpu.load1 : null },
    memory: {
      totalBytes: totalBytes as number, usedBytes: count(memory.usedBytes), pressure,
      swapUsedBytes: count(memory.swapUsedBytes), swapTotalBytes: count(memory.swapTotalBytes)
    },
    disks,
    scry: { daemon: { cpuPercent: percent(daemon.cpuPercent), rssBytes: rssBytes as number }, providers },
    runs: { active: active as number, queued: queued as number | null }
  }
}
