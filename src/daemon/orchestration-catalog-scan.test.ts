import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { transcriptPath } from '../main/transcript-archive'
import { createAppSessionStore } from '../main/app-store'
import { sha256Hex } from '../host-runtime/orchestration/canonical-json'
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
    const work = createCatalogScanWork({
      sink, homeDir, userDataDir, workspaces: () => [cwd],
      isActive: () => active, log: (message) => { throw new Error(message) }
    })
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
