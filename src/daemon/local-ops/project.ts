import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderId } from '../../shared/provider'
import { canonicalExistingDirectory } from '../../main/workspace-authorization'
import { registerWorkspaceSelectionIpc } from '../../main/source-control/workspace-ipc'
import {
  addPiProfileFromLauncher, piLauncherFromRequest, piProfileChannelHandlers, projectStoreChannelHandlers,
  providerContextChannelHandlers, recentFolderChannelHandlers, rememberChosenFolder, type PiProfileAddition
} from '../../main/bootstrap/project-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
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
    }
  } as Record<string, LocalOpHandler>
}
