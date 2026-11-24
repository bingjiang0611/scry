import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckpointGit } from './checkpoint-refs'

export interface CheckpointGitOptions {
  /** Git invocation seam; production passes the workspace git runner. */
  git: (args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<string>
}

/**
 * D5: the git side of a checkpoint. `write-tree` runs against a private index so the user's own
 * index and staging area are untouched, and the tree lands in the repository's real object
 * database — a ref cannot point at the scratch object store the diff capture uses.
 */
export function createCheckpointGit(options: CheckpointGitOptions): CheckpointGit {
  const run = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
    options.git(args, { cwd, ...(env ? { env } : {}) })

  return {
    async writeTree(cwd) {
      const dir = await mkdtemp(join(tmpdir(), 'scry-checkpoint-'))
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
      try {
        await run(cwd, ['read-tree', 'HEAD'], env)
        await run(cwd, ['add', '-A', '--', '.'], env)
        return (await run(cwd, ['write-tree'], env)).trim()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
    async updateRef(cwd, ref, target) {
      await run(cwd, ['update-ref', ref, target])
    },
    async readRef(cwd, ref) {
      try {
        return (await run(cwd, ['rev-parse', '--verify', ref])).trim() || undefined
      } catch {
        return undefined
      }
    },
    async deleteRef(cwd, ref) {
      await run(cwd, ['update-ref', '-d', ref])
    },
    async restoreTree(cwd, tree) {
      // `read-tree --reset -u` writes the tree into both the index and the worktree; a plain
      // checkout of a tree path is not enough to remove files the tree does not contain.
      await run(cwd, ['read-tree', '--reset', '-u', tree])
    }
  }
}
