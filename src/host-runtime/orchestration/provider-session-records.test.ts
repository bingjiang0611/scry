import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openOrchestrationDatabase } from './db'
import {
  readProviderSessions,
  recordProviderSessionNativeId,
  recordProviderSessionOpened,
  recordProviderSessionReleased
} from './provider-session-records'

function withDb(run: (db: ReturnType<typeof openOrchestrationDatabase>['db']) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'scry-provider-session-'))
  const handle = openOrchestrationDatabase({ userDataDir: dir })
  try {
    run(handle.db)
  } finally {
    handle.db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it('C1: an opened session is stored, and its release reason is readable afterwards', () => {
  withDb((db) => {
    recordProviderSessionOpened(db, {
      key: 'psession:a',
      provider: 'antigravity',
      nativeSessionId: 'native-1',
      at: 1_000
    })
    expect(readProviderSessions(db)).toEqual([
      {
        key: 'psession:a',
        provider: 'antigravity',
        sessionKey: null,
        nativeSessionId: 'native-1',
        openedAt: 1_000,
        lastUsedAt: 1_000,
        releasedAt: null,
        releaseReason: null
      }
    ])
    recordProviderSessionReleased(db, 'psession:a', 'idle', 2_000)
    expect(readProviderSessions(db)[0]).toMatchObject({ releasedAt: 2_000, releaseReason: 'idle' })
  })
})

it('C1: reopening the same key keeps the first open time and clears nothing', () => {
  withDb((db) => {
    recordProviderSessionOpened(db, {
      key: 'psession:a', provider: 'antigravity', nativeSessionId: 'n', at: 1_000
    })
    recordProviderSessionOpened(db, {
      key: 'psession:a', provider: 'antigravity', nativeSessionId: 'n', at: 5_000
    })
    const rows = readProviderSessions(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ openedAt: 1_000, lastUsedAt: 5_000, releasedAt: null })
  })
})

it('C1: the native session id is recorded once, after the Provider reports it', () => {
  withDb((db) => {
    recordProviderSessionOpened(db, { key: 'psession:a', provider: 'antigravity', at: 1_000 })
    expect(readProviderSessions(db)[0].nativeSessionId).toBeNull()
    recordProviderSessionNativeId(db, 'psession:a', 'native-1')
    recordProviderSessionNativeId(db, 'psession:a', 'native-2')
    expect(readProviderSessions(db)[0].nativeSessionId).toBe('native-1')
  })
})

it('C1: the first release reason wins, so a later eviction cannot rewrite history', () => {
  withDb((db) => {
    recordProviderSessionOpened(db, {
      key: 'psession:a', provider: 'pi', nativeSessionId: 'n', at: 1_000
    })
    recordProviderSessionReleased(db, 'psession:a', 'idle', 2_000)
    recordProviderSessionReleased(db, 'psession:a', 'evicted', 3_000)
    expect(readProviderSessions(db)[0]).toMatchObject({ releasedAt: 2_000, releaseReason: 'idle' })
  })
})

it('C1: the daemon status exposes each Provider session with its release reason', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { EventSink } = await import('./event-sink')
  const { buildAuthorityStatus } = await import('../../daemon/orchestration-authority-subscribe')
  const dir = mkdtempSync(join(tmpdir(), 'scry-provider-session-status-'))
  const sink = EventSink.open({ userDataDir: dir, fullfsync: false })
  try {
    recordProviderSessionOpened(sink.handle.db, {
      key: 'psession:a', provider: 'antigravity', nativeSessionId: 'native-1', at: 1_000
    })
    recordProviderSessionReleased(sink.handle.db, 'psession:a', 'idle', 2_000)
    expect(buildAuthorityStatus(sink).providerSessions).toEqual([
      {
        key: 'psession:a',
        provider: 'antigravity',
        nativeSessionId: 'native-1',
        openedAt: 1_000,
        releasedAt: 2_000,
        releaseReason: 'idle'
      }
    ])
  } finally {
    sink.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
