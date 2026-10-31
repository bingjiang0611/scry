import { afterEach, describe, expect, it, vi } from 'vitest'
import { hash, modelEvent, sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { upsertTraceArchiveTurn } from './transcript-archive'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(): Promise<SideChatFixture> {
  const created = await sideChatFixture()
  fixtures.push(created)
  return created
}

function request(source: ConversationSideChatRequest['source'], preview: SideChatPreview, commandId: string): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

/** Parent plus three children with deterministic, distinct capture times. */
async function parentWithThreeChildren(): Promise<{ fixture: SideChatFixture; parentId: string; ids: string[] }> {
  const current = await fixture()
  const parent = await current.service.create(current.cwd)
  await sendTurn(current, parent.id, 'parent-1', 'first question')
  const source = { kind: 'conversation' as const, conversationId: parent.id }
  const preview = await current.service.previewSideChat(source)
  const now = vi.spyOn(Date, 'now')
  const ids: string[] = []
  for (const [index, commandId] of ['side-chat-1', 'side-chat-2', 'side-chat-3'].entries()) {
    now.mockReturnValue(1_700_000_000_000 + index * 1000)
    ids.push((await current.service.createSideChat(request(source, preview, commandId))).id)
  }
  return { fixture: current, parentId: parent.id, ids }
}

describe('side-chat history paging', () => {
  it('pages children by a stable cursor instead of truncating at 40', async () => {
    const { fixture: current, parentId, ids } = await parentWithThreeChildren()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const first = await current.service.listSideChats({ source, limit: 2 })
    expect(first.total).toBe(3)
    expect(first.items.map(item => item.id)).toEqual([ids[2], ids[1]])
    // The cursor is the last returned child, not the page boundary ordinal.
    expect(first.nextCursor).toBe(`1700000001000:${ids[1]}`)
    const second = await current.service.listSideChats({ source, limit: 2, cursor: first.nextCursor })
    expect(second.items.map(item => item.id)).toEqual([ids[0]])
    expect(second.nextCursor).toBeUndefined()
    // Default page size is 40 and every child is reachable exactly once.
    const all = await current.service.listSideChats({ source })
    expect(all.items.map(item => item.id)).toEqual([ids[2], ids[1], ids[0]])
    await expect(current.service.listSideChats({ source, limit: 0 })).rejects.toThrow('分页大小')
    await expect(current.service.listSideChats({ source, limit: 101 })).rejects.toThrow('分页大小')
    await expect(current.service.listSideChats({ source, cursor: 'not-a-cursor' })).rejects.toThrow('游标')
    await expect(current.service.listSideChats({ source, cursor: `1700000002000:${hash('x').slice(0, 8)}` }))
      .rejects.toThrow('游标')
  })

  it('answers a bounded selected-id lookup inside the source membership check', async () => {
    const { fixture: current, parentId, ids } = await parentWithThreeChildren()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const other = { kind: 'conversation' as const, conversationId: '99999999-2222-4333-8444-555555555555' }
    const restored = await current.service.listSideChats({ source, ids: [ids[2], ids[0]] })
    expect(restored.total).toBe(2)
    expect(restored.items.map(item => item.id)).toEqual([ids[2], ids[0]])
    expect(restored.nextCursor).toBeUndefined()
    // A child of another source is never returned just because its id was asked for.
    const foreign = await current.service.listSideChats({ source: other, ids: [ids[2]] }).catch(() => undefined)
    expect(foreign?.items ?? []).toEqual([])
    // An id that is not in this source is absent, not an error and not a deletion claim.
    await expect(current.service.listSideChats({ source, ids: ['11111111-2222-4333-8444-555555555555'] }))
      .resolves.toMatchObject({ total: 0, items: [] })
    await expect(current.service.listSideChats({ source, ids: Array.from({ length: 9 }, (_, index) => `id-${index}`) }))
      .rejects.toThrow('8 个 ID')
  })

  it('keeps archived children listed and excludes completely deleted ones', async () => {
    const { fixture: current, parentId, ids } = await parentWithThreeChildren()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const archived = (await current.store.read(ids[0]))!
    await current.service.update(ids[0], archived.revision, { kind: 'archive', archived: true })
    const deleted = (await current.store.read(ids[1]))!
    await current.store.updateMetadata(ids[1], deleted.revision, { kind: 'archive', archived: true })
    const archivedChild = (await current.store.read(ids[1]))!
    const fingerprint = hash('side-chat-deletion')
    await current.store.beginDeletion(ids[1], archivedChild.revision, fingerprint)
    await current.store.finishDeletion(ids[1], fingerprint, { ok: true, deleted: [], retained: [], failed: [] })
    const page = await current.service.listSideChats({ source })
    expect(page.total).toBe(2)
    expect(page.items.map(item => item.id)).toEqual([ids[2], ids[0]])
    expect(page.items[1].archivedAt).toBeDefined()
  })

  it('restores children from their own frozen provenance after the source is deleted', async () => {
    const { fixture: current, parentId, ids } = await parentWithThreeChildren()
    const parent = (await current.store.read(parentId))!
    const nativeSessionId = parent.bindings[0].nativeSessionId!
    await current.service.update(parentId, parent.revision, { kind: 'archive', archived: true })
    const archived = (await current.store.read(parentId))!
    const fingerprint = hash('parent-deletion')
    await current.store.beginDeletion(parentId, archived.revision, fingerprint)
    await current.store.finishDeletion(parentId, fingerprint, { ok: true, deleted: [], retained: [], failed: [] })
    expect((await current.store.read(parentId))?.deletion?.status).toBe('complete')

    const byConversation = await current.service.listSideChats({ source: { kind: 'conversation', conversationId: parentId } })
    expect(byConversation.items.map(item => item.id)).toEqual([ids[2], ids[1], ids[0]])
    // A later independent lookup by the frozen native identity still finds the same children.
    const byNative = await current.service.listSideChats({ source: { kind: 'native-session', providerId: 'codex',
      cwd: current.cwd, nativeSessionId } })
    expect(byNative.items.map(item => item.id)).toEqual([ids[2], ids[1], ids[0]])
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(ids[0]))!)
    expect(await current.service.readItem(ids[0], refs[0])).toBe('first question')
  })

  it('resolves one source scope by reading only the owners it names', async () => {
    const current = await fixture()
    const sessionId = 'owned-native-session'
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'codex',
      turn: { runId: 'owned-run-1', userText: 'native parent question',
        items: [modelEvent('owned-run-1', 'native parent answer')], done: true, status: 'completed', ts: Date.now() } })
    const source = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const child = await current.service.createSideChat(request(source, await current.service.previewSideChat(source),
      'side-chat-owned-native'))
    // One conversation really binds this native tuple; every other owner is unrelated.
    const adopted = await current.store.create(current.cwd, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
      nativeSessionId: sessionId, title: 'adopted parent', turns: [] })
    const addUnrelatedOwners = async (from: number, count: number): Promise<void> => {
      for (let index = from; index < from + count; index += 1) {
        await current.store.create(current.cwd, {
          target: { providerId: 'codex', continuationKey: `identity:codex:unrelated-${index}` },
          nativeSessionId: `unrelated-native-${index}`, turns: [] })
      }
    }
    await addUnrelatedOwners(0, 24)
    // Read-through counting: the assertion is real work avoided, not a claim about code shape.
    const reads = new Map<string, number>()
    const list = current.store.list.bind(current.store)
    vi.spyOn(current.store, 'list').mockImplementation(async cwd => (await list(cwd)).map(conversation =>
      new Proxy(conversation, { get(target, property, receiver) {
        if (property === 'bindings') reads.set(target.id, (reads.get(target.id) ?? 0) + 1)
        return Reflect.get(target, property, receiver)
      } })))

    // Listing a native-origin child by its native scope binds no owner at all.
    expect((await current.service.listSideChats({ source })).items.map(item => item.id)).toEqual([child.id])
    expect([...reads]).toEqual([])
    // Asking by the adopting conversation id reads that one owner and nothing else.
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: adopted.id } }))
      .items.map(item => item.id)).toEqual([child.id])
    expect([...reads]).toEqual([[adopted.id, 1]])
    // The cost does not follow history size: twice the unrelated owners change nothing.
    await addUnrelatedOwners(24, 24)
    reads.clear()
    expect((await current.service.listSideChats({ source })).total).toBe(1)
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: adopted.id } })).total)
      .toBe(1)
    expect([...reads]).toEqual([[adopted.id, 1]])
    // The fence is unchanged: an owner that does not bind this tuple finds nothing.
    const otherSession = await current.store.create(current.cwd, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
      nativeSessionId: 'another-native-session', turns: [] })
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: otherSession.id } })).total)
      .toBe(0)
  })
})
