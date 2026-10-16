import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'
import { ConversationService } from './conversation-service'
import { parseConversationLegacySource, prepareConversationAdoption } from './conversation-adoption'
import { planConversationContinuation } from '../shared/conversation'
import { traceArchiveTurnPath, upsertTraceArchiveTurn } from './transcript-archive'
import * as io from '../core/turn-recorder/io'
import type { TraceEvent } from '../shared/trace'
import type { ConversationLegacySource } from '../shared/conversation-api'

let directory: string
let userData: string
let source: ConversationLegacySource
let store: ConversationStore
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const event: TraceEvent = { id: 'text', runId: 'legacy-run', ts: '2026-10-16T00:00:00Z', kind: 'model', stage: 'text', text: 'complete answer' }
const catalog = () => ({ ...source, sessionId: source.externalSessionId, preview: 'old preview', title: 'original title', ts: 1, pinnedAt: 1 })
const path = () => traceArchiveTurnPath(userData, source.cwd, source.externalSessionId, source.providerId, { runId: event.runId, providerTurnId: 'legacy-turn' })
const publish = (userText = 'original prompt', done = true) => expect(upsertTraceArchiveTurn({ userDataDir: userData, ...source, sessionId: source.externalSessionId,
  turn: { runId: event.runId, providerTurnId: 'legacy-turn', userText, items: [event], done, status: 'completed', ts: 1 } })).toBe(true)
const input = (revision: number) => ({ expectedRevision: revision, runId: 'new-run', commandId: 'new-command',
  target: { providerId: 'codex' as const, continuationKey: 'runtime-identity' }, payloadHash: hash('new'), items: [], selectedItems: [] })

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scry-management-'))
  userData = join(directory, 'app')
  await mkdir(join(directory, 'workspace'))
  source = { providerId: 'claude', cwd: await realpath(join(directory, 'workspace')), externalSessionId: 'legacy-session' }
  store = new ConversationStore(userData)
  publish()
})
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

