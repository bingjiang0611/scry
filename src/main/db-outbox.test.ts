import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
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

import { recordTurn } from './db'

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
})
