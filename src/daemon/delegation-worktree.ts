import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ScGit } from '../main/source-control/git'
import { ScProcess } from '../main/source-control/process'
import { cleanupAbortedWorkspaceWorktree, createWorkspaceWorktree } from '../main/source-control/workspace-git'

export interface DelegatedWorktreeHandle {
  cwd: string
  branch: string
  cleanup: () => Promise<void>
}

export interface DelegatedWorktreePreparerOptions {
  userDataDir: string
  authorizeDirectory: (dir: string) => string
}

/**
 * P6-4 worktree isolation for delegated tasks:
 * Reuses `createWorkspaceWorktree` and `cleanupAbortedWorkspaceWorktree` from `workspace-git.ts`.
 * Creates an isolated worktree at `<userDataDir>/worktrees/<repoHash>/delegated-<taskPrefix>`.
 */
export function createDelegatedWorktreePreparer(options: DelegatedWorktreePreparerOptions) {
  const proc = new ScProcess()
  const git = new ScGit(proc, options.authorizeDirectory)

  return async (input: { sourceCwd: string; taskId: string }): Promise<DelegatedWorktreeHandle> => {
    const identity = await git.identity(input.sourceCwd)
    const head = (await git.run(identity.root, ['rev-parse', 'HEAD'])).trim()
    if (!head) throw new Error('delegated_worktree_no_head')

    const safePrefix = input.taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'task'
    const repoHash = createHash('sha256').update(identity.commonDir).digest('hex')
    const root = await realpath(options.userDataDir)
    const repoDir = join(root, 'worktrees', repoHash)
    await mkdir(repoDir, { recursive: true })

    const worktreePath = join(repoDir, `delegated-${safePrefix}`)
    const branch = `scry-delegated-${safePrefix}`
    const branchRef = `refs/heads/${branch}`

    await createWorkspaceWorktree(git, identity, worktreePath, branch, head)
    const canonicalCwd = await realpath(worktreePath)

    return {
      cwd: canonicalCwd,
      branch,
      cleanup: async () => {
        await cleanupAbortedWorkspaceWorktree(git, identity, canonicalCwd, branchRef, head, options.userDataDir)
      }
    }
  }
}
