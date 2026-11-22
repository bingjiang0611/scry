import 'reflect-metadata'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDaemonHostProcess } from './host-process'
import { MemoryOutputStore, cleanupTempDirs, tempDir } from './host-process.fixtures'
import { generateDesktopDeviceIdentity } from '../main/remote/desktop-transport'
import { DESKTOP_HISTORY_CHUNK_BYTES, REMOTE_PROTOCOL_VERSION } from '../shared/desktop-remote'
import { upsertTraceArchiveTurn } from '../main/transcript-archive'
import { assembleByteChunks } from '../main/remote/desktop-byte-chunks'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'

const savedMode = process.env.SCRY_ORCHESTRATION
const savedCli = process.env.SCRY_EXPERIMENTAL_HOST_CLI
afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  if (savedCli === undefined) delete process.env.SCRY_EXPERIMENTAL_HOST_CLI
  else process.env.SCRY_EXPERIMENTAL_HOST_CLI = savedCli
  cleanupTempDirs()
})

async function callTcp(port: number, ca: string, cert: string, key: string, request: Record<string, unknown>) {
  const socket: TLSSocket = tlsConnect({
    host: '127.0.0.1', port, ca, cert, key,
    minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', checkServerIdentity: () => undefined
  })
  await once(socket, 'secureConnect')
  socket.setEncoding('utf8')
  socket.write(`${JSON.stringify({ protocol: REMOTE_PROTOCOL_VERSION, ...request })}\n`)
  let buffer = ''
  for await (const chunk of socket) { buffer += String(chunk); if (buffer.includes('\n')) break }
  socket.destroy()
  return JSON.parse(buffer.split('\n')[0]) as Record<string, unknown>
}

