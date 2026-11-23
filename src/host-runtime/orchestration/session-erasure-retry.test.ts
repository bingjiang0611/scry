import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { INLINE_BODY_MAX_BYTES } from './types'

it('retries a body erase after only the SQLite part of deletion completed', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-body-erase-retry-'))
  let sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const body = sink.bodyStore.prepareBody('a'.repeat(INLINE_BODY_MAX_BYTES + 1))
    const payload = {
      runId: 'run-a', sessionKey: 'session-a', provider: 'codex', profile: null, cwd: '/tmp/工作区',
      claimMode: 'immediate' as const, body
    }
    expect(sink.execute({
      type: 'run.submit', commandId: 'submit', actor: 'system', scope: 'system', at: 1,
      payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    const deletion = { sessionKey: 'session-a', cwd: payload.cwd, actor: 'system', scope: 'system' as const, at: 2 }
    vi.spyOn(sink.bodyStore, 'unlinkBody').mockImplementationOnce(() => { throw new Error('erase temporarily blocked') })
    expect(sink.deleteSession(deletion)).toMatchObject({ status: 'unavailable' })
    expect(sink.bodyStore.hasExternalBody(body.sha256)).toBe(true)
    sink.close()
    sink = EventSink.open({ userDataDir, fullfsync: false })
    expect(sink.bodyStore.hasExternalBody(body.sha256)).toBe(false)
    expect(sink.getSession('session-a')).toBeUndefined()
    expect(sink.listEvents().filter((event) => event.type === 'session.deleted')).toHaveLength(1)
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