describe('logical conversation migration and metadata', () => {
  it('imports references atomically, retains source bytes, and never claims native compatibility or coverage', async () => {
    const bytes = await readFile(path())
    const prepared = await prepareConversationAdoption(userData, source, catalog())
    expect(await store.list()).toEqual([])
    expect(prepared.preview.turnCount).toBe(1)
    const conversation = await store.create(source.cwd, prepared.seed)
    expect(await readFile(path())).toEqual(bytes)
    expect(conversation.title).toBe('original title')
    expect(conversation.pinnedAt).toBe(1)
    expect(conversation.turns[0]).toMatchObject({ origin: 'imported', runId: event.runId, nativeItems: [] })
    expect(planConversationContinuation(conversation, prepared.seed.target).kind).toBe('fresh')
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })).rejects.toThrow('归属')
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: event.runId })).rejects.toThrow('归属')
    const renamed = await store.updateMetadata(conversation.id, 0, { kind: 'rename', title: 'new title' })
    expect(await store.create(source.cwd, prepared.seed)).toEqual(renamed)
    expect(await store.list()).toHaveLength(1)
    expect((await new ConversationStore(userData).read(conversation.id))?.adoptionFingerprint).toBe(prepared.preview.fingerprint)
  })

  it('leaves old ownership available if atomic publication fails', async () => {
    const prepared = await prepareConversationAdoption(userData, source, catalog())
    vi.spyOn(io, 'writeFileAtomicExclusive').mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(store.create(source.cwd, prepared.seed)).rejects.toThrow('disk unavailable')
    expect(await new ConversationStore(userData).list()).toEqual([])
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })).resolves.toBeUndefined()
    expect(await readFile(path(), 'utf8')).toContain('original prompt')
  })

  it('fingerprints source body and metadata changes and rejects replacing a committed adoption', async () => {
    const first = await prepareConversationAdoption(userData, source, catalog())
    expect((await prepareConversationAdoption(userData, source, { ...catalog(), title: 'changed' })).preview.fingerprint).not.toBe(first.preview.fingerprint)
    await store.create(source.cwd, first.seed)
    publish('changed prompt')
    const second = await prepareConversationAdoption(userData, source, catalog())
    expect(second.preview.fingerprint).not.toBe(first.preview.fingerprint)
    await expect(store.create(source.cwd, second.seed)).rejects.toThrow('不能替换迁移内容')
  })

  it('rejects a corrupt sibling rather than silently migrating only readable turns', async () => {
    await writeFile(join(dirname(path()), `turn-${'0'.repeat(64)}.json`), '{broken')
    await expect(prepareConversationAdoption(userData, source, catalog())).rejects.toThrow('归档损坏')
    expect(await store.list()).toEqual([])
  })

  it('keeps the native chat writable when automatic handoff would exceed its byte budget', async () => {
    publish('x'.repeat(33 * 1024))
    await expect(prepareConversationAdoption(userData, source, catalog(), true)).rejects.toThrow('32 KiB')
    expect(await store.list()).toEqual([])
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })).resolves.toBeUndefined()
    const manual = await prepareConversationAdoption(userData, source, { ...catalog(), title: undefined })
    expect(manual.preview.title).toBe('old preview')
  })

  it('bounds archive reads before parsing large files', async () => {
    await truncate(path(), 17 * 1024 * 1024)
    await expect(prepareConversationAdoption(userData, source, catalog())).rejects.toThrow('16 MiB')
  })

  it('rejects unsettled captures, unsupported providers, named profiles and injected fields', async () => {
    publish('unfinished', false)
    await expect(prepareConversationAdoption(userData, source, catalog())).rejects.toThrow('未收敛')
    expect(() => parseConversationLegacySource({ ...source, providerId: 'pi' })).toThrow('Pi 必须选择')
    expect(() => parseConversationLegacySource({ ...source, agentProfileId: 'named' })).toThrow('Claude/Codex 仅支持默认配置')
    expect(() => parseConversationLegacySource({ ...source, nativeItems: [] })).toThrow('迁移仅支持')
    expect(() => parseConversationLegacySource({ ...source, providerId: 'qoder' })).toThrow('Provider 不受支持')
  })

  it('retains Pi profile ownership without inventing legacy native coverage', async () => {
    source = { ...source, providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' }
    publish()
    expect(parseConversationLegacySource(source)).toEqual(source)
    const prepared = await prepareConversationAdoption(userData, source, catalog())
    const conversation = await store.create(source.cwd, prepared.seed)
    expect(conversation.bindings[0]).toMatchObject({ providerId: 'pi', agentProfileId: source.agentProfileId, nativeSessionId: source.externalSessionId })
    expect(conversation.bindings[0].retiredReason).toBeTruthy()
    expect(conversation.turns[0]).toMatchObject({ origin: 'imported', nativeItems: [] })
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })).rejects.toThrow('归属')
    await expect(store.assertLegacyWriteAllowed({ ...source, agentProfileId: 'pi:fedcba9876543210', nativeSessionId: source.externalSessionId })).resolves.toBeUndefined()
    const other = await prepareConversationAdoption(userData, { ...source, agentProfileId: 'pi:fedcba9876543210' }, catalog())
    expect(other.preview.fingerprint).not.toBe(prepared.preview.fingerprint)
  })

  it('persists names, pins and archive state, preserving IDs, evidence, and ownership', async () => {
    const prepared = await prepareConversationAdoption(userData, source, catalog())
    let conversation = await store.create(source.cwd, prepared.seed)
    const original = structuredClone(conversation)
    conversation = await store.updateMetadata(conversation.id, conversation.revision, { kind: 'rename', title: '  chosen title  ' })
    await expect(store.updateMetadata(conversation.id, 0, { kind: 'pin', pinned: false })).rejects.toThrow('对话已变化')
    conversation = await store.updateMetadata(conversation.id, conversation.revision, { kind: 'pin', pinned: false })
    conversation = await store.updateMetadata(conversation.id, conversation.revision, { kind: 'archive', archived: true })
    expect(conversation).toMatchObject({ title: 'chosen title', id: original.id, turns: original.turns, bindings: original.bindings })
    expect(conversation.pinnedAt).toBeUndefined()
    expect(conversation.archivedAt).toBeGreaterThan(0)
    await expect(store.begin(conversation.id, input(conversation.revision))).rejects.toThrow('已存档')
    await expect(store.assertLegacyWriteAllowed({ ...source, nativeSessionId: source.externalSessionId })).rejects.toThrow('归属')
    expect(await new ConversationStore(userData).read(conversation.id)).toEqual(conversation)
    conversation = await store.updateMetadata(conversation.id, conversation.revision, { kind: 'archive', archived: false })
    expect(conversation.archivedAt).toBeUndefined()
    await expect(store.begin(conversation.id, input(conversation.revision))).resolves.toMatchObject({ disposition: 'created' })
  })

  it('cannot archive pending or unknown delivery, while renaming preserves that barrier', async () => {
    const conversation = await store.create(source.cwd)
    const begun = await store.begin(conversation.id, input(0))
    const renamed = await store.updateMetadata(conversation.id, begun.conversation.revision, { kind: 'rename', title: 'pending title' })
    await expect(store.updateMetadata(conversation.id, renamed.revision, { kind: 'archive', archived: true })).rejects.toThrow('投递未收敛')
    const unknown = await store.recover(conversation.id, new Set())
    await expect(store.updateMetadata(conversation.id, unknown.revision, { kind: 'archive', archived: true })).rejects.toThrow('投递未收敛')
    expect(planConversationContinuation(unknown, input(0).target).kind).toBe('blocked')
  })

  it('validates fixed metadata operations and refuses archived preview without resolving a runtime', async () => {
    const resolveContinuationKey = vi.fn(async () => 'identity')
    const service = new ConversationService({ store, resolveContinuationKey, supportsHistoricalInput: () => true, startAppRun: vi.fn() })
    const conversation = await service.create(source.cwd)
    for (const change of [{ kind: 'pin', pinned: 'yes' }, { kind: 'archive', archived: true, nativeSessionId: 'injected' }, { kind: 'delete' }]) {
      await expect(service.update(conversation.id, 0, change)).rejects.toThrow()
    }
    await service.update(conversation.id, 0, { kind: 'archive', archived: true })
    await expect(service.preview(conversation.id, { providerId: 'claude' })).rejects.toThrow('已存档')
    expect(resolveContinuationKey).not.toHaveBeenCalled()
  })
})
