import type { IpcMainInvokeEvent } from 'electron'
import { workspaceDiffCopy } from '../shared/constants/copy'
import { gitNumstat } from '../core/turn-recorder/git.js'

// Electron 与 CLI 共用同一套 Git turn snapshot 实现。
export * from '../core/turn-recorder/git.js'

export function registerGitDiffIpc(
  register: (channel: string, listener: (event: IpcMainInvokeEvent, cwd: unknown) => unknown) => void,
  authorizeDirectory: (cwd: string) => string
): void {
  register('agent:gitDiff', (_event, cwd) => {
    if (typeof cwd !== 'string') throw new Error(workspaceDiffCopy.invalidDirectory)
    return gitNumstat(authorizeDirectory(cwd))
  })
}
