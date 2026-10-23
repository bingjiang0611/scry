import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAppSessionStore } from './app-store'
import { recoverQoderCatalogSessions } from './trace-catalog-recovery'
import { upsertTraceArchiveTurn } from './transcript-archive'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Qoder catalog recovery', () => {
  it('adds only archived Qoder sessions of known workspaces, once', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'scry-catalog-recovery-'))
    roots.push(userDataDir)
    const store = createAppSessionStore(userDataDir)
    store.record({ providerId: 'qoder', runtimeProvider: 'qoder_cli', runId: 'known-run', externalSessionId: 'known-session', cwd: '/known', prompt: 'known' })
    const write = (providerId: 'qoder' | 'codex', cwd: string, sessionId: string) => expect(upsertTraceArchiveTurn({
      cwd,
      sessionId,
      providerId,
      runtimeProvider: providerId === 'qoder' ? 'qoder_cli' : 'codex_cli',
      userDataDir,
      turn: { runId: `${sessionId}-run`, userText: `${sessionId} prompt`, items: [], done: true, ts: 1 }
    })).toBe(true)
    write('qoder', '/known', 'known-session')
    write('qoder', '/known', 'lost-session')
    // Archived evidence for an unknown workspace or another Provider must not become a project/session.
    write('qoder', '/archived-regression', 'regression-session')
    write('codex', '/known', 'codex-session')

    await expect(recoverQoderCatalogSessions(userDataDir, store)).resolves.toBe(1)
    expect(store.load().map((session) => [session.providerId, session.cwd, session.externalSessionId]).sort()).toEqual([
      ['qoder', '/known', 'known-session'],
      ['qoder', '/known', 'lost-session']
    ])
    await expect(recoverQoderCatalogSessions(userDataDir, store)).resolves.toBe(0)
  })
})
