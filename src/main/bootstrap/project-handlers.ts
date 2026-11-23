import { shell } from 'electron'
import type { TrustedRegistrar } from './agent-runtime-ipc'
import { projectCwdFromRequest } from './project-cwd'

// The project list itself (pin, rename, remove) is the daemon's (project-channels.ts,
// served as local ops); revealing in the file manager needs this App's shell and only
// reads the path.
export function registerProjectHandlers(deps: { handleTrusted: TrustedRegistrar }): void {
  deps.handleTrusted('agent:revealProject', (_event, cwd: unknown) => {
    shell.showItemInFolder(projectCwdFromRequest(cwd))
    return true as const
  })
}
