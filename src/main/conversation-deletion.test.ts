import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore, decodeConversation } from './conversation-store'
import { ConversationService } from './conversation-service'
import { deleteConversationHistory } from './conversation-history'
import { planConversationDeletion, resolveConversationDeletionRuns } from './conversation-deletion'
import { planConversationContinuation } from '../shared/conversation'
import type { Conversation, ConversationDeletionResult } from '../shared/conversation'
import * as io from '../core/turn-recorder/io'

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let directory: string
let userData: string
let cwd: string
let store: ConversationStore
const success: ConversationDeletionResult = { ok: true, deleted: ['frozen handoff bodies'], retained: ['ownership tombstone'], failed: [] }
const seed = (nativeSessionId: string, archiveSessionId = nativeSessionId) => store.create(cwd, {
  target: { providerId: 'codex', continuationKey: 'identity' }, nativeSessionId, archivedAt: 1,
  turns: [{ runId: 'captured-run', archive: { sessionId: archiveSessionId }, items: [{ runId: 'captured-run', itemId: 'user', contentHash: hash('prompt') }], nativeItems: [] }]
})
const cachePath = (conversation: Conversation) => join(userData, 'conversation-history-v1', hash(JSON.stringify([conversation.id, cwd])))

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'scry-conversation-delete-'))
  userData = join(directory, 'app')
  await mkdir(join(directory, 'workspace'))
  cwd = await realpath(join(directory, 'workspace'))
  store = new ConversationStore(userData)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }) })

