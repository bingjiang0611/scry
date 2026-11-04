import type { DesktopDirectoryResult, DesktopHostReadResult, DesktopRemoteContext, DesktopRemoteSessionAction, DesktopRemoteForkSessionRequest, DesktopRemoteDeleteSessionRequest, RemoteProviderQuery } from '../../shared/desktop-remote'
import type { DeleteSessionResult } from '../../shared/provider'
import { shapeAnalyticsPanel, shapeLlmPanel, shapeMcpPanel, shapeMcpScan, type ToolPanelPayload } from '../../shared/tool-panel'
import { parseDesktopDirectoryQuery } from './desktop-directory-picker'
import { parseDesktopHostRead } from './desktop-host-reader'
import { parseDesktopWorkbenchQuery } from './desktop-workbench'
import type { RemoteProjectRef, RemoteDirectoryListing, RemoteDirectoryPage, RemoteDirectoryPageQuery, RemoteProviderRef, RemoteCommandCatalog, RemoteCommandQuery } from './remote-gateway'
import { RemoteInteractionError } from './remote-interaction-broker'
import { attachmentCapability } from './desktop-attachments'
import { HostControllerBase } from './host-controller-base'

export abstract class HostControllerOperations extends HostControllerBase {

  async readDesktop(peerCertSHA256: string, input: unknown): Promise<DesktopHostReadResult> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.readDesktopSource) throw new Error('desktop_protocol_unavailable')
    const result = await this.readDesktopSource(parseDesktopHostRead(input))
    this.authorizeDevice(peerCertSHA256)
    if (result.kind !== 'info') return result
    const { sessionActions: _reportedSessionActions, sessionFork: _reportedSessionFork, sessionDelete: _reportedSessionDelete, ...info } = result
    return { ...info, ...(this.providerControls ? { providerDiscovery: 2 as const } : {}), ...(this.desktopDirectories ? { directorySelection: true as const } : {}), ...(this.desktopWorkbenchSource ? { workbench: 1 as const } : {}), ...(this.sessionActionSource ? { sessionActions: true as const } : {}), ...(this.sessionForkSource ? { sessionFork: true as const } : {}), ...(this.sessionDeleteSource ? { sessionDelete: true as const } : {}), ...(this.attachmentStore ? { attachments: attachmentCapability() } : {}) }
  }

  releaseDesktopPeer(peer: string): Promise<void> { return this.desktopWorkbenchSource?.release(peer) ?? Promise.resolve() }

  async desktopWorkbench(peer: string, input: unknown): Promise<unknown> {
    this.authorizeDevice(peer)
    if (!this.desktopWorkbenchSource) throw new Error('desktop_workbench_unavailable')
    const result = await this.desktopWorkbenchSource.request(peer, parseDesktopWorkbenchQuery(input), () => this.authorizeDevice(peer))
    try { this.authorizeDevice(peer) } catch (error) {
      await this.desktopWorkbenchSource.release(peer)
      throw error
    }
    return result
  }

  // Separate from the project-scoped mobile browser. Selecting is an explicit
  // workspace grant by an authenticated owner, never a browse side effect.
  desktopDirectory(peerCertSHA256: string, input: unknown): DesktopDirectoryResult {
    this.authorizeDevice(peerCertSHA256)
    if (!this.desktopDirectories) throw new Error('desktop_directory_selection_unavailable')
    const query = parseDesktopDirectoryQuery(input)
    return query.action === 'list'
      ? { action: 'list', page: this.desktopDirectories.list(query) }
      : { action: 'select', project: this.desktopDirectories.select(query.path) }
  }

  protected authorizeDevice(peerCertSHA256: string): void {
    if (!/^[a-f0-9]{64}$/.test(peerCertSHA256) || !this.authority.authorizesCertificate(peerCertSHA256)) {
      throw new RemoteInteractionError('device_not_authorized')
    }
  }

  // Narrow target routing needs the same verified-peer check as every existing
  // mobile operation. It deliberately exposes no pairing or workspace state.
  authorizeDevicePeer(peerCertSHA256: string): void { this.authorizeDevice(peerCertSHA256) }

  // Device-facing: the host-authorized project directories this device may
  // target, authorized by the same verified peer certificate as every method.
  listProjects(peerCertSHA256: string): RemoteProjectRef[] {
    return this.gateway.listProjects(peerCertSHA256)
  }

  // Device-facing: browse within a host-authorized project without granting the
  // phone access to any parent or sibling outside that project's canonical root.
  listDirectories(peerCertSHA256: string, input: { path?: string }): RemoteDirectoryListing {
    return this.gateway.listDirectories(peerCertSHA256, input)
  }

  listDirectoriesPage(peerCertSHA256: string, input: RemoteDirectoryPageQuery): RemoteDirectoryPage {
    return this.gateway.listDirectoriesPage(peerCertSHA256, input)
  }

  // Device-facing: the Providers this device may target, authorized by the same
  // verified peer certificate as every method.
  listProviders(peerCertSHA256: string): RemoteProviderRef[] {
    return this.gateway.listProviders(peerCertSHA256)
  }

  async listProvidersFull(peerCertSHA256: string): Promise<RemoteProviderRef[]> {
    return this.gateway.listProvidersFull(peerCertSHA256)
  }

  async listProviderControls(peerCertSHA256: string, query: Extract<RemoteProviderQuery, { detail: 'selected' }>): Promise<RemoteProviderRef> {
    return this.gateway.listProviderControls(peerCertSHA256, query)
  }

  // Device-facing: Provider-native slash commands for this exact workspace.
  listCommands(peerCertSHA256: string, query: RemoteCommandQuery): Promise<RemoteCommandCatalog> {
    return this.gateway.listCommands(peerCertSHA256, query)
  }

  // Device-facing read of one bounded tool panel. Unknown kinds and out-of-range
  // analytics windows are rejected; a missing source reports unavailable with a
  // reason instead of an empty panel that would read as "nothing happened".
  async readToolPanel(peerCertSHA256: string, input: unknown): Promise<ToolPanelPayload> {
    this.authorizeDevice(peerCertSHA256)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_tool_panel')
    const value = input as Record<string, unknown>
    const now = Date.now()
    if (value.kind === 'analytics') {
      const rangeDays = value.rangeDays ?? 7
      if (rangeDays !== 7 && rangeDays !== 30 && rangeDays !== 90) throw new Error('invalid_tool_panel')
      if (!this.toolPanels?.analytics) throw new Error('tool_panel_unavailable')
      const analytics = await this.toolPanels.analytics(rangeDays)
      return shapeAnalyticsPanel(analytics, now)
    }
    if (value.kind === 'llmPerformance') {
      if (!this.toolPanels?.llmPerformance) throw new Error('tool_panel_unavailable')
      const [history, running] = await this.toolPanels.llmPerformance()
      return shapeLlmPanel(history, running, now)
    }
    if (value.kind === 'mcpTrust') {
      const providerId = value.providerId
      if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 256) throw new Error('invalid_tool_panel')
      if (!this.toolPanels?.mcpTrust) throw new Error('tool_panel_unavailable')
      // The scan is static and read-only: it inspects configuration and tool
      // fingerprints and never starts, authorizes or connects an MCP server.
      const result = await this.toolPanels.mcpTrust({ providerId })
      if (result.unavailable) return { kind: 'mcpTrust', readAt: now, unavailable: result.unavailable }
      const scan = shapeMcpScan(result.scan)
      const snapshot = result.snapshot ?? { configured: [], runtime: null }
      return shapeMcpPanel(providerId, snapshot, now, scan,
        scan ? undefined : '这次没有生成可读的扫描报告')
    }
    throw new Error('invalid_tool_panel')
  }

  async sessionAction(peerCertSHA256: string, input: unknown): Promise<boolean> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.sessionActionSource) throw new Error('desktop_session_actions_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_action')
    const value = input as Record<string, unknown>
    const rawContext = value.context
    if (!rawContext || typeof rawContext !== 'object' || Array.isArray(rawContext)) throw new Error('invalid_session_action')
    const contextValue = rawContext as Record<string, unknown>
    if (typeof contextValue.cwd !== 'string' || contextValue.cwd.length === 0 || contextValue.cwd.length > 16_384 ||
        typeof contextValue.providerId !== 'string' || contextValue.providerId.length === 0 || contextValue.providerId.length > 256 ||
        typeof contextValue.externalSessionId !== 'string' || contextValue.externalSessionId.length === 0 || contextValue.externalSessionId.length > 256 ||
        (contextValue.agentProfileId !== undefined && (typeof contextValue.agentProfileId !== 'string' || contextValue.agentProfileId.length === 0 || contextValue.agentProfileId.length > 256))) {
      throw new Error('invalid_session_action')
    }
    const rawAction = value.action
    if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) throw new Error('invalid_session_action')
    const actionValue = rawAction as Record<string, unknown>
    let action: DesktopRemoteSessionAction
    if (actionValue.kind === 'rename' && typeof actionValue.title === 'string' && actionValue.title.length <= 256) action = { kind: 'rename', title: actionValue.title }
    else if (actionValue.kind === 'pin' && typeof actionValue.pinned === 'boolean') action = { kind: 'pin', pinned: actionValue.pinned }
    else if (actionValue.kind === 'archive' && typeof actionValue.archived === 'boolean') action = { kind: 'archive', archived: actionValue.archived }
    else throw new Error('invalid_session_action')
    const canonicalCwd = this.workspace.authorize(contextValue.cwd)
    const context: DesktopRemoteContext = {
      cwd: canonicalCwd,
      providerId: contextValue.providerId,
      ...(typeof contextValue.agentProfileId === 'string' ? { agentProfileId: contextValue.agentProfileId } : {}),
      externalSessionId: contextValue.externalSessionId
    }
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.workspace.authorize(context.cwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.sessionActionSource(context, action, authorize)
    authorize()
    return result
  }

  async sessionFork(peerCertSHA256: string, input: unknown): Promise<{ externalSessionId: string }> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.sessionForkSource) throw new Error('desktop_session_fork_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_fork')
    const value = input as Record<string, unknown>
    const text = (candidate: unknown, max = 256): candidate is string => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= max && !candidate.includes('\0')
    if (!text(value.providerId) || !text(value.cwd, 16_384) || !text(value.sourceSessionId) || !text(value.sourceRunId) ||
        !text(value.sourceProviderTurnId) || !text(value.sourceForkTurnId) ||
        (value.agentProfileId !== undefined && !text(value.agentProfileId)) ||
        (value.model !== undefined && (!value.model || typeof value.model !== 'object' || Array.isArray(value.model)))) throw new Error('invalid_session_fork')
    const canonicalCwd = this.workspace.authorize(value.cwd)
    const request = {
      providerId: value.providerId,
      cwd: canonicalCwd,
      sourceSessionId: value.sourceSessionId,
      sourceRunId: value.sourceRunId,
      sourceProviderTurnId: value.sourceProviderTurnId,
      sourceForkTurnId: value.sourceForkTurnId,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {}),
      ...(value.model !== undefined ? { model: value.model } : {})
    } as DesktopRemoteForkSessionRequest
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.sessionForkSource(request, authorize)
    authorize()
    if (!result || typeof result.externalSessionId !== 'string' || result.externalSessionId.length === 0) throw new Error('invalid_session_fork_response')
    return result
  }

  async sessionDelete(peerCertSHA256: string, input: unknown): Promise<DeleteSessionResult> {
    this.authorizeDevice(peerCertSHA256)
    if (!this.sessionDeleteSource) throw new Error('desktop_session_delete_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_delete')
    const value = input as Record<string, unknown>
    if (value.confirmed !== true || typeof value.providerId !== 'string' || value.providerId.length === 0 || value.providerId.length > 256 ||
        typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > 16_384 ||
        typeof value.externalSessionId !== 'string' || value.externalSessionId.length === 0 || value.externalSessionId.length > 256 ||
        (value.agentProfileId !== undefined && (typeof value.agentProfileId !== 'string' || value.agentProfileId.length === 0 || value.agentProfileId.length > 256))) throw new Error('invalid_session_delete')
    const canonicalCwd = this.workspace.authorize(value.cwd)
    const request = {
      providerId: value.providerId,
      cwd: canonicalCwd,
      externalSessionId: value.externalSessionId,
      confirmed: true as const,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {})
    } satisfies DesktopRemoteDeleteSessionRequest
    const authorize = (): void => {
      this.authorizeDevice(peerCertSHA256)
      if (this.workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await this.sessionDeleteSource(request, authorize)
    authorize()
    return result
  }



}
