import 'reflect-metadata'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import { INLINE_BODY_MAX_BYTES } from '../host-runtime/orchestration/types'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'

const sessionId = 'old-session'
const runId = 'legacy-unbound-run'
const savedMode = process.env.SCRY_ORCHESTRATION

afterEach(() => {
  if (savedMode === undefined) delete process.env.SCRY_ORCHESTRATION
  else process.env.SCRY_ORCHESTRATION = savedMode
  cleanupTempDirs()
})

async function startLegacySession(corruptDatabase = false) {
  process.env.SCRY_ORCHESTRATION = 'on'
  const root = tempDir()
  const userDataDir = join(root, 'userData')
  const workspace = join(root, 'workspace')
  mkdirSync(userDataDir)
  mkdirSync(workspace)
  const cwd = realpathSync(workspace)
  const catalogFile = join(userDataDir, 'app-sessions.json')
  writeFileSync(catalogFile, JSON.stringify([{
    sessionId, externalSessionId: sessionId, runId, providerId: 'codex', cwd, preview: '需要清除的预览', ts: 1
  }]))
  if (corruptDatabase) writeFileSync(join(userDataDir, 'scry.db'), 'invalid SQLite test fixture')
  const daemon = await startTestDaemon({ root })
  const ref = { providerId: 'codex', cwd, externalSessionId: sessionId }
  const sink = daemon.host.orchestrationAuthority!.sink
  return { daemon, ref, sink, catalogFile, cwd }
}

it('redacts the projected and older unbound run through the real native deletion operation', async () => {
  const { daemon, ref, sink, catalogFile, cwd } = await startLegacySession()
  try {
    const staleCatalog = JSON.parse(readFileSync(catalogFile, 'utf8')) as Array<Record<string, unknown>>
    const prompt = 'private prompt'.repeat(INLINE_BODY_MAX_BYTES)
    const body = sink.bodyStore.prepareBody(prompt)
    const payload = {
      runId, sessionKey: null, cwd, provider: 'codex', profile: null,
      promptPreview: 'private prompt', claimMode: 'immediate' as const, body
    }
    expect(sink.execute({
      type: 'run.submit', commandId: 'unbound-legacy-run', actor: 'system', scope: 'local',
      at: 2, payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    expect(sink.bodyStore.hasExternalBody(body.sha256)).toBe(true)
    expect(sink.listOutbox().some((effect) => effect.runId === runId)).toBe(true)

    const deleted = await daemon.localOp('sessionLifecycle', 'deleteSession', [ref])
    expect(deleted.error).toBeUndefined()
    expect(deleted.result).toMatchObject({ ok: true })
    expect(sink.getSession(sessionId)).toBeUndefined()
    expect(sink.getRun(runId)).toBeUndefined()
    expect(sink.bodyStore.hasExternalBody(body.sha256)).toBe(false)
    expect(sink.listOutbox().some((effect) => effect.runId === runId)).toBe(false)
    expect(JSON.parse(readFileSync(catalogFile, 'utf8'))).toEqual([])
    const relevant = sink.listEvents().filter((event) => event.sessionKey === sessionId || event.runId === runId)
    expect(relevant.at(-1)).toMatchObject({ type: 'session.deleted', cwd, payload: { sessionKey: sessionId, cwd } })
    expect(relevant.slice(0, -1).map((event) => event.payload)).toEqual([{ redacted: true }, { redacted: true }])
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })

    writeFileSync(catalogFile, JSON.stringify([...staleCatalog, { ...staleCatalog[0], sessionId: 'other', externalSessionId: 'other' }]))
    expect(importCatalogEntries(sink, daemon.userDataDir, Date.now()).importedSessions).toBe(1)
    expect(sink.getSession(sessionId)).toBeUndefined()
    expect(sink.getSession('other')).toBeDefined()
  } finally {
    await daemon.dispose()
  }
}, 30_000)

it('returns unavailable and preserves the retry catalog when scry.db cannot be opened', async () => {
  const { daemon, ref, sink, catalogFile } = await startLegacySession(true)
  try {
    const deleted = await daemon.localOp('sessionLifecycle', 'deleteSession', [ref])
    expect(deleted.result).toMatchObject({ ok: false, reason: 'unavailable', deleted: [], failed: [{ store: 'database' }] })
    expect(sink.getSession(sessionId)).toBeDefined()
    expect(sink.listEvents().some((event) => event.type === 'session.deleted')).toBe(false)
    expect(readFileSync(catalogFile, 'utf8')).toContain(sessionId)
  } finally {
    await daemon.dispose()
  }
}, 30_000)
