import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'

it('links a dispatched native run to the scoped legacy session on binding and counts from import', () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scry-projected-binding-'))
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const cwd = '/tmp/中文目录'
    const nativeSessionId = 'native-id'
    const sessionKey = 'scoped-legacy'
    const imported = {
      sessionKey, cwd, provider: 'codex', profile: 'work', ts: 10,
      catalog: { nativeSessionId, projectCwd: null, preview: null, runtimeProvider: 'codex_cli' as const }
    }
    expect(sink.execute({
      type: 'session.import', commandId: 'import', actor: 'system', scope: 'system', at: 10,
      payload: imported, payloadSha256: sha256Hex(canonicalJson(imported))
    }).kind).toBe('accepted')
    const submitted = {
      runId: 'execution-run', sessionKey: null, cwd, provider: 'codex', profile: 'work',
      claimMode: 'immediate' as const, dispatchImmediately: true, promptPreview: '新问题'
    }
    expect(sink.execute({
      type: 'run.submit', commandId: 'start', actor: 'system', scope: 'local', at: 11,
      payload: submitted, payloadSha256: sha256Hex(canonicalJson(submitted))
    }).kind).toBe('accepted')
    const bound = { runId: submitted.runId, step: 'session_bound' as const, nativeSessionId, attachNative: true as const }
    expect(sink.execute({
      type: 'run.effect_result', commandId: 'bound', actor: 'effect:native-bind', scope: 'system', at: 12,
      payload: bound, payloadSha256: sha256Hex(canonicalJson(bound))
    }).kind).toBe('accepted')

    expect(sink.getRun(submitted.runId)?.sessionKey).toBe(sessionKey)
    expect(sink.getSession(sessionKey)).toMatchObject({ legacy: true, activeRunId: submitted.runId })
    expect(sink.getTurn(sessionKey, 1)).toMatchObject({
      runId: submitted.runId, ordinalOrigin: 'since_import', userTextPreview: '新问题'
    })
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