describe('v3 subscribe on the authenticated network endpoint', () => {
  it('negotiates the capability and filters durable rows and volatile hints', async () => {
    process.env.SCRY_ORCHESTRATION = 'on'
    process.env.SCRY_EXPERIMENTAL_HOST_CLI = '1'
    const userDataDir = tempDir()
    const workspace = realpathSync(tempDir())
    const privateWorkspace = realpathSync(tempDir())
    writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([workspace]))
    const nativeSessionId = 'visible-native'
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId: nativeSessionId, providerId: 'codex', cwd: workspace, preview: '测试会话', ts: 1
    }]))
    const historyText = '分页内容'.repeat(52_000)
    expect(upsertTraceArchiveTurn({
      cwd: workspace, sessionId: nativeSessionId, providerId: 'codex', runtimeProvider: 'codex_cli', userDataDir,
      turn: { runId: 'archived', userText: '测试问题', done: true, agentProfileId: null,
        items: [{ id: 'text', kind: 'model', stage: 'text', runId: 'archived', text: historyText, ts: '2026-11-22T00:00:00.000Z' }] }
    })).toBe(true)
    const host = await createDaemonHostProcess({
      userDataDir,
      daemonStateDirectory: tempDir(),
      appPath: process.cwd(),
      resourcesPath: tempDir(),
      appVersion: '0.2.250',
      isPackaged: false,
      createOutputStore: () => new MemoryOutputStore()
    })
    try {
      await host.service.beginDesktopPairing()
      const status = host.service.desktopStatus()
      if (!status.enabled) throw new Error('desktop listener did not enable')
      const id = await generateDesktopDeviceIdentity()
      const { pairingId, secret } = await host.service.authority.begin()
      await host.service.authority.prove({ pairingId, secret, csrPEM: id.csrPEM, deviceLabel: 'Mac2 subscribe' }, id.publicKeySHA256)
      const grant = await host.service.authority.confirmLocal(pairingId, id.publicKeySHA256)
      const request = (frame: Record<string, unknown>) =>
        callTcp(status.runPort, host.service.caCertificatePEM, grant.certificatePEM, id.keyPEM, frame)
      const authority = host.orchestrationAuthority!
      const importSession = (sessionKey: string, cwd: string) => {
        const payload = { sessionKey, provider: 'codex', title: sessionKey, cwd, ts: Date.now() }
        expect(authority.sink.execute({
          type: 'session.import', commandId: sessionKey, actor: 'system', scope: 'system',
          at: Date.now(), payload, payloadSha256: sha256Hex(canonicalJson(payload))
        }).kind).toBe('accepted')
      }
      importSession('private', privateWorkspace)
      const outdated = await request({ protocol: 2, op: 'desktop', query: { kind: 'info' } })
      expect(outdated).toEqual({ error: 'protocol_mismatch', hostProtocol: 3, clientProtocol: 2 })
      expect(await request({ op: 'watch', runId: randomUUID(), cursor: 0, outputCursor: 0, waitMs: 0 }))
        .toEqual({ error: 'unknown_op' })
      const first = await request({ op: 'subscribe', views: ['sessions', 'activeRuns'], waitMs: 0 })
      expect(first).toMatchObject({
        subscribe: { mode: 'snapshot', snapshot: { sessions: { total: 1, rows: [{ sessionKey: nativeSessionId, cwd: workspace }] } } }
      })
      expect(JSON.stringify(first)).not.toContain(privateWorkspace)
      const info = await request({ op: 'desktop', query: { kind: 'info' } })
      expect(info).toMatchObject({ desktop: { kind: 'info', protocol: 3, subscribe: 1, hostAdminNotices: 1 } })
      const metadata = await request({ op: 'catalogSnapshot' })
      expect(metadata).toMatchObject({ catalogSnapshot: { info: { subscribe: 1 }, projects: [{ path: workspace }] } })
      expect(metadata.catalogSnapshot).not.toHaveProperty('sessionsPage')
      const { hostId, logId, seq } = first.subscribe as { hostId: string; logId: string; seq: number }
      const beforeIdle = performance.now()
      const idle = await request({ op: 'subscribe', views: ['sessions', 'activeRuns'], known: { hostId, logId, seq }, waitMs: 400 })
      expect(performance.now() - beforeIdle).toBeGreaterThanOrEqual(300)
      expect(idle).toMatchObject({ subscribe: { mode: 'idle', seq } })
      const unknownIntent = randomUUID()
      const wrongLog = 'replaced-log'
      expect(await request({ op: 'submitAtLog', intentId: unknownIntent, knownLogId: wrongLog,
        detail: JSON.stringify({ cwd: workspace, providerId: 'codex', prompt: '必须拒绝' })
      })).toEqual({ error: 'orchestration_log_changed' })
      expect(await request({ op: 'intentStatusAtLog', intentId: unknownIntent, knownLogId: wrongLog }))
        .toEqual({ error: 'orchestration_log_changed' })
      expect(authority.sink.listEvents().some(event => event.type === 'run.intent_recorded')).toBe(false)
      const notice = host.hostAdmin.recordNotice({
        kind: 'device_approved_via_cli', deviceLabel: '测试 iPhone', fingerprintPrefix: '0123456789abcdef'
      })
      expect(authority.subscribeHub.hasPendingHints(grant.certificateSHA256)).toBe(true)
      authority.subscribeHub.emitOAuth('https://example.invalid/local-only')
      authority.subscribeHub.emitAttention({ revision: 23, unreadSessionKeys: ['private'] })
      authority.subscribeHub.noteRunBound('private-run', { cwd: privateWorkspace, scryRunId: 'local-run' })
      authority.subscribeHub.noteRunOutput('private-run')
      importSession('visible-next', workspace)
      importSession('private-next', privateWorkspace)
      const privateSeq = authority.sink.listEvents().find(event => event.sessionKey === 'private-next')?.seq
      expect(privateSeq).toBeGreaterThan(seq)
      const update = await request({
        op: 'subscribe', views: ['sessions', 'activeRuns'], known: { hostId, logId, seq }, waitMs: 0
      })
      expect(update).toMatchObject({ subscribe: {
        mode: 'events', seq: privateSeq, events: [{ sessionKey: 'visible-next', sessionRow: {
          sessionKey: 'visible-next', cwd: workspace
        } }], hints: [{ kind: 'hostNotice', notice }]
      } })
      importSession('visible-after-scan', workspace)
      const afterScan = await request({
        op: 'subscribe', views: ['sessions', 'activeRuns'], known: { hostId, logId, seq: privateSeq }, waitMs: 0
      })
      expect(afterScan).toMatchObject({ subscribe: { mode: 'events', events: [{ sessionKey: 'visible-after-scan' }] } })
      const detail = await request({ op: 'subscribe', views: ['detail'], session: { sessionKey: 'private' }, waitMs: 0 })
      expect(detail).toMatchObject({ subscribe: { mode: 'snapshot', snapshot: { detail: { turns: [] } } } })
      expect(JSON.stringify(detail)).not.toContain('firstPage')
      const visibleDetail = { op: 'subscribe', views: ['detail'], session: { sessionKey: nativeSessionId }, waitMs: 0 }
      const opened = await request(visibleDetail)
      expect(opened).toMatchObject({ subscribe: { kind: 'history_chunk', offset: 0 } })
      const firstChunk = opened.subscribe as Record<string, unknown>
      const nextChunk = { id: firstChunk.id, offset: DESKTOP_HISTORY_CHUNK_BYTES }
      expect(await request({ ...visibleDetail, session: { sessionKey: 'private' }, chunk: nextChunk }))
        .toEqual({ error: 'invalid_subscribe_chunk' })
      const full = await assembleByteChunks(firstChunk, async (chunk) => {
        const reply = await request({ ...visibleDetail, chunk })
        return reply.subscribe as Record<string, unknown>
      }, () => { throw new Error('invalid test page') })
      expect(full).toMatchObject({ mode: 'snapshot', snapshot: { detail: { firstPage: {
        kind: 'remoteHistory', history: { historyScope: 'session',
          turns: [{ userText: '测试问题', items: [{ text: historyText }] }] }
      } } } })
      const mobileRequest = { ...visibleDetail, historyFormat: 'turns' }
      const mobile = await request(mobileRequest)
      expect(mobile).toMatchObject({ subscribe: { kind: 'history_chunk', offset: 0 } })
      const mobilePage = await assembleByteChunks(mobile.subscribe as Record<string, unknown>, async (chunk) => {
        const reply = await request({ ...mobileRequest, chunk })
        return reply.subscribe as Record<string, unknown>
      }, () => { throw new Error('invalid mobile test page') })
      expect(mobilePage).toMatchObject({ mode: 'snapshot', snapshot: { detail: {
        firstPage: { kind: 'mobileHistory', page: {
          turns: [{ userText: '测试问题', items: [{ kind: 'output', text: historyText }] }], offset: 0, totalTurns: 1
        } }
      } } })
      const updated = afterScan.subscribe as { seq: number }
      const parked = vi.spyOn(authority.subscribeHub, 'waitForWake')
      const waiting = request({ op: 'subscribe', views: ['sessions', 'activeRuns'], waitMs: 5_000,
        known: { hostId, logId, seq: updated.seq } })
      await expect.poll(() => parked.mock.calls.length).toBeGreaterThan(0)
      await host.service.authority.revoke(grant.deviceId)
      authority.subscribeHub.emitHostNotice(notice)
      await expect(waiting).resolves.toEqual({ error: 'device_not_authorized' })
      expect(await request({ op: 'subscribe', views: ['sessions'], waitMs: 0 })).toEqual({ error: 'device_not_authorized' })
    } finally {
      await host.dispose()
    }
  }, 30_000)
})
