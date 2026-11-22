import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { transcriptPath } from '../main/transcript-archive'
import { createAppSessionStore } from '../main/app-store'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createCatalogScanWork } from './orchestration-catalog-scan'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

it('discovers an external session and reads only the appended interval when its detail changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scry-daemon-catalog-scan-'))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  mkdirSync(join(root, '中文项目'))
  const cwd = realpathSync(join(root, '中文项目'))
  const sessionId = '43a699f3-f027-4e92-970e-021772d5d7b8'
  const transcript = transcriptPath(cwd, sessionId, homeDir)
  mkdirSync(dirname(transcript), { recursive: true })
  const line = (text: string) => `${JSON.stringify({ cwd, sessionId, type: 'user', message: { role: 'user', content: text } })}\n`
  const first = line('先写入的消息')
  const next = line('后续消息')
  writeFileSync(transcript, first)
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    let active = false
    const createWork = () => createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => active, log: (message) => { throw new Error(message) }
    })
    const work = createWork()
    await work.scanCatalog()
    const discovered = sink.listEvents().find((event) => event.type === 'session.discovered')!
    expect(discovered).toMatchObject({ cwd, payload: { provider: 'claude', catalog: { nativeSessionId: sessionId } } })
    expect(discovered.evidence).toEqual([
      `transcript:claude:${sessionId}#bytes=0-${Buffer.byteLength(first)},sha256=${sha256Hex(first)}`
    ])
    await work.scanDetail(discovered.sessionKey!, true)
    expect(sink.listEvents()).toHaveLength(1)
    appendFileSync(transcript, next)
    active = true
    await work.scanDetail(discovered.sessionKey!, false)
    expect(sink.listEvents()).toHaveLength(1)
    active = false
    await work.scanDetail(discovered.sessionKey!, false)
    const end = Buffer.byteLength(first + next)
    expect(sink.listEvents().at(-1)?.evidence).toEqual([
      `transcript:claude:${sessionId}#bytes=${Buffer.byteLength(first)}-${end},sha256=${sha256Hex(next)}`
    ])
    await work.scanDetail(discovered.sessionKey!, false)
    expect(sink.listEvents()).toHaveLength(2)
    const reopened = createWork()
    await reopened.scanCatalog()
    expect(sink.listEvents()).toHaveLength(2)
    const afterRestart = line('重启后的消息')
    appendFileSync(transcript, afterRestart)
    await reopened.scanDetail(discovered.sessionKey!, true)
    expect(sink.listEvents().at(-1)?.evidence).toEqual([
      `transcript:claude:${sessionId}#bytes=${end}-${end + Buffer.byteLength(afterRestart)},sha256=${sha256Hex(afterRestart)}`
    ])
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('does not recover a deleted native transcript session whose projection used the provisional run key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'scry-deleted-native-scan-'))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  mkdirSync(join(root, '中文项目'))
  const cwd = realpathSync(join(root, '中文项目'))
  const sessionId = '43a699f3-f027-4e92-970e-021772d5d7b8'
  const transcript = transcriptPath(cwd, sessionId, homeDir)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify({ cwd, sessionId, type: 'user', message: { role: 'user', content: '原始内容' } })}\n`)
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const access = createOrchestrationCatalogAccess(() => sink)
    const app = createAppSessionStore(userDataDir, access.beforeMirrorWrite)
    const context = { cwd, providerId: 'claude' as const, agentProfileId: 'work' }
    const run = { ...context, runId: 'provisional-key', runtimeProvider: 'claude_sdk' as const, prompt: '问题' }
    app.recordPending(run)
    app.record({ ...run, externalSessionId: sessionId })
    expect(sink.getSession('provisional-key')?.catalog?.nativeSessionId).toBe(sessionId)
    expect(access.deleteNative({ ...context, externalSessionId: sessionId }, new Set()).status).toBe('deleted')
    const tombstone = sink.listEvents().at(-1)
    expect(tombstone).toMatchObject({ type: 'session.deleted', sessionKey: 'provisional-key', cwd })

    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => false, log: (message) => { throw new Error(message) }
    })
    await work.scanCatalog()
    expect(sink.listEvents().at(-1)).toEqual(tombstone)
    expect(access.read()).toEqual([])
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['new projection', 'v5 upgrade'])('counts after recorded transcript history in a %s', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-scan-ordinal-')))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  const cwd = join(root, 'workspace')
  const nativeSessionId = '43a699f3-f027-4e92-970e-021772d5d7b8'
  const transcript = transcriptPath(cwd, nativeSessionId, homeDir)
  mkdirSync(cwd)
  mkdirSync(dirname(transcript), { recursive: true })
  writeFileSync(transcript, JSON.stringify({
    cwd, sessionId: nativeSessionId, type: 'user', message: { role: 'user', content: '先前的消息' }
  }) + '\n')
  const open = () => EventSink.open({ userDataDir, fullfsync: false })
  let sink = open()
  try {
    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => false, log: (message) => { throw new Error(message) }
    })
    await work.scanCatalog()
    const [discovered] = sink.listEvents()
    expect(discovered).toMatchObject({ type: 'session.discovered', payload: { transcript: { status: 'available' } } })
    const sessionKey = discovered!.sessionKey!
    const submit = (runId: string) => {
      const payload = {
        runId, sessionKey: null, cwd, provider: 'claude', profile: null,
        claimMode: 'immediate' as const, dispatchImmediately: true
      }
      expect(sink.execute({
        type: 'run.submit', commandId: `submit:${runId}`, actor: 'system', scope: 'system', at: 20,
        payload, payloadSha256: sha256Hex(canonicalJson(payload))
      }).kind).toBe('accepted')
    }
    const bind = (runId: string, sourceId: string) => {
      const payload = { runId, step: 'session_bound' as const, nativeSessionId: sourceId, attachNative: true as const }
      expect(sink.execute({
        type: 'run.effect_result', commandId: `bind:${runId}`, actor: 'system', scope: 'system', at: 21,
        payload, payloadSha256: sha256Hex(canonicalJson(payload))
      }).kind).toBe('accepted')
    }

    const freshId = '7bb91f84-32b0-4af7-80e9-27eb488534bd'
    submit('fresh-run')
    bind('fresh-run', freshId)
    const freshTranscript = transcriptPath(cwd, freshId, homeDir)
    writeFileSync(freshTranscript, JSON.stringify({
      cwd, sessionId: freshId, type: 'user', message: { role: 'user', content: '已投影的第一轮' }
    }) + '\n')
    await work.scanCatalog()
    expect(sink.listEvents().at(-1)).toMatchObject({
      type: 'session.discovered', sessionKey: freshId, payload: { transcript: { status: 'available' } }
    })
    expect(sink.getSession(freshId)?.legacy).toBe(false)

    if (mode === 'v5 upgrade') {
      sink.handle.db.prepare('UPDATE orch_p_session SET legacy = 0 WHERE session_key = ?').run(sessionKey)
      sink.handle.db.pragma('user_version = 5')
      sink.close()
      sink = open()
    }

    submit('existing-run')
    bind('existing-run', nativeSessionId)
    expect(sink.getTurn(sessionKey, 1)).toMatchObject({ runId: 'existing-run', ordinalOrigin: 'since_import' })
    expect(sink.getSession(freshId)?.legacy).toBe(false)
    expect(sink.getTurn(freshId, 1)).toMatchObject({ runId: 'fresh-run', ordinalOrigin: 'native' })
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})