describe('logical deletion scope and durable fence', () => {
  it('derives native scopes before archive aliases, preserving the correct run ownership', async () => {
    const conversation = await seed('native', 'archive-alias')
    const preview = planConversationDeletion(conversation, [conversation])
    expect(preview.targets.map(target => [target.externalSessionId, target.runIds])).toEqual([
      ['native', ['captured-run']], ['archive-alias', []]
    ])
    expect(preview.targets.every(target => target.sharedWith.length === 0)).toBe(true)
    expect(planConversationDeletion({ ...conversation, revision: 1 }, [conversation]).fingerprint).not.toBe(preview.fingerprint)
  })

  it('retains the whole physical binding when another logical conversation references its archive', async () => {
    const original = await seed('native-original', 'shared-archive')
    const branch = await seed('native-branch', 'shared-archive')
    const plan = planConversationDeletion(original, [original, branch])
    expect(plan.targets.every(target => target.sharedWith.includes(branch.id))).toBe(true)
    expect(plan.fingerprint).not.toBe(planConversationDeletion(original, [original]).fingerprint)
    const deletedBranch = { ...branch, deletion: { status: 'complete' as const, fingerprint: hash('delete'), result: success } }
    expect(planConversationDeletion(original, [original, deletedBranch]).targets.every(target => target.sharedWith.length === 0)).toBe(true)
  })

  it('retains evidence shared through run IDs, including an in-progress deletion', async () => {
    const original = await seed('native-original')
    const other = await seed('other-native', 'different-archive')
    await store.beginDeletion(other.id, other.revision, hash('operation'))
    const pending = (await store.read(other.id))!
    expect(planConversationDeletion(original, [original, pending]).targets[0].sharedWith).toEqual([other.id])
  })

  it('retains the entire evidence group when database-discovered runs reveal an otherwise hidden shared reference', async () => {
    const original = await seed('native', 'archive-alias')
    const other = await seed('other-native')
    other.turns[0].runId = 'hidden-run'
    other.turns[0].items[0].runId = 'hidden-run'
    const preview = planConversationDeletion(original, [original, other])
    expect(preview.targets.every(target => !target.sharedWith.length)).toBe(true)
    const resolved = resolveConversationDeletionRuns(preview, target => ({ status: 'ready', conflicts: [], runIds: target.externalSessionId === 'native' ? ['hidden-run'] : [] }), [other])
    expect(resolved.targets.every(target => target.sharedWith.includes(other.id))).toBe(true)
  })

  it('refuses unavailable or conflicting database ownership without inventing a clean scope', async () => {
    const original = await seed('native')
    const preview = planConversationDeletion(original, [])
    expect(() => resolveConversationDeletionRuns(preview, () => ({ status: 'unavailable', conflicts: [], runIds: [], error: 'db unavailable' }))).toThrow('db unavailable')
    expect(() => resolveConversationDeletionRuns(preview, () => ({ status: 'ready', conflicts: ['foreign-run'], runIds: [] }))).toThrow('foreign-run')
  })

  it('does not delete a physical native scope used by another catalog profile', async () => {
    const conversation = await seed('native')
    const plan = planConversationDeletion(conversation, [conversation], [{ providerId: 'codex', agentProfileId: 'named', cwd,
      sessionId: 'native', externalSessionId: 'native', preview: 'another profile', ts: 1 }])
    expect(plan.targets[0].sharedWith).toEqual(['profile:named'])
    const namedScope = { providerId: 'codex' as const, agentProfileId: 'named', cwd, nativeSessionId: 'native' }
    await expect(store.assertLegacyWriteAllowed(namedScope)).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed(namedScope, {})).rejects.toThrow('归属统一对话')
  })

  it('rejects unarchived plans and malformed successful tombstones', async () => {
    const conversation = await store.create(cwd)
    expect(() => planConversationDeletion(conversation, [])).toThrow('先存档')
    expect(() => decodeConversation({ ...conversation, archivedAt: 1, deletion: { status: 'complete', fingerprint: hash('d') } })).toThrow()
    expect(() => decodeConversation({ ...conversation, archivedAt: 1, deletion: { status: 'complete', fingerprint: hash('d'), result: { ...success, failed: [{ store: 'archive', error: 'failed' }] } } })).toThrow()
  })

  it('keeps a failed deletion fenced and resumable across a cold store, then retains ownership after completion', async () => {
    let conversation = await seed('native')
    const fingerprint = planConversationDeletion(conversation, []).fingerprint
    conversation = await store.beginDeletion(conversation.id, conversation.revision, fingerprint)
    await expect(store.updateMetadata(conversation.id, conversation.revision, { kind: 'archive', archived: false })).rejects.toThrow('正在删除')
    await store.finishDeletion(conversation.id, fingerprint, { ...success, ok: false, reason: 'partial_failure', failed: [{ store: 'archive', error: 'read only' }] })
    store = new ConversationStore(userData)
    conversation = (await store.read(conversation.id))!
    expect(conversation.deletion?.status).toBe('pending')
    expect(planConversationContinuation(conversation, conversation.bindings[0]).kind).toBe('blocked')
    const retry = planConversationDeletion(conversation, [])
    await store.beginDeletion(conversation.id, retry.revision, retry.fingerprint)
    await store.finishDeletion(conversation.id, retry.fingerprint, success)
    const completed = (await new ConversationStore(userData).read(conversation.id))!
    expect(completed.deletion?.status).toBe('complete')
    await expect(store.assertLegacyWriteAllowed({ providerId: 'codex', cwd, nativeSessionId: 'native' })).rejects.toThrow('归属')
    await expect(store.assertLegacyWriteAllowed({ providerId: 'codex', cwd, nativeSessionId: 'captured-run' })).rejects.toThrow('归属')
  })

  it('authorizes only a pending owned scope and never bypasses another unknown writer', async () => {
    const conversation = await seed('native')
    const scope = { providerId: 'codex' as const, cwd, nativeSessionId: 'native' }
    await expect(store.assertLegacyWriteAllowed(scope, { ownerId: conversation.id })).rejects.toThrow('删除授权')
    await store.beginDeletion(conversation.id, 0, hash('operation'))
    await expect(store.assertLegacyWriteAllowed(scope, { ownerId: conversation.id })).resolves.toBeUndefined()
    await expect(store.assertLegacyWriteAllowed({ ...scope, nativeSessionId: 'foreign' }, { ownerId: conversation.id })).rejects.toThrow('不属于')
    const other = await store.create(cwd)
    await store.begin(other.id, { expectedRevision: 0, runId: 'unknown-run', commandId: 'unknown-command', target: { providerId: 'codex', agentProfileId: 'named', continuationKey: 'other' }, payloadHash: hash('prompt'), items: [], selectedItems: [] })
    await store.recover(other.id, new Set())
    await expect(store.assertLegacyWriteAllowed(scope, { ownerId: conversation.id })).rejects.toThrow('未确认投递')
    const current = await store.list()
    expect(() => planConversationDeletion(conversation, current)).toThrow('未确认投递')
  })

  it('does not publish a deletion fence when durable intent publication fails', async () => {
    const conversation = await seed('native')
    vi.spyOn(io, 'writeJsonAtomic').mockRejectedValueOnce(new Error('disk failure'))
    await expect(store.beginDeletion(conversation.id, 0, hash('delete'))).rejects.toThrow('disk failure')
    expect((await new ConversationStore(userData).read(conversation.id))?.deletion).toBeUndefined()
  })

  it('hides tombstones from the catalog and refuses body reads, sends, and runtime preparation', async () => {
    const conversation = await seed('native')
    const loadItemText = vi.fn(async () => 'must not load')
    const resolveContinuationKey = vi.fn(async () => 'identity')
    const service = new ConversationService({ store, resolveContinuationKey, loadItemText, supportsHistoricalInput: () => true, startAppRun: vi.fn() })
    await store.beginDeletion(conversation.id, 0, hash('delete'))
    await store.finishDeletion(conversation.id, hash('delete'), success)
    expect(await service.list(cwd)).toEqual([])
    expect((await service.read(conversation.id)).turns).toEqual([])
    await expect(service.readItem(conversation.id, conversation.turns[0].items[0])).rejects.toThrow('正文不可用')
    await expect(service.send({ conversationId: conversation.id, expectedRevision: 0, providerId: 'codex', expectedContinuationKey: 'identity',
      commandId: 'deleted-command', prompt: 'never execute', selectedItems: [], confirmFresh: false })).rejects.toThrow('不能发送')
    expect(loadItemText).not.toHaveBeenCalled()
    expect(resolveContinuationKey).not.toHaveBeenCalled()
  })
})

