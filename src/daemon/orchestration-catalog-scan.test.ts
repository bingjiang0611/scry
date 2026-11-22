import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { transcriptPath } from '../main/transcript-archive'
import { sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { EventSink } from '../host-runtime/orchestration/event-sink'
import { createCatalogScanWork } from './orchestration-catalog-scan'

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
