import type { IpcMainInvokeEvent } from 'electron'
import { realpath } from 'node:fs/promises'
import type { WorkspaceDiffResult } from '../shared/trace'
import { workspaceDiffCopy } from '../shared/constants/copy'
import { readWorkspaceNumstat } from '../core/turn-recorder/git.js'
import { readWorkspaceDiffSnapshot } from '../core/turn-recorder/git-workspace-snapshot.js'
import type { WorkspaceDiffSnapshotResult } from '../shared/workspace-diff'

// Electron 与 CLI 共用同一套 Git turn snapshot 实现。
export * from '../core/turn-recorder/git.js'

export function registerGitDiffIpc(
  register: (channel: string, listener: (event: IpcMainInvokeEvent, cwd: unknown) => unknown) => void,
  authorizeDirectory: (cwd: string) => string
): void {
  // Only share ongoing reads. Completed results cannot be validated cheaply against
  // arbitrary worktree edits, so there is deliberately no settled-result cache.
  const snapshots = new Map<string, Promise<WorkspaceDiffSnapshotResult>>()
  register('agent:gitDiffSnapshot', async (_event, cwd) => {
    if (typeof cwd !== 'string') throw new Error(workspaceDiffCopy.invalidDirectory)
    const canonicalCwd = await realpath(authorizeDirectory(cwd))
    const existing = snapshots.get(canonicalCwd)
    if (existing) return existing
    if (snapshots.size >= 4) {
      return { status: 'failed', reason: 'request_failed', files: [] } satisfies WorkspaceDiffSnapshotResult
    }
    const request = readWorkspaceDiffSnapshot(canonicalCwd).finally(() => snapshots.delete(canonicalCwd))
    snapshots.set(canonicalCwd, request)
    return request
  })
  const inFlight = new Map<string, Promise<WorkspaceDiffResult>>()
  register('agent:gitDiff', async (_event, cwd) => {
    if (typeof cwd !== 'string') throw new Error(workspaceDiffCopy.invalidDirectory)
    // Reauthorize every caller, including those joining an existing request.
    const canonicalCwd = await realpath(authorizeDirectory(cwd))
    const existing = inFlight.get(canonicalCwd)
    if (existing) return existing
    const request = readWorkspaceNumstat(canonicalCwd).finally(() => inFlight.delete(canonicalCwd))
    inFlight.set(canonicalCwd, request)
    return request
  })
}
