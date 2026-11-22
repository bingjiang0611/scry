import 'reflect-metadata'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { SubscribeEngine } from '../host-runtime/orchestration/subscribe-engine'
import { SubscribeHub } from '../host-runtime/orchestration/subscribe-hub'
import { runSubscribeLoop } from '../main/daemon-event-pump-subscribe'
import type { SubscribeRequest } from '../shared/orchestration-subscribe'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'

afterEach(cleanupTempDirs)

it('delivers a provisional session withdrawal to the remote catalog and the local App pump', async () => {
  const sink = EventSink.open({ userDataDir: tempDir(), fullfsync: false })
  const hub = new SubscribeHub()
  const cwd = tempDir()
  const peer = 'a'.repeat(64)
  const app = 'b'.repeat(64)
  const engine = new SubscribeEngine({
    sink, hub, hostId: 'host', authorizePeer: () => undefined,
    grantScope: (id) => id === peer ? 'remote' : 'local',
    remoteCwdAuthorizer: () => (path) => path === cwd
  })
  const sessionKey = 'provisional'
  const request: SubscribeRequest = { views: ['sessions', 'activeRuns'], waitMs: 0 }
  try {
    const catalog = { nativeSessionId: null, runtimeProvider: 'codex_cli', preview: 'pending', projectCwd: cwd } as const
    const discover = { sessionKey, provider: 'codex', profile: null, cwd, catalog }
    expect(sink.execute({
      type: 'session.discover', commandId: 'discover', actor: 'system', scope: 'system',
      at: Date.now(), payload: discover, payloadSha256: sha256Hex(canonicalJson(discover))
    }).kind).toBe('accepted')
    const snapshot = await engine.subscribe(peer, request)
    const localBefore = await engine.subscribe(app, request)
    expect(snapshot).toMatchObject({ mode: 'snapshot', snapshot: { sessions: { rows: [{ sessionKey }] } } })
    const payload = { sessionKey }
    expect(sink.execute({
      type: 'session.withdraw', commandId: 'withdraw', actor: 'system', scope: 'system',
      at: Date.now(), payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    const delta = await engine.subscribe(peer, {
      ...request, known: { hostId: snapshot.hostId, logId: snapshot.logId, seq: snapshot.seq }
    })
    expect(delta).toMatchObject({ mode: 'events', events: [{ type: 'session.withdrawn', sessionKey, sessionRow: null }] })
    expect(await engine.subscribe(peer, request)).toMatchObject({ mode: 'snapshot', snapshot: { sessions: { rows: [] } } })

    const stop = new AbortController()
    const send = vi.fn()
    let polls = 0
    await runSubscribeLoop({
      signal: stop.signal, waitMs: 0, retry: { initialMs: 1, maxMs: 1 }, sleep: async () => {}, send,
      subscribe: async (input) => {
        if (++polls === 1) return localBefore
        if (polls === 3) stop.abort()
        return engine.subscribe(app, input)
      }
    })
    expect(send).toHaveBeenCalledWith('agent:dataUpdated', { kind: 'catalog_recovered' })
  } finally {
    hub.close()
    sink.close()
  }
})
