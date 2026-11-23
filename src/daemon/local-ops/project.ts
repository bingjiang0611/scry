import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderId } from '../../shared/provider'
import { canonicalExistingDirectory, knownProjectDirectoryIfPresent } from '../../main/workspace-authorization'
import { registerWorkspaceSelectionIpc } from '../../main/source-control/workspace-ipc'
import { namesDirectory } from '../../main/bootstrap/known-project-daemon'
import {
  addPiProfileFromLauncher, piLauncherFromRequest, piProfileChannelHandlers, projectStoreChannelHandlers,
  providerContextChannelHandlers, recentFolderChannelHandlers, rememberChosenFolder, type PiProfileAddition
} from '../../main/bootstrap/project-channels'
import { localOpCaller, type LocalOpHandler } from '../../main/remote/host-local-ops'
import type {
  DelegationConfirmCancelRequest,
  DelegationConfirmTaskRequest,
  DelegationProjectPolicyRequest,
  DelegationSessionFullAccessRequest,
  DelegationStateQuery,
  DelegationStopSubtasksRequest
} from '../../shared/delegation'
import type { DaemonLocalOpGroup } from './deps'

// Project store writes, workspace selection, Provider context invalidation, Pi profiles,
// from the handlers main registers (project-channels.ts, workspace-ipc.ts). This daemon
// is the only writer of the recent folders and projects, its own workspace authorization
// input. No pickers or dialogs here: the App picked the folder or launcher and sends the
// path; a failed Pi handshake comes back as a result for the App's dialog.
export const projectLocalOps: DaemonLocalOpGroup = (deps) => {
  const { workspace, providers, pi, session, history, sourceControl, providerDiscovery } = deps
  // Paired devices see Provider metadata through this discovery; refresh failures are
  // reported by its own onError and keep the last snapshot.
  const refreshInvalidatedMetadata = (): void => { void providerDiscovery.refreshMetadata() }
  const invalidateRemoteProviderMetadata = (providerId: ProviderId): void => {
    providerDiscovery.invalidate(providerId)
    refreshInvalidatedMetadata()
  }
  const selection: Record<string, LocalOpHandler> = {}
  registerWorkspaceSelectionIpc((channel, listener) => {
    selection[channel] = (request: unknown) => listener(undefined as unknown as IpcMainInvokeEvent, request)
  }, sourceControl)

  return {
    ...projectStoreChannelHandlers({ projectStore: workspace.projectStore, recentStore: workspace.recentStore }),
    ...recentFolderChannelHandlers({ recentStore: workspace.recentStore }),
    ...selection,
    // Whether a directory is a project this daemon knows, for the App's window selection
    // and its known-project file channels: main's resolver over this daemon's stores.
    'agent:setCwd': (dir: unknown, clearIfMissing: unknown) => !namesDirectory(dir) ? null
      : clearIfMissing === true ? knownProjectDirectoryIfPresent(workspace.resolveKnownProjectDirectory, dir)
      : workspace.resolveKnownProjectDirectory(dir),
    // The window's selection stays in the App, which selects the answer after it.
    'agent:chooseFolder': (picked: unknown) => rememberChosenFolder({
      canonicalExistingDirectory,
      invalidateSessionHistoryLoad: history.invalidateSessionHistoryLoad,
      rememberProject: workspace.rememberProject
    }, picked),
    // The App filled a missing cwd with its window's selection; this process has none.
    ...providerContextChannelHandlers({
      providerRegistry: providers.providerRegistry,
      withProviderOperation: session.withProviderOperation,
      invalidateDiscovery: (providerId) => providerDiscovery.invalidate(providerId),
      refreshInvalidatedMetadata,
      currentCwd: () => undefined
    }),
    ...piProfileChannelHandlers({ piProfileStore: pi.piProfileStore, invalidateRemoteProviderMetadata }),
    'agent:addPiProfile': async (launcher: unknown, cwd: unknown): Promise<PiProfileAddition> => {
      const path = piLauncherFromRequest(launcher)
      if (cwd !== null && cwd !== undefined && typeof cwd !== 'string') throw new Error('无效的工作目录')
      try {
        // The handshake starts the launcher in this directory, so it must be a project
        // this daemon authorized; main's was the window's already-validated selection.
        const probeCwd = typeof cwd === 'string' ? workspace.resolveKnownProjectDirectory(cwd) : undefined
        const agent = await addPiProfileFromLauncher({
          piProfileStore: pi.piProfileStore, providerRegistry: providers.providerRegistry, invalidateRemoteProviderMetadata
        }, path, probeCwd)
        return { status: 'added', agent }
      } catch (error) {
        return { status: 'failed', message: String((error as Error).message) }
      }
    },
    'delegation:getState': (rawQuery: unknown) => {
      if (!deps.delegation) {
        return {
          projectDelegationEnabled: false,
          sessionFullAccessEnabled: false,
          tasks: [],
          usageBreakdown: { status: 'available', unavailableCount: 0, tokens: {}, usd: {}, credits: {} }
        }
      }
      const q = (rawQuery && typeof rawQuery === 'object' ? rawQuery : {}) as DelegationStateQuery
      const cwd = typeof q.cwd === 'string' && q.cwd.trim() ? workspace.resolveKnownProjectDirectory(q.cwd) : null
      const parentSessionKey = typeof q.parentSessionKey === 'string' && q.parentSessionKey.trim() ? q.parentSessionKey : null
      return deps.delegation.getState({ cwd, parentSessionKey })
    },
    'delegation:setProjectPolicy': (rawReq: unknown) => {
      const peer = localOpCaller()
      if (!deps.delegation || !peer) return { ok: false, reason: 'delegation_unavailable' }
      const req = rawReq as DelegationProjectPolicyRequest
      if (!req || typeof req.cwd !== 'string' || typeof req.enabled !== 'boolean') return { ok: false, reason: 'invalid_request' }
      const cwd = workspace.resolveKnownProjectDirectory(req.cwd)
      return deps.delegation.setProjectPolicy(`peer:${peer}`, { cwd, enabled: req.enabled })
    },
    'delegation:setSessionFullAccess': (rawReq: unknown) => {
      const peer = localOpCaller()
      if (!deps.delegation || !peer) return { ok: false, reason: 'delegation_unavailable' }
      const req = rawReq as DelegationSessionFullAccessRequest
      if (!req || typeof req.sessionKey !== 'string' || !req.sessionKey.trim() || typeof req.enabled !== 'boolean') {
        return { ok: false, reason: 'invalid_request' }
      }
      return deps.delegation.setSessionFullAccess(`peer:${peer}`, { sessionKey: req.sessionKey, enabled: req.enabled })
    },
    'delegation:confirmTask': async (rawReq: unknown) => {
      const peer = localOpCaller()
      if (!deps.delegation || !peer) return { ok: false, reason: 'delegation_unavailable' }
      const req = rawReq as DelegationConfirmTaskRequest
      if (!req || typeof req.taskId !== 'string' || typeof req.questionId !== 'string' || typeof req.approved !== 'boolean') {
        return { ok: false, reason: 'invalid_request' }
      }
      return await deps.delegation.confirmTask(`peer:${peer}`, req)
    },
    'delegation:confirmCancelTask': (rawReq: unknown) => {
      const peer = localOpCaller()
      if (!deps.delegation || !peer) return { ok: false, reason: 'delegation_unavailable' }
      const req = rawReq as DelegationConfirmCancelRequest
      if (!req || typeof req.taskId !== 'string' || typeof req.questionId !== 'string' || typeof req.approved !== 'boolean') {
        return { ok: false, reason: 'invalid_request' }
      }
      return deps.delegation.confirmCancelTask(`peer:${peer}`, req)
    },
    'delegation:stopSessionSubtasks': (rawReq: unknown) => {
      const peer = localOpCaller()
      if (!deps.delegation || !peer) return { ok: false, reason: 'delegation_unavailable' }
      const req = rawReq as DelegationStopSubtasksRequest
      if (!req || typeof req.parentSessionKey !== 'string' || !req.parentSessionKey.trim()) {
        return { ok: false, reason: 'invalid_request' }
      }
      return deps.delegation.stopSessionSubtasks(`peer:${peer}`, req)
    }
  } as Record<string, LocalOpHandler>
}
