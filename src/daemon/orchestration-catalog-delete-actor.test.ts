import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

const PEER = `peer:${'c'.repeat(64)}`
let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function sinkWithSession(): EventSink {
  const userData = mkdtempSync(join(tmpdir(), 'scry-d4-del-'))
  dirs.push(userData)
  const sink = EventSink.open({ userDataDir: userData })
  const payload = {
    sessionKey: 'native-1',
    provider: 'codex',
    profile: null,
    cwd: '/tmp/ws',
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

// D4: a delete asked for by a device must name that device on the tombstone event, not the host.

describe('D4: delete records the caller', () => {
  it('records the device as the actor of the tombstone', () => {
    const sink = sinkWithSession()
    try {
      const access = createOrchestrationCatalogAccess(() => sink)
      const outcome = access.deleteNative(
        { providerId: 'codex', cwd: '/tmp/ws', externalSessionId: 'native-1' } as never,
        new Set(),
        PEER
      )
      expect(outcome.status).toBe('deleted')
      const event = sink.listEvents().find((row) => row.type === 'session.deleted')
      expect(event?.actor).toBe(PEER)
      expect(sink.getSession('native-1')).toBeUndefined()
    } finally { sink.close() }
  })

  it('keeps the host actor when no caller is given', () => {
    const sink = sinkWithSession()
    try {
      const access = createOrchestrationCatalogAccess(() => sink)
      access.deleteNative({ providerId: 'codex', cwd: '/tmp/ws', externalSessionId: 'native-1' } as never, new Set())
      expect(sink.listEvents().find((row) => row.type === 'session.deleted')?.actor).toBe('system')
    } finally { sink.close() }
  })
})
