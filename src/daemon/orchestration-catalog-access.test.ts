import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAppSessionStore } from '../main/app-store'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

it('promotes the pending catalog row and keeps identical native IDs in separate Profiles', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-projected-catalog-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const catalog = createOrchestrationCatalogAccess(() => sink)
    const store = createAppSessionStore(userDataDir, catalog.beforeMirrorWrite)
    const cwd = '/tmp/中文工作区'
    const common = { providerId: 'codex' as const, runtimeProvider: 'codex_cli' as const, cwd, prompt: '第一条问题' }
    store.recordPending({ ...common, agentProfileId: 'one', runId: 'run-one' })
    expect(catalog.read()).toMatchObject([{ sessionId: 'run-one', externalSessionId: undefined }])
    store.record({ ...common, agentProfileId: 'one', runId: 'run-one', externalSessionId: 'native-id' })
    store.record({ ...common, agentProfileId: 'two', runId: 'run-two', externalSessionId: 'native-id' })
    expect(store.rename({ providerId: 'codex', agentProfileId: 'one', cwd, externalSessionId: 'native-id' }, '新的标题')).toBe(true)
    const rows = catalog.read()!
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.agentProfileId === 'one')).toMatchObject({ sessionId: 'native-id', title: '新的标题', runId: 'run-one' })
    expect(rows.find((row) => row.agentProfileId === 'two')).toMatchObject({ sessionId: 'native-id', title: undefined, runId: 'run-two' })
    const sessions = sink.listEvents().filter((event) => event.type === 'session.discovered')
    expect(sessions.map((event) => event.sessionKey)).toEqual(['run-one', 'run-one', 'native-id', 'run-one'])
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

it('removes an unbound provisional row without erasing its run or creating a user tombstone', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-pending-catalog-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const catalog = createOrchestrationCatalogAccess(() => sink)
    const store = createAppSessionStore(userDataDir, catalog.beforeMirrorWrite)
    const payload = {
      runId: 'rejected-before-binding', sessionKey: null, cwd: '/tmp/中文工作区',
      provider: 'codex', profile: null, claimMode: 'immediate' as const
    }
    expect(sink.execute({
      type: 'run.submit', commandId: 'submit', actor: 'system', scope: 'local', at: 1,
      payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    store.recordPending({ providerId: 'codex', runtimeProvider: 'codex_cli', cwd: payload.cwd, runId: payload.runId, prompt: '第一条问题' })
    expect(catalog.read()?.map(row => row.sessionId)).toEqual([payload.runId])
    store.remove({ providerId: 'codex', cwd: payload.cwd, externalSessionId: payload.runId })
    expect(catalog.read()).toEqual([])
    expect(sink.getSession(payload.runId)).toBeUndefined()
    expect(sink.getRun(payload.runId)).toBeDefined()
    expect(sink.listEvents().some(event => event.type === 'session.deleted')).toBe(false)
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
