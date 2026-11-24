import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { readProviderSessions } from '../host-runtime/orchestration/provider-session-records'
import { createProcessSessionObserver } from './provider-session-recording'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

// C1: Pi keeps its own pool, so its open and release have to land in the same table as
// Antigravity's. A missing sink is not a write: the row simply is not recorded.

describe('Pi session recording', () => {
  it('stores the open session, its native id and the release reason', () => {
    const userData = mkdtempSync(join(tmpdir(), 'scry-pi-sessions-'))
    dirs.push(userData)
    const sink = EventSink.open({ userDataDir: userData })
    try {
      const observer = createProcessSessionObserver(() => sink)
      observer.onOpened('pi:native-1', 'pi', 1_700_000_000_000)
      observer.onNativeSessionId('pi:native-1', 'native-1')
      observer.onReleased('pi:native-1', 'idle', 1_700_000_600_000)
      const rows = readProviderSessions(sink.handle.db)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        key: 'pi:native-1',
        provider: 'pi',
        nativeSessionId: 'native-1',
        releaseReason: 'idle'
      })
    } finally { sink.close() }
  })

  it('records nothing while the authority is unavailable', () => {
    const observer = createProcessSessionObserver(() => undefined)
    expect(() => observer.onOpened('pi:native-2', 'pi', 1)).not.toThrow()
    expect(() => observer.onReleased('pi:native-2', 'evicted', 2)).not.toThrow()
  })
})
