import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderId } from '../../shared/provider'
import { canonicalExistingDirectory, knownProjectDirectoryIfPresent } from '../../main/workspace-authorization'
import { registerWorkspaceSelectionIpc } from '../../main/source-control/workspace-ipc'
import { namesDirectory } from '../../main/bootstrap/known-project-daemon'
import {
  addPiProfileFromLauncher, piLauncherFromRequest, piProfileChannelHandlers, projectStoreChannelHandlers,
  providerContextChannelHandlers, recentFolderChannelHandlers, rememberChosenFolder, type PiProfileAddition
} from '../../main/bootstrap/project-channels'
import type { LocalOpHandler } from '../../main/remote/host-local-ops'
import type { DaemonLocalOpGroup } from './deps'

export const projectLocalOps: DaemonLocalOpGroup = (deps) => {
  const { workspace, providers, pi, session, history, sourceControl, providerDiscovery } = deps
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
    'agent:setCwd': (dir: unknown, clearIfMissing: unknown) => !namesDirectory(dir) ? null
      : clearIfMissing === true ? knownProjectDirectoryIfPresent(workspace.resolveKnownProjectDirectory, dir)
      : workspace.resolveKnownProjectDirectory(dir),
    'agent:chooseFolder': (picked: unknown) => rememberChosenFolder({
      canonicalExistingDirectory,
      invalidateSessionHistoryLoad: history.invalidateSessionHistoryLoad,
      rememberProject: workspace.rememberProject
    }, picked),
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
