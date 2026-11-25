import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { recordSessionMetadata, type SessionMetadataChange } from './orchestration-session-metadata'

const PEER = `peer:${'b'.repeat(64)}`
let dirs: string[] = []

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sinkWithSession(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d4-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData, authorizedActors: [PEER] })
  const payload = {
    sessionKey: 'native-1',
    provider: 'codex',
    profile: null,
    cwd: '/tmp/ws',
    title: 'before',
    ts: 1,
    catalog: { nativeSessionId: 'native-1', projectCwd: '/tmp/ws', preview: null }
  }
  sink.execute({
    type: 'session.import',
    commandId: 'import-1',
    actor: 'system',
    scope: 'system',
    at: 1,
    payload: payload as never,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  return sink
}

const ref = { externalSessionId: 'native-1', providerId: 'codex' as const, agentProfileId: undefined, cwd: '/tmp/ws' }

// D4: rename, pin, archive and delete used to change the catalog file only, so the projection and
// every device kept showing the old title. Each change is now an event whose actor is the real
// caller, and the projection applies it.

describe('D4: metadata changes are events with the real actor', () => {
  it('records a rename with the device as actor and applies it to the projection', () => {
    const sink = sinkWithSession()
    try {
      const result = recordSessionMetadata(sink, {
        ...ref, change: { kind: 'rename', title: 'after' }, actor: PEER
      }, 1_700_000_000_000)
      expect(result.status).toBe('recorded')
      expect(sink.getSession('native-1')?.title).toBe('after')
      const event = sink.listEvents().find((row) => row.type === 'session.renamed')
      expect(event?.actor).toBe(PEER)
    } finally { sink.close() }
  })

  it('records pin, unpin, archive and restore against the same session', () => {
    const sink = sinkWithSession()
    try {
      const changes: SessionMetadataChange[] = [
        { kind: 'pin', pinned: true },
        { kind: 'pin', pinned: false },
        { kind: 'archive', archived: true },
        { kind: 'archive', archived: false }
      ]
      for (const [index, change] of changes.entries()) {
        expect(recordSessionMetadata(sink, { ...ref, change, actor: PEER }, 1_700_000_001_000 + index).status)
          .toBe('recorded')
      }
      const session = sink.getSession('native-1')
      expect(session?.pinnedAt ?? null).toBeNull()
      expect(session?.archivedAt ?? null).toBeNull()
      const types = sink.listEvents().map((row) => row.type)
      expect(types).toEqual(expect.arrayContaining([
        'session.pinned', 'session.unpinned', 'session.archived', 'session.restored'
      ]))
    } finally { sink.close() }
  })

  it('does not invent a row for a session the projection does not know', () => {
    const sink = sinkWithSession()
    try {
      const result = recordSessionMetadata(sink, {
        ...ref, externalSessionId: 'missing', change: { kind: 'rename', title: 'x' }, actor: PEER
      }, 1_700_000_002_000)
      expect(result).toEqual({ status: 'unavailable', reason: 'session_not_found' })
      expect(sink.listEvents().some((row) => row.type === 'session.renamed')).toBe(false)
    } finally { sink.close() }
  })
})
