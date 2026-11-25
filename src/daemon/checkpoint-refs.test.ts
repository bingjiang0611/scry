import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureCheckpoint, checkpointRef, forgetCheckpoint, rollbackCheckpoint, type CheckpointGit } from './checkpoint-refs'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const gitIn = (cwd: string, args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' })

/** A private index keeps the capture from touching the repository's real one, as production does. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-checkpoint-'))
  dirs.push(dir)
  gitIn(dir, ['init', '-q', '--initial-branch=main'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-qm', 'first'])
  return dir
}

const git = (): CheckpointGit => ({
  writeTree: async (root) => {
    const index = join(root, '.git', 'scry-checkpoint-index')
    execFileSync('git', ['-c', `core.worktree=${root}`, `--git-dir=${join(root, '.git')}`, 'read-tree', 'HEAD'],
      { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index } })
    execFileSync('git', ['-c', `core.worktree=${root}`, `--git-dir=${join(root, '.git')}`, 'add', '-A'],
      { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index } })
    return execFileSync('git', ['-c', `core.worktree=${root}`, `--git-dir=${join(root, '.git')}`, 'write-tree'],
      { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: 'utf8' }).trim()
  },
  updateRef: async (root, ref, target) => { gitIn(root, ['update-ref', ref, target]) },
  listRefs: async (root, prefix) =>
    gitIn(root, ['for-each-ref', '--format=%(refname)', prefix]).split('\n').map((line) => line.trim()).filter(Boolean),
  readRef: async (root, ref) => {
    try {
      return execFileSync('git', ['rev-parse', '--verify', ref], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch { return undefined }
  },
  deleteRef: async (root, ref) => { gitIn(root, ['update-ref', '-d', ref]) },
  restoreTree: async (root, tree) => { gitIn(root, ['checkout', tree, '--', '.']) }
})

// D5: a checkpoint is a git ref over the turn's content. Rollback must be a real restore, and it
// must refuse a repository Scry does not manage rather than rewriting the user's worktree.

describe('checkpoint refs', () => {
  it('captures a tree ref and restores the content', async () => {
    const cwd = repo()
    const handle = git()
    const captured = await captureCheckpoint(handle, { cwd, runId: 'run-1' })
    expect(captured.status).toBe('captured')
    writeFileSync(join(cwd, 'a.txt'), 'two\n')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('two\n')
    const restored = await rollbackCheckpoint(handle, { cwd, runId: 'run-1', managed: true })
    expect(restored.status).toBe('restored')
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\n')
  })

  it('refuses an unmanaged worktree and an unknown checkpoint', async () => {
    const cwd = repo()
    const handle = git()
    expect(await rollbackCheckpoint(handle, { cwd, runId: 'run-1', managed: false }))
      .toEqual({ status: 'unavailable', reason: 'checkpoint_unmanaged_worktree' })
    expect(await rollbackCheckpoint(handle, { cwd, runId: 'missing', managed: true }))
      .toEqual({ status: 'unavailable', reason: 'checkpoint_missing' })
  })

  it('refuses a run id that could name another ref', async () => {
    expect(checkpointRef('../heads/main')).toBeUndefined()
    expect(checkpointRef('')).toBeUndefined()
    expect(checkpointRef('run-1')).toBe('refs/scry/checkpoints/run-1')
    const cwd = repo()
    expect(await captureCheckpoint(git(), { cwd, runId: 'a/../../b' }))
      .toEqual({ status: 'unavailable', reason: 'checkpoint_invalid_run_id' })
  })

  it('forgets the ref without deleting the tree', async () => {
    const cwd = repo()
    const handle = git()
    await captureCheckpoint(handle, { cwd, runId: 'run-2' })
    expect(await forgetCheckpoint(handle, { cwd, runId: 'run-2' })).toBe(true)
    expect(await handle.readRef(cwd, 'refs/scry/checkpoints/run-2')).toBeUndefined()
    expect(await forgetCheckpoint(handle, { cwd, runId: 'bad/../id' })).toBe(false)
  })
})
