import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from './event-sink'
import { canonicalJson, sha256Hex } from './canonical-json'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sink(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d5-'))
  dirs.push(userData)
  return EventSink.open({ userDataDir: userData })
}

function command(type: string, commandId: string, payload: Record<string, unknown>, at = 10) {
  return { type, commandId, actor: 'system', scope: 'system', at, payload, payloadSha256: sha256Hex(canonicalJson(payload)) } as never
}

function submitted(handle: EventSink, runId: string): void {
  handle.execute(command('run.submit', `submit-${runId}`, {
    runId, sessionKey: 'native-1', provider: 'pi', profile: null, cwd: '/w', promptPreview: 'p'
  }))
  handle.execute(command('run.effect_result', `admit-${runId}`, { runId, step: 'admitted' }))
  handle.execute(command('run.effect_result', `dispatch-${runId}`, { runId, step: 'dispatched' }))
  handle.execute(command('run.effect_result', `settle-${runId}`, { runId, step: 'settled' }))
}

// D5: a checkpoint is recorded evidence, and rollback is only allowed for a finished run whose
// recorded ref is the one being restored. Recording one must never move the run's lifecycle.

describe('D5: checkpoint and rollback decisions', () => {
  it('records the captured ref without touching the lifecycle', () => {
    const handle = sink()
    try {
      submitted(handle, 'run-1')
      handle.execute(command('run.checkpoint', 'cp-1', { runId: 'run-1', ref: 'refs/scry/checkpoints/run-1', tree: 't1' }))
      const run = handle.getRun('run-1')
      expect(run).toMatchObject({ lifecycle: 'settled', checkpointRef: 'refs/scry/checkpoints/run-1', rolledBackAt: null })
      expect(handle.listEvents().map((event) => event.type)).toContain('checkpoint.captured')
    } finally { handle.close() }
  })

  it('rolls a settled run back to its own ref only', () => {
    const handle = sink()
    try {
      submitted(handle, 'run-1')
      handle.execute(command('run.checkpoint', 'cp-1', { runId: 'run-1', ref: 'refs/scry/checkpoints/run-1', tree: 't1' }))
      const wrong = handle.execute(command('run.rollback', 'rb-wrong', { runId: 'run-1', ref: 'refs/scry/checkpoints/other' }))
      expect(wrong).toMatchObject({ kind: 'rejected', reason: 'invalid_target' })
      const ok = handle.execute(command('run.rollback', 'rb-1', { runId: 'run-1', ref: 'refs/scry/checkpoints/run-1', reason: 'user' }, 20))
      expect(ok.kind).toBe('accepted')
      expect(handle.getRun('run-1')).toMatchObject({ lifecycle: 'rolled_back', rolledBackAt: 20 })
      const types = handle.listEvents().map((event) => event.type)
      expect(types).toContain('checkpoint.rollback_requested')
      expect(types).toContain('run.rolled_back')
    } finally { handle.close() }
  })

  it('refuses to roll back a run with no checkpoint or a still live run', () => {
    const handle = sink()
    try {
      submitted(handle, 'run-1')
      expect(handle.execute(command('run.rollback', 'rb-none', { runId: 'run-1', ref: 'refs/scry/checkpoints/run-1' })))
        .toMatchObject({ kind: 'rejected', reason: 'invalid_target' })
      handle.execute(command('run.submit', 'submit-2', {
        runId: 'run-2', sessionKey: 'native-1', provider: 'pi', profile: null, cwd: '/w', promptPreview: 'p'
      }))
      handle.execute(command('run.checkpoint', 'cp-2', { runId: 'run-2', ref: 'refs/scry/checkpoints/run-2', tree: 't2' }))
      handle.execute(command('run.effect_result', 'admit-2', { runId: 'run-2', step: 'admitted' }))
      expect(handle.execute(command('run.rollback', 'rb-live', { runId: 'run-2', ref: 'refs/scry/checkpoints/run-2' })))
        .toMatchObject({ kind: 'rejected', reason: 'illegal_transition' })
      expect(handle.getRun('run-2')?.lifecycle).toBe('admitted')
    } finally { handle.close() }
  })
})
