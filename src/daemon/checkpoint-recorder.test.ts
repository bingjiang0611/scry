import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { createCheckpointGit } from './checkpoint-git'
import { applyRunRollback, recordRunCheckpoint } from './checkpoint-recorder'
import { createCheckpointService } from './checkpoint-service'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

const gitIn = (cwd: string, args: string[], env?: NodeJS.ProcessEnv): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', env })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-cp-rec-'))
  dirs.push(dir)
  gitIn(dir, ['init', '-q', '--initial-branch=main'])
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-qm', 'first'])
  return dir
}

const git = createCheckpointGit({ git: async (args, options) => gitIn(options.cwd, args, options.env) })

function sink(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-cp-sink-'))
  dirs.push(userData)
  return EventSink.open({ userDataDir: userData })
}

function command(type: string, commandId: string, payload: Record<string, unknown>, at = 10) {
  return { type, commandId, actor: 'system', scope: 'system', at, payload, payloadSha256: sha256Hex(canonicalJson(payload)) } as never
}

function settledRun(handle: EventSink, runId: string, cwd: string): void {
  handle.execute(command('run.submit', `submit-${runId}`, {
    runId, sessionKey: 'native-1', provider: 'pi', profile: null, cwd, promptPreview: 'p'
  }))
  for (const step of ['admitted', 'dispatched', 'settled']) {
    handle.execute(command('run.effect_result', `${step}-${runId}`, { runId, step }))
  }
}

// D5: the checkpoint row only exists when git produced a tree, and a rollback is recorded only
// after the worktree was actually restored.

describe('checkpoint recorder', () => {
  it('captures a real tree and records the ref', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      const captured = await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      expect(captured.status).toBe('captured')
      if (captured.status !== 'captured') return
      expect(handle.getRun('run-1')?.checkpointRef).toBe(captured.ref)
      expect(gitIn(cwd, ['rev-parse', '--verify', captured.ref]).trim()).toMatch(/^[0-9a-f]{40,64}$/)
    } finally { handle.close() }
  })

  it('restores the worktree and then marks the run rolled back', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      writeFileSync(join(cwd, 'a.txt'), 'two\n')
      writeFileSync(join(cwd, 'b.txt'), 'added\n')
      const restored = await applyRunRollback(handle, git, { runId: 'run-1', cwd, managed: true, reason: 'user' }, 200)
      expect(restored.status).toBe('restored')
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\n')
      expect(handle.getRun('run-1')).toMatchObject({ lifecycle: 'rolled_back', rolledBackAt: 200 })
    } finally { handle.close() }
  })

  it('leaves the lifecycle alone when the restore is refused', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      const refused = await applyRunRollback(handle, git, { runId: 'run-1', cwd, managed: false }, 200)
      expect(refused).toEqual({ status: 'unavailable', reason: 'checkpoint_unmanaged_worktree' })
      expect(gitIn(cwd, ['for-each-ref', '--format=%(refname)', 'refs/scry/']).trim())
        .toBe('refs/scry/checkpoints/run-1')
      expect(handle.getRun('run-1')?.lifecycle).toBe('settled')
      const missing = await applyRunRollback(handle, git, { runId: 'run-unknown', cwd, managed: true }, 200)
      expect(missing.status).toBe('unavailable')
    } finally { handle.close() }
  })
})

// B2 (review): the restore is destructive, so a refusal must arrive before it runs. A failed run keeps
// its checkpoint, and the authority only accepts a rollback from `settled` — without checking first,
// the files were rewritten and the caller was told "拒绝", which is the worst of both answers.
describe('checkpoint recorder: a refused rollback changes nothing', () => {
  it('refuses a failed run before touching the worktree', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      // The run then fails; the checkpoint from the settled pass is still recorded.
      handle.execute(command('run.submit', 'submit-2', {
        runId: 'run-2', sessionKey: 'native-1', provider: 'pi', profile: null, cwd, promptPreview: 'p'
      }))
      for (const step of ['admitted', 'dispatched']) {
        handle.execute(command('run.effect_result', `${step}-2`, { runId: 'run-2', step }))
      }
      handle.execute(command('run.effect_result', 'failed-2', { runId: 'run-2', step: 'failed' }))
      handle.execute(command('run.checkpoint', 'cp-2', { runId: 'run-2', ref: 'refs/scry/checkpoints/run-2', tree: 't2' }))
      writeFileSync(join(cwd, 'a.txt'), 'edited after failure\n')
      const refused = await applyRunRollback(handle, git, { runId: 'run-2', cwd, managed: true }, 200)
      expect(refused).toMatchObject({ status: 'unavailable', reason: 'illegal_transition' })
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('edited after failure\n')
      expect(handle.getRun('run-2')?.lifecycle).toBe('failed')
    } finally { handle.close() }
  })
})

