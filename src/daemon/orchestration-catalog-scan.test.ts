import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { transcriptPath } from '../main/transcript-archive'
import { createAppSessionStore } from '../main/app-store'
import { piNativeSessionDirectory } from '../main/pi-native-history'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createCatalogScanWork } from './orchestration-catalog-scan'
import { createOrchestrationCatalogAccess } from './orchestration-catalog-access'

it('follows a session Scry knows and reads only the appended interval when its detail changes', async () => {
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
    const access = createOrchestrationCatalogAccess(() => sink)
    const app = createAppSessionStore(userDataDir, access.beforeMirrorWrite)
    const run = { cwd, providerId: 'claude' as const, runId: 'scry-run', runtimeProvider: 'claude_sdk' as const, prompt: '问题' }
    app.recordPending(run)
    app.record({ ...run, externalSessionId: sessionId })
    const base = sink.listEvents().length
    const work = createWork()
    await work.scanCatalog()
    const discovered = sink.listEvents().at(-1)!
    expect(discovered).toMatchObject({ type: 'session.discovered', cwd, payload: { provider: 'claude' } })
    expect(sink.getSession(discovered.sessionKey!)?.catalog?.nativeSessionId).toBe(sessionId)
    expect(discovered.evidence).toEqual([
      `transcript:claude:${sessionId}#bytes=0-${Buffer.byteLength(first)},sha256=${sha256Hex(first)}`
    ])
    await work.scanDetail(discovered.sessionKey!, true)
    expect(sink.listEvents()).toHaveLength(base + 1)
    appendFileSync(transcript, next)
    active = true
    await work.scanDetail(discovered.sessionKey!, false)
    expect(sink.listEvents()).toHaveLength(base + 1)
    active = false
    await work.scanDetail(discovered.sessionKey!, false)
    const end = Buffer.byteLength(first + next)
    expect(sink.listEvents().at(-1)?.evidence).toEqual([
      `transcript:claude:${sessionId}#bytes=${Buffer.byteLength(first)}-${end},sha256=${sha256Hex(next)}`
    ])
    await work.scanDetail(discovered.sessionKey!, false)
    expect(sink.listEvents()).toHaveLength(base + 2)
    // B4: one receipt per session+frontier, and none keyed on a projector revision, so a
    // revision bump cannot spawn an extra permanent receipt.
    const scanReceipts = sink.handle.db
      .prepare("SELECT command_id FROM orch_command WHERE command_id LIKE 'catalog-scan:%' ORDER BY command_id")
      .pluck()
      .all() as string[]
    expect(scanReceipts).toHaveLength(2)
    for (const commandId of scanReceipts) {
      expect(commandId).toBe(`catalog-scan:${discovered.sessionKey}:${commandId.split(':').at(-1)}`)
      expect(commandId.split(':')).toHaveLength(3)
    }
    await work.scanDetail(discovered.sessionKey!, false)
    expect(
      sink.handle.db.prepare("SELECT COUNT(*) FROM orch_command WHERE command_id LIKE 'catalog-scan:%'").pluck().get()
    ).toBe(2)
    const reopened = createWork()
    await reopened.scanCatalog()
    expect(sink.listEvents()).toHaveLength(base + 2)
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

it.each(['new projection', 'v5 upgrade', 'v5 pruned'])('counts after recorded transcript history in a %s', async (mode) => {
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
    // Scry already lists this session; the scan only adds its transcript evidence.
    const seed = {
      sessionKey: 'known-session', provider: 'claude', profile: null, cwd,
      catalog: { nativeSessionId, projectCwd: null, preview: '先前的消息', runtimeProvider: 'claude_sdk' as const }
    }
    expect(sink.execute({
      type: 'session.discover', commandId: 'seed-known', actor: 'system', scope: 'system', at: 10,
      payload: seed, payloadSha256: sha256Hex(canonicalJson(seed))
    }).kind).toBe('accepted')
    await work.scanCatalog()
    const discovered = sink.listEvents().at(-1)
    expect(discovered).toMatchObject({ type: 'session.discovered', sessionKey: 'known-session', payload: { transcript: { status: 'available' } } })
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

    if (mode === 'v5 pruned') {
      const payload = { sessionKey, title: '保留标题' }
      expect(sink.execute({
        type: 'session.rename', commandId: 'rename', actor: 'system', scope: 'system', at: Date.now(),
        payload, payloadSha256: sha256Hex(canonicalJson(payload))
      }).kind).toBe('accepted')
      expect(sink.pruneEvents({ olderThanAt: Date.now() + 60_000 }).deletedEvents).toBeGreaterThan(0)
      expect(sink.listEvents()).not.toContainEqual(expect.objectContaining({ type: 'session.discovered', sessionKey }))
      expect(sink.listEvents()).not.toContainEqual(expect.objectContaining({ type: 'turn.began', sessionKey: freshId }))
      expect(sink.getTurn(freshId, 1)?.ordinalOrigin).toBe('native')
    }
    if (mode !== 'new projection') {
      const savedRevision = sink.getSession(sessionKey)?.revSeq
      sink.handle.db.prepare('UPDATE orch_p_session SET legacy = 0 WHERE session_key = ?').run(sessionKey)
      // Reconstruct a real v5 database so reopening exercises the V6–V8 migrations.
      sink.handle.db.exec(`
        DROP TABLE IF EXISTS orch_binding;
        DROP TABLE IF EXISTS orch_provider_session;
        DROP INDEX IF EXISTS idx_orch_p_run_queue;
        ALTER TABLE orch_p_run DROP COLUMN queue_position;
        ALTER TABLE orch_p_run DROP COLUMN queue_held;
        DROP INDEX IF EXISTS idx_orch_outbox_fifo;
        ALTER TABLE orch_p_run DROP COLUMN intent_command_id;
        ALTER TABLE orch_p_run DROP COLUMN intent_at;
        ALTER TABLE orch_p_run DROP COLUMN intent_detail_sha256;
        ALTER TABLE orch_outbox DROP COLUMN session_key;
      `)
      sink.handle.db.pragma('user_version = 5')
      sink.close()
      sink = open()
      expect(sink.getSession(sessionKey)?.revSeq).toBe(savedRevision)
    }

    expect.soft(sink.getSession(freshId)?.legacy).toBe(false)
    submit('existing-run')
    bind('existing-run', nativeSessionId)
    expect(sink.getTurn(sessionKey, 1)).toMatchObject({ runId: 'existing-run', ordinalOrigin: 'since_import' })
    expect(sink.getSession(freshId)?.legacy).toBe(false)
    expect(sink.getTurn(freshId, 1)).toMatchObject({ runId: 'fresh-run', ordinalOrigin: 'native' })
    if (mode !== 'v5 pruned') expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('does not list a terminal transcript and withdraws the rows earlier builds listed', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-scan-external-')))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
  for (const id of ids) {
    const path = transcriptPath(cwd, id, homeDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ cwd, sessionId: id, type: 'user', message: { role: 'user', content: '终端里的会话' } })}\n`)
  }
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const access = createOrchestrationCatalogAccess(() => sink)
    const execute = (type: 'session.discover' | 'session.rename', commandId: string, payload: Record<string, unknown>) =>
      expect(sink.execute({
        type, commandId, actor: 'system', scope: 'system', at: 10,
        payload, payloadSha256: sha256Hex(canonicalJson(payload))
      } as unknown as Parameters<typeof sink.execute>[0]).kind).toBe('accepted')
    // What an earlier build's scan wrote: two external rows, one of which the user renamed.
    const external = (id: string) => ({
      sessionKey: `native:${id}`, provider: 'claude', cwd,
      catalog: { nativeSessionId: id, projectCwd: null, preview: null, runtimeProvider: 'claude_sdk' }
    })
    execute('session.discover', 'catalog-scan:old-1', external(ids[0]!))
    execute('session.discover', 'catalog-scan:old-2', external(ids[1]!))
    execute('session.rename', 'user-rename', { sessionKey: `native:${ids[1]}`, title: '保留' })
    expect(access.read()?.map((row) => row.externalSessionId).sort()).toEqual([ids[0], ids[1]])

    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => false, log: (message) => { throw new Error(message) }
    })
    await work.scanCatalog()
    expect(sink.getSession(`native:${ids[0]}`)).toBeUndefined()
    expect(sink.getSession(`native:${ids[1]}`)?.title).toBe('保留')
    expect(access.read()?.map((row) => row.externalSessionId)).toEqual([ids[1]])
    expect(sink.listEvents().filter((event) => event.type === 'session.withdrawn').map((event) => event.sessionKey))
      .toEqual([`native:${ids[0]}`])
    // A later scan neither brings the withdrawn row back nor lists the untouched transcript.
    const discoveredBefore = sink.listEvents().filter((event) => event.type === 'session.discovered' && event.sessionKey !== `native:${ids[1]}`).length
    await work.scanCatalog()
    expect(sink.listEvents().filter((event) => event.type === 'session.discovered' && event.sessionKey !== `native:${ids[1]}`)).toHaveLength(discoveredBefore)
    expect(access.read()?.map((row) => row.externalSessionId)).toEqual([ids[1]])
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('withdraws an old Pi scan row whose catalog mirror stored an empty preview', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-scan-external-pi-')))
  const userDataDir = join(root, 'userData')
  const homeDir = join(root, 'home')
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const nativeId = '11111111-1111-4111-8111-111111111111'
  const appId = '22222222-2222-4222-8222-222222222222'
  const sessionKey = `native:${nativeId}`
  const bucket = piNativeSessionDirectory(join(homeDir, '.pi', 'agent', 'sessions'), cwd)
  mkdirSync(bucket, { recursive: true })
  const transcript = join(bucket, `terminal_${nativeId}.jsonl`)
  const header = `${JSON.stringify({ type: 'session', version: 3, id: nativeId, cwd })}\n`
  writeFileSync(transcript, header)
  const sink = EventSink.open({ userDataDir, fullfsync: false })
  try {
    const access = createOrchestrationCatalogAccess(() => sink)
    const store = createAppSessionStore(userDataDir, access.beforeMirrorWrite)
    const payload = { sessionKey, provider: 'pi', cwd,
      catalog: { nativeSessionId: nativeId, projectCwd: null, preview: null, runtimeProvider: 'pi_rpc' } } as const
    expect(sink.execute({
      type: 'session.discover', commandId: `catalog-scan:${sessionKey}:0`, actor: 'system', scope: 'system', at: 10,
      payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    const context = { providerId: 'pi', runtimeProvider: 'pi_rpc', cwd, prompt: '' } as const
    store.record({ ...context, externalSessionId: nativeId })
    store.record({ ...context, externalSessionId: appId })
    expect(sink.getSession(sessionKey)?.catalog?.preview).toBe('')
    expect(sink.getSession(appId)?.catalog?.preview).toBe('')

    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => false, log: (message) => { throw new Error(message) }
    })
    await work.scanCatalog()
    await work.scanCatalog()
    expect(access.read()?.map((row) => row.externalSessionId)).toEqual([appId])
    expect(sink.listEvents().filter((event) => event.type === 'session.withdrawn').map((event) => event.sessionKey))
      .toEqual([sessionKey])
    expect(readFileSync(transcript, 'utf8')).toBe(header)
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    sink.close()
    rmSync(root, { recursive: true, force: true })
  }
})
