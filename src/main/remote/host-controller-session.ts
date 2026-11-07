import type { DesktopRemoteContext, DesktopRemoteDeleteSessionRequest, DesktopRemoteForkSessionRequest, DesktopRemoteSessionAction } from '../../shared/desktop-remote'
import type { DeleteSessionResult } from '../../shared/provider'
import type { WorkspaceAuthorizer } from './remote-run-policy'
import type { HostControllerDependencies } from './host-controller-types'

// Device-facing session rename/pin/archive, fork and delete. Each one canonicalizes
// the cwd for the whole call and re-checks the device grant before the result is
// returned, so a revocation during the Provider call cannot leak a success.
export interface SessionActionDeps {
  authorizeDevice(peer: string): void
  workspace: WorkspaceAuthorizer
  sessionAction: HostControllerDependencies['sessionAction']
  sessionFork: HostControllerDependencies['sessionFork']
  sessionDelete: HostControllerDependencies['sessionDelete']
  // Already part of the shared dependency object: it answers the verified scope.
  gateway: { grantScope(peer: string): 'local' | 'remote' }
}

export async function runSessionAction(deps: SessionActionDeps, peer: string, input: unknown): Promise<boolean> {
    deps.authorizeDevice(peer)
    if (!deps.sessionAction) throw new Error('desktop_session_actions_unsupported')
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
    const canonicalCwd = deps.workspace.authorize(contextValue.cwd)
    const context: DesktopRemoteContext = {
      cwd: canonicalCwd,
      providerId: contextValue.providerId,
      ...(typeof contextValue.agentProfileId === 'string' ? { agentProfileId: contextValue.agentProfileId } : {}),
      externalSessionId: contextValue.externalSessionId
    }
    const authorize = (): void => {
      deps.authorizeDevice(peer)
      if (deps.workspace.authorize(context.cwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await deps.sessionAction(context, action, authorize)
    authorize()
    return result
}

export async function runSessionFork(deps: SessionActionDeps, peer: string, input: unknown): Promise<{ externalSessionId: string }> {
    deps.authorizeDevice(peer)
    if (!deps.sessionFork) throw new Error('desktop_session_fork_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_fork')
    const value = input as Record<string, unknown>
    const text = (candidate: unknown, max = 256): candidate is string => typeof candidate === 'string' && candidate.length > 0 && candidate.length <= max && !candidate.includes('\0')
    if (!text(value.providerId) || !text(value.cwd, 16_384) || !text(value.sourceSessionId) || !text(value.sourceRunId) ||
        !text(value.sourceProviderTurnId) || !text(value.sourceForkTurnId) ||
        (value.agentProfileId !== undefined && !text(value.agentProfileId)) ||
        (value.model !== undefined && (!value.model || typeof value.model !== 'object' || Array.isArray(value.model)))) throw new Error('invalid_session_fork')
    const canonicalCwd = deps.workspace.authorize(value.cwd)
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
      deps.authorizeDevice(peer)
      if (deps.workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    const result = await deps.sessionFork(request, authorize)
    authorize()
    if (!result || typeof result.externalSessionId !== 'string' || result.externalSessionId.length === 0) throw new Error('invalid_session_fork_response')
    return result
}

export async function runSessionDelete(deps: SessionActionDeps, peer: string, input: unknown): Promise<DeleteSessionResult> {
    deps.authorizeDevice(peer)
    if (!deps.sessionDelete) throw new Error('desktop_session_delete_unsupported')
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_session_delete')
    const value = input as Record<string, unknown>
    if (value.confirmed !== true || typeof value.providerId !== 'string' || value.providerId.length === 0 || value.providerId.length > 256 ||
        typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > 16_384 ||
        typeof value.externalSessionId !== 'string' || value.externalSessionId.length === 0 || value.externalSessionId.length > 256 ||
        (value.agentProfileId !== undefined && (typeof value.agentProfileId !== 'string' || value.agentProfileId.length === 0 || value.agentProfileId.length > 256))) throw new Error('invalid_session_delete')
    const canonicalCwd = deps.workspace.authorize(value.cwd)
    const request = {
      providerId: value.providerId,
      cwd: canonicalCwd,
      externalSessionId: value.externalSessionId,
      confirmed: true as const,
      ...(typeof value.agentProfileId === 'string' ? { agentProfileId: value.agentProfileId } : {})
    } satisfies DesktopRemoteDeleteSessionRequest
    const authorize = (): void => {
      deps.authorizeDevice(peer)
      if (deps.workspace.authorize(canonicalCwd) !== canonicalCwd) throw new Error('workspace_context_mismatch')
    }
    // Delete semantics differ by scope: the App may delete an unarchived session
    // after its own confirmation dialog, a device may only delete archived ones.
    const result = await deps.sessionDelete(request, authorize, deps.gateway.grantScope(peer))
    authorize()
    return result
}
