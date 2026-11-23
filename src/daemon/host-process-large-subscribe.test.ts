import 'reflect-metadata'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_HISTORY_CHUNK_BYTES } from '../shared/desktop-remote'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { upsertTraceArchiveTurn } from '../main/transcript-archive'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

afterEach(cleanupTempDirs)

it('returns a large detail page in bounded mTLS chunks and invalidates a deleted session’s continuations', async () => {
  const root = tempDir()
  const userDataDir = join(root, 'userData')
  mkdirSync(userDataDir)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const cwd = realpathSync(workspace)
  const sessionId = 'large-legacy-session'
  const runId = 'historical-run'
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId, providerId: 'codex', cwd, preview: '历史详情', ts: 100
  }]))
  const resultText = '大页内容'.repeat(52_000)
  expect(upsertTraceArchiveTurn({
    cwd, sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', userDataDir,
    turn: {
      runId, userText: '旧问题', done: true,
      items: [{ id: 'result', kind: 'model', stage: 'text', text: resultText, ts: '2026-11-22T00:00:00.000Z', runId }]
    }
  })).toBe(true)
  const daemon = await startTestDaemon({ root })
  try {
    const opens = { views: ['detail' as const], session: { sessionKey: sessionId }, waitMs: 0 }
    const payload = { op: 'subscribe', ...opens }
    const first = (await daemon.request(payload)).subscribe
    expect(first).toMatchObject({ kind: 'history_chunk', offset: 0 })
    expect(Buffer.from(first.data, 'base64')).toHaveLength(DESKTOP_HISTORY_CHUNK_BYTES)
    const next = { id: first.id, offset: DESKTOP_HISTORY_CHUNK_BYTES }
    await expect(daemon.request({ ...payload, session: { sessionKey: 'other' }, chunk: next }))
      .resolves.toEqual({ error: 'invalid_subscribe_chunk' })

    const transport = new DaemonRunTransport((input) => daemon.request(input))
    const full = await transport.subscribe(opens)
    expect(full).toMatchObject({
      mode: 'snapshot',
      snapshot: {
        detail: { legacyBefore: true, firstPage: { turns: [{ userText: '旧问题', items: [{ text: resultText }] }] } }
      }
    })
    const deleted = await daemon.localOp('sessionLifecycle', 'deleteSession', [{
      providerId: 'codex', cwd, externalSessionId: sessionId
    }])
    expect(deleted.result).toMatchObject({ ok: true })
    await expect(daemon.request({ ...payload, chunk: next })).resolves.toEqual({ error: 'invalid_subscribe_chunk' })
  } finally {
    await daemon.dispose()
  }
}, 30_000)
