import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { SubscribeEngine } from './subscribe-engine'
import { SubscribeHub } from './subscribe-hub'
import type { SessionProjectionRow } from './types'

const sessionKey = 'legacy-session'
const cwd = '/tmp/中文工作区'
const firstPage = {
  turns: [{ userText: '导入前的消息', items: [] }, { runId: 'newer-run', userText: '导入后的消息', items: [] }],
  offset: 0,
  totalTurns: 2,
  hasOlder: false,
  completeness: 'complete' as const
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-sub-detail-'))
  const sink = EventSink.open({ userDataDir: dir, fullfsync: false })
  const hub = new SubscribeHub()
  const imported = { sessionKey, cwd, ts: 1, provider: 'codex', profile: 'work', evidence: ['app-sessions:test'] }
  sink.execute({
    type: 'session.import', commandId: 'import-legacy', actor: 'system', scope: 'system', at: 1,
    payload: imported, payloadSha256: sha256Hex(canonicalJson(imported))
  })
  const run = { runId: 'newer-run', sessionKey, provider: 'codex', profile: 'work', cwd, claimMode: 'immediate' as const }
  sink.execute({
    type: 'run.submit', commandId: 'submit-newer', actor: 'system', scope: 'local', at: 2,
    payload: run, payloadSha256: sha256Hex(canonicalJson(run))
  })
  return {
    sink,
    hub,
    close: () => {
      hub.close()
      sink.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

it('includes the host history page with an imported session’s new turns in one snapshot', async () => {
  const { sink, hub, close } = fixture()
  try {
    const readFirstPage = vi.fn(async (_session: SessionProjectionRow) => firstPage)
    const engine = new SubscribeEngine({
      sink, hub, hostId: 'host', grantScope: () => 'local', authorizePeer: () => undefined, readFirstPage
    })
    const reply = await engine.subscribe('local', { views: ['detail'], session: { sessionKey }, waitMs: 0 })
    expect(reply).toMatchObject({
      mode: 'snapshot',
      snapshot: {
        detail: {
          legacyBefore: true, firstPage,
          turns: [{ runId: 'newer-run', ordinal: 1, ordinalOrigin: 'since_import' }]
        }
      }
    })
    expect(readFirstPage).toHaveBeenCalledTimes(1)
    expect(readFirstPage.mock.calls[0]?.[0]).toMatchObject({ sessionKey, cwd, provider: 'codex', profile: 'work' })
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    close()
  }
})

it('checks the session authority before reading the page and after awaiting it', async () => {
  const { sink, hub, close } = fixture()
  try {
    let canRead = false
    const readFirstPage = vi.fn(async () => {
      canRead = false
      return firstPage
    })
    const engine = new SubscribeEngine({
      sink, hub, hostId: 'host', grantScope: () => 'remote', authorizePeer: () => undefined,
      isRemoteCwdAuthorized: () => canRead, readFirstPage
    })
    const request = { views: ['detail' as const], session: { sessionKey }, waitMs: 0 }
    await expect(engine.subscribe('remote', request)).resolves.toMatchObject({
      mode: 'snapshot', snapshot: { detail: { turns: [] } }
    })
    expect(readFirstPage).not.toHaveBeenCalled()
    canRead = true
    await expect(engine.subscribe('remote', request)).resolves.toMatchObject({
      mode: 'snapshot', snapshot: { detail: { turns: [] } }
    })
    expect(readFirstPage).toHaveBeenCalledTimes(1)
  } finally {
    close()
  }
})
