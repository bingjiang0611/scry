import { shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { registerChannelHandlers } from './startup-channels'
import { projectCwdFromRequest, projectStoreChannelHandlers } from './project-channels'

export interface ProjectHandlersDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  projectStore: () => { setPinned: (cwd: string, pinned: boolean) => boolean; rename: (cwd: string, name: string) => boolean; remove: (cwd: string) => void }
  recentStore: () => { remove: (cwd: string) => void }
}

export function registerProjectHandlers(deps: ProjectHandlersDependencies): void {
  const { handleTrusted, projectStore, recentStore } = deps
  // Shared with the daemon, which serves them as local ops in daemon mode (B4-L4).
  registerChannelHandlers(handleTrusted, projectStoreChannelHandlers({ projectStore, recentStore }))

  // Revealing in the file manager needs this App's shell; it only reads the path.
  handleTrusted('agent:revealProject', (_event, cwd: unknown) => {
    shell.showItemInFolder(projectCwdFromRequest(cwd))
    return true as const
  })
}