describe('private frozen handoff deletion', () => {
  it('removes only the owned conversation directory and leaves workspace canonical evidence untouched', async () => {
    const conversation = await seed('native')
    const target = cachePath(conversation)
    await mkdir(target, { recursive: true })
    await mkdir(join(cwd, '.scry'))
    await writeFile(join(target, 'body'), 'private context')
    await writeFile(join(cwd, '.scry', 'canonical'), 'keep')
    await deleteConversationHistory(userData, conversation)
    await expect(readFile(join(target, 'body'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(cwd, '.scry', 'canonical'), 'utf8')).toBe('keep')
    await expect(deleteConversationHistory(userData, conversation)).resolves.toBeUndefined()
  })

  it.each(['parent', 'conversation'])('refuses a %s symlink instead of deleting its canonical target', async kind => {
    const conversation = await seed('native')
    const outside = join(directory, 'keep')
    await mkdir(outside)
    await writeFile(join(outside, 'marker'), 'do not remove')
    const parent = join(userData, 'conversation-history-v1')
    if (kind === 'conversation') await mkdir(parent)
    await symlink(outside, kind === 'parent' ? parent : cachePath(conversation))
    await expect(deleteConversationHistory(userData, conversation)).rejects.toThrow('拒绝删除')
    expect(await readFile(join(outside, 'marker'), 'utf8')).toBe('do not remove')
  })
})
