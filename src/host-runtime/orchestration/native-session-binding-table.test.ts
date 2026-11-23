import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { deletedNativeSessionKey, findNativeSession, scopedNativeSessionKey, wasNativeSourceDeleted } from './native-session-lookup'
import { bindNativeSession } from './native-session-bindings'

const identity = { sessionId: 'native-1', provider: 'codex', profile: 'work', cwd: '/tmp/ws' }

function withSink(run: (sink: EventSink) => void): void {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-b3-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    run(sink)
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function importSession(sink: EventSink, payload: Record<string, unknown>, commandId: string): void {
  const encoded = canonicalJson(payload)
  expect(
    sink.execute({
      type: 'session.import',
      commandId,
      actor: 'system',
      scope: 'system',
      at: 10,
      payload: payload as never,
      payloadSha256: sha256Hex(encoded)
    }).kind
  ).toBe('accepted')
}

describe('B3: native identity binding table', () => {
  it('allocates one binding per native identity and refuses a second session key', () => {
    withSink((sink) => {
      const key = scopedNativeSessionKey(identity)
      importSession(
        sink,
        {
          sessionKey: key,
          cwd: identity.cwd,
          provider: identity.provider,
          profile: identity.profile,
          ts: 10,
          catalog: { nativeSessionId: identity.sessionId, projectCwd: null, preview: null }
        },
        'b3-import-1'
      )
      expect(findNativeSession(sink, identity)?.sessionKey).toBe(key)

      const rows = sink.handle.db
        .prepare('SELECT provider, profile, cwd, native_id, session_key FROM orch_binding')
        .all() as Array<Record<string, string>>
      expect(rows).toEqual([
        { provider: 'codex', profile: 'work', cwd: '/tmp/ws', native_id: 'native-1', session_key: key }
      ])

      // A second key for the same identity violates UNIQUE(provider, profile, cwd, native_id).
      expect(() => bindNativeSession(sink, identity, 'another-key')).toThrow(
        expect.objectContaining({ code: 'orchestration_binding_conflict' })
      )
      // Re-binding the same pair is idempotent.
      expect(bindNativeSession(sink, identity, key)).toBe(key)
    })
  })

  it('treats two matching rows as an error instead of allocating a new key', () => {
    withSink((sink) => {
      const key = scopedNativeSessionKey(identity)
      importSession(
        sink,
        {
          sessionKey: key,
          cwd: identity.cwd,
          provider: identity.provider,
          profile: identity.profile,
          ts: 10,
          catalog: { nativeSessionId: identity.sessionId, projectCwd: null, preview: null }
        },
        'b3-import-dup'
      )
      // Simulate legacy data that predates the binding table: no binding row, two projections.
      sink.handle.db.prepare('DELETE FROM orch_binding').run()
      sink.handle.db
        .prepare(
          `INSERT INTO orch_p_session (session_key, provider, profile, cwd, title, ts, legacy, rev_seq, created_by, catalog, conversation_id)
           VALUES ('dup-key', 'codex', 'work', '/tmp/ws', 'dup', 11, 0, 11, 'system', ?, NULL)`
        )
        .run(canonicalJson({ nativeSessionId: 'native-1', projectCwd: null, preview: null }))

      expect(() => findNativeSession(sink, identity)).toThrow(
        expect.objectContaining({ code: 'orchestration_binding_ambiguous' })
      )
    })
  })

  it('records the tombstone in the binding table so a deleted session cannot revive', () => {
    withSink((sink) => {
      const key = scopedNativeSessionKey(identity)
      importSession(
        sink,
        {
          sessionKey: key,
          cwd: identity.cwd,
          provider: identity.provider,
          profile: identity.profile,
          ts: 10,
          catalog: { nativeSessionId: identity.sessionId, projectCwd: null, preview: null }
        },
        'b3-import-tombstone'
      )
      expect(
        sink.deleteSession({
          sessionKey: key,
          cwd: identity.cwd!,
          actor: 'system',
          scope: 'system',
          at: 20,
          nativeIdentity: key,
          nativeSource: scopedNativeSessionKey({ ...identity, profile: null })
        })
      ).toMatchObject({ status: 'deleted' })

      // The tombstone lives in the binding table, not only in the event log.
      const row = sink.handle.db
        .prepare('SELECT deleted_at FROM orch_binding WHERE session_key = ?')
        .get(key) as { deleted_at: number | null } | undefined
      expect(row?.deleted_at).toBe(20)
      expect(deletedNativeSessionKey(sink, identity)).toBe(key)
      expect(wasNativeSourceDeleted(sink, identity)).toBe(true)
      expect(findNativeSession(sink, identity)).toBeUndefined()

      // Re-importing the same native session key must not resurrect the deleted session.
      importSession(
        sink,
        {
          sessionKey: key,
          cwd: identity.cwd,
          provider: identity.provider,
          profile: identity.profile,
          ts: 30,
          catalog: { nativeSessionId: identity.sessionId, projectCwd: null, preview: null }
        },
        'b3-import-again'
      )
      expect(findNativeSession(sink, identity)).toBeUndefined()
      expect(wasNativeSourceDeleted(sink, identity)).toBe(true)
    })
  })
})
