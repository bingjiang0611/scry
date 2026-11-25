import { copyFile, mkdtemp, rm } from 'node:fs/promises'
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
        // Keep the index's stat cache so Git doesn't rehash every tracked file from scratch.
        const index = (await run(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
        await copyFile(index, env.GIT_INDEX_FILE)
        await run(cwd, ['-c', 'core.fsmonitor=false', 'add', '-u'], env)
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
    async restoreTree(cwd, tree, before) {
      // Never reset the real index or overwrite files that changed after the safety copy.
      const indexChanges = await run(cwd, ['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--'])
      if (indexChanges) throw new Error('checkpoint_index_dirty')
      const dir = await mkdtemp(join(tmpdir(), 'scry-rollback-'))
      const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
      const baseline = before ?? 'HEAD'
      try {
        await run(cwd, ['read-tree', baseline], env)
        await run(cwd, ['update-index', '--refresh'], env)
        // A two-tree merge checks the on-disk files and refuses untracked obstructions.
        await run(cwd, ['read-tree', '-m', '-u', baseline, tree], env)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}
