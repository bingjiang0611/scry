import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    getAppPath: () => electronState.userData
  }
}))

import { deleteTurnOutboxSessionRows, recordTurn, turnOutboxSessionRunIds } from './db'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scry-db-outbox-'))
  electronState.userData = root
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('database turn outbox', () => {
  it('durably queues a complete turn when SQLite is unavailable', () => {
    const args = {
      runId: 'run-outbox',
      sessionId: 'session-outbox',
      cwd: '/repo',
      providerId: 'claude' as const,
      runtimeProvider: 'claude_sdk' as const,
      userText: 'persist me',
      items: [{
        id: 'result-run-outbox',
        runId: 'run-outbox',
        ts: new Date().toISOString(),
        kind: 'harness' as const,
        stage: 'result',
        tokensIn: 10,
        tokensOut: 2
      }]
    }
    expect(recordTurn(args)).toBe(false)
    expect(recordTurn(args)).toBe(false)
    const dir = join(root, 'db-turn-outbox')
    const files = readdirSync(dir).filter((name) => name.endsWith('.json'))
    expect(files).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))).toMatchObject({
      runId: 'run-outbox',
      sessionId: 'session-outbox',
      items: [expect.objectContaining({ stage: 'result', tokensIn: 10 })]
    })
  })

  it('finds and deletes only the exact deleted session outbox rows', () => {
    const queued = (runId: string, sessionId: string) => recordTurn({
      runId,
      sessionId,
      cwd: '/repo',
      providerId: 'qoder',
      runtimeProvider: 'qoder_cli',
      userText: 'persist me',
      items: [{
        id: `result-${runId}`, runId, ts: new Date().toISOString(),
        kind: 'harness', stage: 'result', tokensIn: 1
      }]
    })
    expect(queued('run-a', 'session-a')).toBe(false)
    expect(queued('run-b', 'session-b')).toBe(false)
    const identity = { providerId: 'qoder' as const, cwd: '/repo', externalSessionId: 'session-a' }

    expect(turnOutboxSessionRunIds(root, identity)).toEqual(['run-a'])
    expect(deleteTurnOutboxSessionRows(root, identity, new Set(['run-a', 'run-b']))).toEqual({
      failed: [], preservedInvalid: 0
    })
    expect(turnOutboxSessionRunIds(root, identity)).toEqual([])
    expect(turnOutboxSessionRunIds(root, {
      providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-b'
    })).toEqual(['run-b'])
  })

  it('fails closed when the outbox directory cannot be read', () => {
    const dir = join(root, 'db-turn-outbox')
    mkdirSync(dir)
    chmodSync(dir, 0o000)
    try {
      const result = deleteTurnOutboxSessionRows(
        root,
        { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-a' },
        new Set(['run-a'])
      )
      expect(result.failed).toEqual([
        expect.objectContaining({ path: dir, error: expect.stringMatching(/EACCES|permission denied/i) })
      ])
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('preserves and reports malformed outbox rows instead of treating them as absent', () => {
    recordTurn({
      runId: 'run-valid', sessionId: 'session-a', cwd: '/repo', providerId: 'qoder',
      userText: 'x', items: [{
        id: 'result-valid', runId: 'run-valid', ts: new Date().toISOString(),
        kind: 'harness', stage: 'result'
      }]
    })
    const malformed = join(root, 'db-turn-outbox', `${'f'.repeat(64)}.json`)
    writeFileSync(malformed, '{not json')

    expect(deleteTurnOutboxSessionRows(
      root,
      { providerId: 'qoder', cwd: '/repo', externalSessionId: 'session-a' },
      new Set(['run-valid'])
    )).toEqual({ failed: [], preservedInvalid: 1 })
    expect(readFileSync(malformed, 'utf8')).toBe('{not json')
  })
})
