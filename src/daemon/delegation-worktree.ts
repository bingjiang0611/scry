import { createHash } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ScGit } from '../main/source-control/git'
import { ScProcess } from '../main/source-control/process'
import {
  assertWorkspaceCheckoutSafe,
  cleanupAbortedWorkspaceWorktree,
  createWorkspaceWorktree
} from '../main/source-control/workspace-git'

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
 * Reuses `assertWorkspaceCheckoutSafe`, `createWorkspaceWorktree`, and `cleanupAbortedWorkspaceWorktree`
 * from `workspace-git.ts`. Enforces `authorizeDirectory` on both `sourceCwd` and `identity.root` (B3).
 */
export function createDelegatedWorktreePreparer(options: DelegatedWorktreePreparerOptions) {
  const proc = new ScProcess()
  const git = new ScGit(proc, options.authorizeDirectory)

  return async (input: { sourceCwd: string; taskId: string }): Promise<DelegatedWorktreeHandle> => {
    // B3: explicitly authorize both sourceCwd and resolved git root so a nested subdir cannot check out an unauthorized parent repo.
    const authorizedSource = options.authorizeDirectory(input.sourceCwd)
    const identity = await git.identity(authorizedSource)
    options.authorizeDirectory(identity.root)

    const head = (await git.run(identity.root, ['rev-parse', 'HEAD'])).trim()
    if (!head) throw new Error('delegated_worktree_no_head')

    // B3: block .gitattributes smudge/clean/process filters and submodules before checkout.
    await assertWorkspaceCheckoutSafe(git, identity, head)

    const shortHash = createHash('sha256').update(input.taskId).digest('hex').slice(0, 8)
    const safePrefix = `${input.taskId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'task'}-${shortHash}`
    const repoHash = createHash('sha256').update(identity.commonDir).digest('hex')
    const root = await realpath(options.userDataDir)
    const repoDir = join(root, 'worktrees', repoHash)
    await mkdir(repoDir, { recursive: true })

    const worktreePath = join(repoDir, `delegated-${safePrefix}`)
    const branch = `scry-delegated-${safePrefix}`
    const branchRef = `refs/heads/${branch}`

    try {
      await createWorkspaceWorktree(git, identity, worktreePath, branch, head)
      const canonicalCwd = await realpath(worktreePath)
      return {
        cwd: canonicalCwd,
        branch,
        cleanup: async () => {
          await cleanupAbortedWorkspaceWorktree(git, identity, canonicalCwd, branchRef, head, options.userDataDir)
        }
      }
    } catch (error) {
      await cleanupAbortedWorkspaceWorktree(git, identity, worktreePath, branchRef, head, options.userDataDir).catch(() => undefined)
      throw error
    }
  }
}