// R9: a checkpoint is a git write into the user's own checkout, and the settlement path paid for it on
// every run. The ref also stayed forever: nothing ever deleted one.
describe('R9: checkpoints are bounded and never rewrite an unmanaged checkout', () => {
  it('does not write a tree into an unmanaged worktree', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      const service = createCheckpointService({ sink: () => handle, git, isManagedWorktree: () => false })
      const captured = await service.capture({ runId: 'run-1', cwd })
      expect(captured).toMatchObject({ status: 'unavailable', reason: 'checkpoint_unmanaged_worktree' })
      expect(gitIn(cwd, ['for-each-ref', 'refs/scry/checkpoints/']).trim()).toBe('')
      expect(handle.getRun('run-1')?.checkpointRef ?? null).toBeNull()
    } finally { handle.close() }
  })

  it('captures inside a managed worktree and keeps only the newest refs', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      const service = createCheckpointService({
        sink: () => handle,
        git,
        isManagedWorktree: () => true,
        maxCheckpoints: 2
      })
      for (const [index, runId] of ['run-1', 'run-2', 'run-3'].entries()) {
        settledRun(handle, runId, cwd)
        expect(await service.capture({ runId, cwd })).toMatchObject({ status: 'captured' })
        void index
      }
      const refs = gitIn(cwd, ['for-each-ref', 'refs/scry/checkpoints/']).trim().split('\n').filter(Boolean)
      expect(refs).toHaveLength(2)
      expect(refs.some((line) => line.includes('run-3'))).toBe(true)
      // The pruned runs no longer claim a checkpoint the ref store cannot back.
      expect(handle.getRun('run-1')?.checkpointRef ?? null).toBeNull()
    } finally { handle.close() }
  })

  it('does not prune another linked worktree’s checkpoint refs', async () => {
    const cwd = repo()
    const other = join(cwd, '..', `${cwd.split('/').at(-1)}-linked`)
    dirs.push(other)
    gitIn(cwd, ['worktree', 'add', '--detach', other, 'HEAD'])
    const handle = sink()
    try {
      const service = createCheckpointService({ sink: () => handle, git, isManagedWorktree: () => true, maxCheckpoints: 1 })
      for (const [runId, worktree] of [['run-1', other], ['run-2', cwd]]) {
        settledRun(handle, runId, worktree)
        expect(await service.capture({ runId, cwd: worktree })).toMatchObject({ status: 'captured' })
      }
      expect(gitIn(other, ['rev-parse', '--verify', 'refs/scry/checkpoints/run-1']).trim()).toMatch(/^[0-9a-f]{40,64}$/)
    } finally { handle.close() }
  })

  it('stores no untracked file and keeps a safety copy before a rollback', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      writeFileSync(join(cwd, 'untracked.txt'), 'never committed\n')
      settledRun(handle, 'run-1', cwd)
      const captured = await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      expect(captured.status).toBe('captured')
      if (captured.status !== 'captured') return
      const tree = gitIn(cwd, ['ls-tree', '-r', '--name-only', captured.tree])
      expect(tree).not.toContain('untracked.txt')

      writeFileSync(join(cwd, 'a.txt'), 'work in progress\n')
      const restored = await applyRunRollback(handle, git, { runId: 'run-1', cwd, managed: true }, 200)
      expect(restored.status).toBe('restored')
      // The work that was about to be overwritten is recoverable from its own ref.
      const safety = gitIn(cwd, ['rev-parse', '--verify', 'refs/scry/checkpoint-safety/run-1']).trim()
      expect(gitIn(cwd, ['ls-tree', '-r', '--name-only', safety])).toContain('a.txt')
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\n')
    } finally { handle.close() }
  })

  it('refuses a rollback while another run is still working in that worktree', async () => {
    const cwd = repo()
    const handle = sink()
    try {
      settledRun(handle, 'run-1', cwd)
      await recordRunCheckpoint(handle, git, { runId: 'run-1', cwd }, 100)
      handle.execute(command('run.submit', 'submit-live', {
        runId: 'run-live', sessionKey: 'native-2', provider: 'pi', profile: null, cwd, promptPreview: 'p'
      }))
      handle.execute(command('run.effect_result', 'live-dispatch', { runId: 'run-live', step: 'dispatched' }))
      writeFileSync(join(cwd, 'a.txt'), 'changed by the live run\n')
      const refused = await applyRunRollback(handle, git, { runId: 'run-1', cwd, managed: true }, 200)
      expect(refused).toMatchObject({ status: 'unavailable', reason: 'checkpoint_worktree_busy' })
      expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('changed by the live run\n')
      expect(handle.getRun('run-1')?.lifecycle).toBe('settled')
    } finally { handle.close() }
  })
})
