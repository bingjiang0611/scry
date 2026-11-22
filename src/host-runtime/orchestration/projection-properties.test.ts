import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import type { OrchestrationCommand } from './orchestrator'
import { SubscribeEngine } from './subscribe-engine'
import { SubscribeHub } from './subscribe-hub'

function withStore(run: (sink: EventSink, root: string) => void | Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-orch-replay-')))
  const sink = EventSink.open({ userDataDir: root, fullfsync: false, checkpointIntervalMs: 0 })
  return Promise.resolve().then(() => run(sink, root)).finally(() => {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  })
}

type Command = OrchestrationCommand extends infer C
  ? C extends OrchestrationCommand ? Pick<C, 'type' | 'payload'> : never
  : never

function apply(sink: EventSink, at: number, command: Command) {
  return sink.execute({
    ...command, commandId: `generated:${at}`, actor: 'system',
    scope: 'system', at, payloadSha256: sha256Hex(canonicalJson(command.payload))
  })
}

it.each([0x1421, 0x712f, 0x1ed41, 0x923f247])('replays every projection field across mixed commands (seed %i)', async (seed) => {
  await withStore((sink, cwd) => {
    let state = seed
    const choose = (limit: number): number => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % limit
    }
    const sessions = Array.from({ length: 4 }, (_, index) => `session-${index}`)
    for (const [index, sessionKey] of sessions.entries()) {
      expect(apply(sink, index + 1, { type: 'session.create', payload: { sessionKey, cwd, provider: 'codex' } }).kind).toBe('accepted')
    }
    const nativeSessionId = 'bound-native-session'
    let pendingBind: string | undefined
    let accepted = 0
    for (let at = 10; at < 150; at++) {
      const sessionKey = sessions[choose(sessions.length)]!
      const session = sink.getSession(sessionKey)
      const active = session?.activeRunId
      const provisional = `provisional-${choose(3)}`
      const boundRunId = sink.getSession(nativeSessionId)?.activeRunId
      const choices: Array<Command | 'delete'> = [
        { type: 'session.rename', payload: { sessionKey, title: `会话 ${choose(1_000)}` } },
        { type: 'session.pin', payload: { sessionKey } },
        { type: 'session.unpin', payload: { sessionKey } },
        { type: 'session.archive', payload: { sessionKey } },
        { type: 'session.restore', payload: { sessionKey } },
        { type: 'session.discover', payload: {
          sessionKey, cwd, provider: 'codex',
          catalog: { nativeSessionId: `native-${sessionKey}`, projectCwd: cwd, preview: `preview ${at}`, runtimeProvider: 'codex_cli' }
        } },
        { type: 'session.import', payload: { sessionKey, cwd, provider: 'codex', title: `imported ${at}`, ts: at } },
        sink.getSession(provisional)
          ? { type: 'session.withdraw', payload: { sessionKey: provisional } }
          : { type: 'session.discover', payload: {
            sessionKey: provisional, cwd, provider: 'codex',
            catalog: { nativeSessionId: null, projectCwd: cwd, preview: null, runtimeProvider: 'codex_cli' }
          } },
        { type: 'run.submit', payload: {
          runId: `run-${at}`, sessionKey, cwd, provider: 'codex', profile: null, claimMode: 'immediate',
          dispatchImmediately: true, promptPreview: `question ${at}`
        } },
        { type: 'run.effect_result', payload: { runId: active ?? 'absent', step: choose(2) ? 'failed' : 'settled' } }
      ]
      if (session && !active) choices.push('delete')
      if (boundRunId) {
        choices.push({ type: 'run.effect_result', payload: { runId: boundRunId, step: 'settled' } })
      } else if (pendingBind) {
        choices.push({ type: 'run.effect_result', payload: {
          runId: pendingBind, step: 'session_bound', nativeSessionId, attachNative: true,
          catalogRunId: `app-${pendingBind}`
        } })
      } else {
        choices.push({ type: 'run.submit', payload: {
          runId: `unbound-${at}`, sessionKey: null, cwd, provider: 'codex', profile: null,
          claimMode: 'immediate', dispatchImmediately: true
        } })
      }
      const command = choices[choose(choices.length)]!
      const before = sink.listEvents().length
      if (command === 'delete') {
        expect(sink.deleteSession({ sessionKey, cwd, actor: 'system', scope: 'system', at }).status).toBe('deleted')
        expect(sink.getSession(sessionKey)).toBeUndefined()
        accepted += 1
      } else {
        const result = apply(sink, at, command)
        if (result.kind === 'accepted') {
          accepted += 1
          if (command.type === 'run.submit' && command.payload.sessionKey === null) {
            pendingBind = command.payload.runId
          }
          if (command.type === 'run.effect_result' && command.payload.step === 'session_bound') {
            expect(sink.getRun(command.payload.runId)).toMatchObject({
              appRunId: command.payload.catalogRunId, sessionKey: nativeSessionId
            })
            pendingBind = undefined
          }
        } else expect(sink.listEvents()).toHaveLength(before)
      }
      if (at % 11 === 0) expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
    }
    expect(accepted).toBeGreaterThan(40)
    const events = sink.listEvents()
    expect(events.some(event => event.type === 'turn.began')).toBe(true)
    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'session.imported', 'session.deleted', 'session.withdrawn'
    ]))
    expect(events.find(event => event.type === 'run.session_bound')).toMatchObject({
      payload: { attachNative: true, appRunId: expect.any(String) }
    })
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  })
})

it('delivers a tombstone to the remote subscriber that could see the deleted row', async () => {
  await withStore(async (sink, root) => {
    const visible = join(root, 'visible')
    const hidden = join(root, 'hidden')
    for (const [index, cwd] of [visible, hidden].entries()) {
      expect(apply(sink, index + 1, { type: 'session.create', payload: { sessionKey: cwd, cwd, title: 'Private preview' } }).kind).toBe('accepted')
    }
    const hub = new SubscribeHub()
    let requestCount = 0
    const engine = new SubscribeEngine({
      sink, hub, hostId: 'host', grantScope: () => 'remote',
      authorizePeer: () => { requestCount += 1 },
      remoteCwdAuthorizer: () => cwd => cwd === visible
    })
    try {
      const views = ['sessions' as const]
      const snapshot = await engine.subscribe('remote', { views, waitMs: 0 })
      expect(snapshot).toMatchObject({ mode: 'snapshot', snapshot: { sessions: { rows: [expect.objectContaining({ cwd: visible })] } } })
      for (const cwd of [visible, hidden]) {
        expect(sink.deleteSession({ sessionKey: cwd, cwd, actor: 'system', scope: 'system', at: 10 }).status).toBe('deleted')
      }
      const { hostId, logId, seq } = snapshot
      const next = await engine.subscribe('remote', { views, known: { hostId, logId, seq }, waitMs: 0 })
      expect(next).toMatchObject({ mode: 'events', events: [{ type: 'session.deleted', cwd: visible, payload: { sessionKey: visible } }] })
      expect(JSON.stringify(next)).not.toContain('Private preview')
      expect(requestCount).toBe(2)
    } finally {
      hub.close()
    }
  })
})
