import { createHash } from 'node:crypto'
import { resolveBranchDiffBase } from './git-branch-base.js'
import type { GitDiffScope, WorkspaceDiffSnapshotResult } from '../../shared/workspace-diff.js'
import type { TurnDiffSnapshot } from '../../shared/trace.js'
import { beginGitTurnDiff, cleanupCapture, type GitTurnDiffCapture } from './git-capture.js'
import { computeGitTurnDiff } from './git-compute.js'
import { GitDeadlineError, TURN_DIFF_BEGIN_DEADLINE_MS } from './git-command.js'
import { WorkspaceReadUnavailable } from './git-workspace-limits.js'

/** No second worktree read: reuse the captured after-tree for statistics and patches. */
export async function readWorkspaceDiffSnapshot(
  cwd: string,
  excludedPaths: string[] = [],
  deadlineMs = TURN_DIFF_BEGIN_DEADLINE_MS,
  scope: GitDiffScope = 'workspace'
): Promise<WorkspaceDiffSnapshotResult> {
  const started = Date.now()
  let collectedAt = new Date(started).toISOString()
  let capture: GitTurnDiffCapture | undefined
  let snapshot: TurnDiffSnapshot | undefined
  try {
    capture = await beginGitTurnDiff(cwd, deadlineMs, undefined, excludedPaths, true)
    collectedAt = new Date().toISOString()
    if (capture.status !== 'ready') {
      return { status: capture.status, reason: capture.reason ?? 'git_error', files: [], collectedAt }
    }
    if (!capture.head || !capture.beforeTree || !capture.objectDir || !capture.indexPath) {
      return { status: 'failed', reason: 'git_error', files: [], collectedAt }
    }
    const head = capture.head
    const afterTree = capture.beforeTree
    const branchComparison = scope === 'branch' ? await resolveBranchDiffBase(capture, started + deadlineMs) : undefined
    const comparison = { ...capture, beforeTree: branchComparison?.baseCommit ?? head }
    snapshot = await computeGitTurnDiff(
      comparison,
      Math.max(0, deadlineMs - (Date.now() - started)),
      { workspaceSnapshot: true },
      false,
      {
        tree: afterTree,
        afterAt: collectedAt,
        indexFile: capture.indexPath,
        objectDir: capture.objectDir,
        alternateObjectDirs: capture.alternateObjectDirs,
        filterOverrides: capture.filterOverrides ?? []
      }
    )
    if (snapshot.status !== 'captured') {
      return { status: snapshot.status, reason: snapshot.reason ?? 'git_error', files: [], collectedAt }
    }
    const revision = createHash('sha256').update(JSON.stringify([head, afterTree, capture.pathspec, branchComparison])).digest('hex')
    return { status: 'captured', head, revision, collectedAt, snapshot, ...(branchComparison ? { comparison: branchComparison } : {}) }
  } catch (error) {
    if (error instanceof WorkspaceReadUnavailable) {
      return { status: 'unavailable', reason: error.reason, files: [], collectedAt }
    }
    return {
      status: error instanceof GitDeadlineError ? 'timeout' : 'failed',
      reason: error instanceof GitDeadlineError ? 'deadline' : 'git_error',
      files: [],
      collectedAt
    }
  } finally {
    if (capture) {
      const cleanup = await cleanupCapture(capture)
      if (snapshot) snapshot.cleanup = cleanup
    }
  }
}
