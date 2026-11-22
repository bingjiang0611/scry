import 'reflect-metadata'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import { INLINE_BODY_MAX_BYTES } from '../host-runtime/orchestration/types'
import { cleanupTempDirs, tempDir } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { createRecentFoldersStore } from '../main/app-store'

const sessionId = 'old-session'
const runId = 'legacy-unbound-run'
afterEach(cleanupTempDirs)

async function startLegacySession(corruptDatabase = false) {
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

it('erases the private projection when an authorized unified conversation is deleted', async () => {
  const daemon = await startTestDaemon()
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const created = await daemon.localOp('conversation', 'create', [daemon.workspace])
    expect(created.error).toBeUndefined()
    const id = created.result.id as string
    const providerId = 'codex'
    const target = await daemon.localOp('conversation', 'preview', [id, { providerId }])
    expect(target.error).toBeUndefined()
    const prompt = '需要清除的正文' + 'x'.repeat(INLINE_BODY_MAX_BYTES)
    const sent = await daemon.localOp('conversation', 'send', [{
      providerId, conversationId: id, expectedRevision: target.result.revision,
      expectedContinuationKey: target.result.target.continuationKey,
      commandId: 'delete-unified-turn', prompt, selectedItems: [], confirmFresh: true
    }])
    expect(sent.error).toBeUndefined()
    const runId = sent.result.runId as string
    const body = sink.getRun(runId)?.body
    expect(body?.storage).toBe('external')
    expect(sink.getSession(id)).toBeDefined()
    await expect.poll(() => sink.getRun(runId)?.lifecycle, { timeout: 10_000 }).toBe('settled')
    const listed = await daemon.localOp('conversation', 'list', [daemon.workspace])
    const current = (listed.result as { id: string; revision: number }[]).find(row => row.id === id)!
    const archived = await daemon.localOp('conversation', 'update', [id, current.revision, { kind: 'archive', archived: true }])
    expect(archived.error).toBeUndefined()
    const preview = await daemon.localOp('conversation', 'previewDeletion', [id])
    expect(preview.error).toBeUndefined()
    const deleted = await daemon.localOp('conversation', 'delete', [id, preview.result.fingerprint])
    expect(deleted.error).toBeUndefined()
    expect(deleted.result).toMatchObject({ ok: true })
    expect(sink.getSession(id)).toBeUndefined()
    expect(sink.getRun(runId)).toBeUndefined()
    expect(sink.bodyStore.hasExternalBody(body!.sha256)).toBe(false)
    expect(sink.listOutbox().some(effect => effect.runId === runId)).toBe(false)
    expect(sink.listEvents().filter(event => event.sessionKey === id).at(-1)).toMatchObject({ type: 'session.deleted' })
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    await daemon.dispose()
  }
}, 30_000)

it('uses the unified conversation projection for the sidebar and the detail first page', async () => {
  const daemon = await startTestDaemon()
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const created = await daemon.localOp('conversation', 'create', [daemon.workspace])
    expect(created.error).toBeUndefined()
    const id = created.result.id as string
    const session = sink.getSession(id)
    expect(session).toMatchObject({ conversationId: id, cwd: daemon.workspace })
    const payload = { sessionKey: id, title: '投影中的统一会话' }
    expect(sink.execute({
      type: 'session.rename', commandId: 'rename-unified-projection', actor: 'system', scope: 'system',
      at: Date.now(), payload, payloadSha256: sha256Hex(canonicalJson(payload))
    }).kind).toBe('accepted')
    const listed = await daemon.localOp('conversation', 'list', [daemon.workspace])
    expect(listed.result).toMatchObject([{ id, title: payload.title }])
    const read = await daemon.localOp('conversation', 'read', [id])
    expect(read.result).toMatchObject({ summary: { id, title: payload.title } })
    const subscribed = await daemon.request({ op: 'subscribe', views: ['detail'], session: { sessionKey: id }, waitMs: 0 })
    expect(subscribed.subscribe).toMatchObject({
      mode: 'snapshot', snapshot: {
        detail: { firstPage: { kind: 'conversation', page: { summary: { id, title: payload.title }, turns: [] } } }
      }
    })
    expect(sink.deleteSession({ sessionKey: id, cwd: daemon.workspace, actor: 'system', scope: 'system', at: Date.now() }).status).toBe('deleted')
    expect((await daemon.localOp('conversation', 'list', [daemon.workspace])).result).toEqual([])
    expect((await daemon.localOp('conversation', 'read', [id])).error).toBeTruthy()
    expect(sink.getSession(id)).toBeUndefined()
    expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
  } finally {
    await daemon.dispose()
  }
}, 30_000)

it('includes an old empty unified conversation in the first subscription after enabling orchestration', async () => {
  const old = await startTestDaemon()
  let id: string
  try {
    const { ConversationStore } = await import('../main/conversation-store')
    const store = new ConversationStore(old.userDataDir)
    id = (await store.create(old.workspace)).id
  } finally {
    await old.dispose()
  }
  const restarted = await startTestDaemon({ root: old.root })
  try {
    const first = await restarted.request({
      op: 'subscribe', views: ['sessions', 'detail'], session: { sessionKey: id }, waitMs: 0
    })
    expect(first.error).toBeUndefined()
    expect(first.subscribe).toMatchObject({ mode: 'snapshot', snapshot: {
      sessions: { rows: [expect.objectContaining({ conversationId: id })] },
      detail: { legacyBefore: true, firstPage: { kind: 'conversation', page: { summary: { id }, turns: [] } } }
    } })
  } finally {
    await restarted.dispose()
  }
}, 30_000)

it('keeps the committed conversation ID when projecting its metadata fails', async () => {
  const daemon = await startTestDaemon()
  let id: string
  try {
    const sink = daemon.host.orchestrationAuthority!.sink
    const failProjection = vi.spyOn(sink, 'execute').mockReturnValueOnce({
      kind: 'rejected', reason: 'orchestration_write_indeterminate', sticky: false, writeReceipt: false
    })
    const created = await daemon.localOp('conversation', 'create', [daemon.workspace])
    expect(failProjection).toHaveBeenCalled()
    expect(created.error).toBeUndefined()
    id = created.result.id
    expect(typeof id).toBe('string')
  } finally {
    await daemon.dispose()
  }
  const recovered = await startTestDaemon({ root: daemon.root })
  try {
    const listed = await recovered.localOp('conversation', 'list', [recovered.workspace])
    expect(listed.result).toMatchObject([{ id }])
    expect(recovered.host.orchestrationAuthority!.sink.getSession(id)?.conversationId).toBe(id)
  } finally {
    await recovered.dispose()
  }
}, 30_000)

it('rejects an imported history request in the presentation project instead of the execution workspace', async () => {
  const { daemon, ref } = await startLegacySession()
  try {
    const group = join(daemon.root, 'presentation-group')
    mkdirSync(group)
    const wrongCwd = realpathSync(group)
    createRecentFoldersStore(daemon.userDataDir).push(wrongCwd)
    const wrong = await daemon.localOp('sessionHistory', 'loadSession', [{ ...ref, cwd: wrongCwd }])
    expect(wrong.error).toBe('会话工作目录与 catalog 不一致')
  } finally {
    await daemon.dispose()
  }
}, 30_000)
