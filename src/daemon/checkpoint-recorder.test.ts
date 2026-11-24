import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { createCheckpointGit } from './checkpoint-git'
import { applyRunRollback, recordRunCheckpoint } from './checkpoint-recorder'

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
      expect(handle.getRun('run-1')?.lifecycle).toBe('settled')
      const missing = await applyRunRollback(handle, git, { runId: 'run-unknown', cwd, managed: true }, 200)
      expect(missing.status).toBe('unavailable')
    } finally { handle.close() }
  })
})
