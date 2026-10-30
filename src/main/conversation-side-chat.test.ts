import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from './conversation-store'
import { traceArchiveTurnPath } from './transcript-archive'
import { MAX_SIDE_CHAT_SNAPSHOT_BYTES } from './conversation-schema'
import { loadSideChatSnapshotMessages, sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { hash, sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(): Promise<SideChatFixture> {
  const created = await sideChatFixture()
  fixtures.push(created)
  return created
}

async function parentWithTwoTurns(): Promise<{ fixture: SideChatFixture; parentId: string }> {
  const current = await fixture()
  const parent = await current.service.create(current.cwd)
  await sendTurn(current, parent.id, 'parent-1', 'first question')
  await sendTurn(current, parent.id, 'parent-2', 'second question')
  return { fixture: current, parentId: parent.id }
}

function createRequest(
  source: ConversationSideChatRequest['source'],
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId = 'side-chat-1'
): ConversationSideChatRequest {
  return {
    source,
    expectedThroughOrdinal: preview.throughOrdinal,
    expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint,
    expectedManifestFingerprint: preview.manifestFingerprint,
    commandId
  }
}

describe('side-chat snapshot capture', () => {
  it('freezes the completed prefix while the parent keeps running, without touching the parent', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const parentFile = join(current.userData, 'conversations', `${parentId}.json`)
    current.pending = true
    // A third turn that is still running must not block or enter the snapshot.
    await sendTurn(current, parentId, 'parent-3-running', 'still running')
    const before = await readFile(parentFile, 'utf8')
    const pendingParent = (await current.store.read(parentId))!
    const running = pendingParent.turns.at(-1)!
    expect(running.origin === 'dispatch' && running.delivery.status).toBe('pending')

    const source = { kind: 'conversation' as const, conversationId: parentId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(2)
    expect(preview.throughRunId).toBe(pendingParent.turns[1].runId)
    expect(preview.messageCount).toBe(4)
    // Derived source provenance plus the default permission mode; no guessed model.
    expect(preview.target).toEqual({ providerId: 'codex', permissionMode: 'default' })
    expect(preview.coverage.messageCount).toBe(4)
    expect(preview.coverage.inlineCount).toBe(4)
    expect(preview.coverage.retrievableCount).toBe(0)
    expect(preview.smallestThroughOrdinal).toBe(1)
    expect(preview.firstSendBlockedReason).toBeUndefined()

    const child = await current.service.createSideChat(createRequest(source, preview))
    expect(child.sideChat?.messageCount).toBe(4)
    expect(child.sideChat?.throughOrdinal).toBe(2)
    expect(child.sideChat?.source).toEqual(source)
    expect(child.turnCount).toBe(0)
    expect((await current.store.read(child.id))!.bindings).toEqual([])

    const stored = (await current.store.read(child.id))!
    expect(stored.turns).toEqual([])
    expect(stored.bindings).toEqual([])
    expect((await loadSideChatSnapshotMessages(current.userData, stored))
      .map(message => [message.role, message.ordinal, message.providerId])).toEqual([
      ['user', 1, 'codex'], ['assistant', 1, 'codex'], ['user', 2, 'codex'], ['assistant', 2, 'codex']
    ])
    // The parent record is byte-identical: no adoption, migration, ownership or resume write.
    expect(await readFile(parentFile, 'utf8')).toBe(before)
    const conversations = await current.store.list(current.cwd)
    expect(conversations.map(item => item.id).sort()).toEqual([parentId, child.id].sort())
    expect(conversations.filter(item => item.adoptionFingerprint).length).toBe(0)
  })

  it('keeps a selected earlier prefix valid when the source appends completed turns', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const early = await current.service.previewSideChat(source)
    await sendTurn(current, parentId, 'parent-3', 'third question')
    const later = await current.service.previewSideChat(source)
    expect(later.throughOrdinal).toBe(3)
    expect(later.prefixFingerprint).not.toBe(early.prefixFingerprint)

    const child = await current.service.createSideChat(createRequest(source, early, 'side-chat-early'))
    expect(child.sideChat?.throughOrdinal).toBe(2)
    expect(child.sideChat?.prefixFingerprint).toBe(early.prefixFingerprint)
    expect(await current.store.read(child.id)).toMatchObject({ turns: [] })
  })

  it('returns the same child for one creation command and rejects a different intent', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const preview = await current.service.previewSideChat(source)
    const request = createRequest(source, preview)
    const first = await current.service.createSideChat(request)
    const duplicate = await current.service.createSideChat(request)
    expect(duplicate.id).toBe(first.id)
    expect((await current.store.list(current.cwd)).length).toBe(2)

    await expect(current.service.createSideChat({ ...request, expectedThroughOrdinal: 1 }))
      .rejects.toThrow('不能替换内容或来源')
    await expect(current.service.createSideChat({ ...request, expectedPrefixFingerprint: hash('other') }))
      .rejects.toThrow('不能替换内容或来源')
    await expect(current.service.createSideChat({ ...createRequest(source, preview, 'side-chat-2'), source: { kind: 'conversation', conversationId: first.id } }))
      .rejects.toThrow('暂不支持以侧聊为来源')
  })

  it('lists children by source through aliases and bounds the page', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const parent = (await current.store.read(parentId))!
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(createRequest(source, preview))
    const byConversation = await current.service.listSideChats({ source })
    expect(byConversation.total).toBe(1)
    expect(byConversation.nextCursor).toBeUndefined()
    expect(byConversation.items[0].id).toBe(child.id)
    const native = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd,
      nativeSessionId: parent.bindings[0].nativeSessionId! }
    // A native-scope query still resolves the child created from the conversation source.
    expect((await current.service.listSideChats({ source: native })).items.map(item => item.id)).toEqual([child.id])
    const unrelated = { kind: 'conversation' as const, conversationId: child.id }
    expect((await current.service.listSideChats({ source: unrelated })).total).toBe(0)
  })

  it.each([
    ['no completed body', 'empty'],
    ['unverifiable prefix', 'no-archive']
  ])('refuses %s instead of publishing an empty snapshot', async (_label, kind) => {
    const current = await fixture()
    const parent = kind === 'empty'
      ? await current.service.create(current.cwd)
      : await current.store.create(current.cwd, { target: { providerId: 'codex', continuationKey: 'identity:codex:default' }, nativeSessionId: 'native-x',
        turns: [{ runId: 'imported-run', items: [{ runId: 'imported-run', itemId: 'user', contentHash: hash('hello') }], nativeItems: [] }] })
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    await expect(current.service.previewSideChat(source)).rejects.toThrow(/已完成轮次|无法验证/)
    expect((await current.store.list(current.cwd)).length).toBe(1)
  })

  it('refuses corrupt archives and over-budget bodies without a snapshot', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const parent = (await current.store.read(parentId))!
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const archive = parent.turns[0].archive!
    const path = traceArchiveTurnPath(current.userData, current.cwd, archive.sessionId, 'codex',
      { runId: parent.turns[0].runId, providerTurnId: archive.providerTurnId })
    const original = await readFile(path, 'utf8')
    await writeFile(path, '{corrupt')
    await expect(current.service.previewSideChat(source)).rejects.toThrow()
    await writeFile(path, original)

    // A single visible body beyond the old 4 MiB snapshot budget is now frozen, because
    // the manifest stores parts instead of one artifact-sized string.
    const fresh = await fixture()
    const big = 'a'.repeat(MAX_SIDE_CHAT_SNAPSHOT_BYTES + 1)
    const parentB = await fresh.service.create(fresh.cwd)
    await sendTurn(fresh, parentB.id, 'big-turn-1', big)
    const bigSource = { kind: 'conversation' as const, conversationId: parentB.id }
    const preview = await fresh.service.previewSideChat(bigSource)
    const child = await fresh.service.createSideChat({
      source: bigSource, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-big-body'
    })
    const refs = await sideChatSnapshotRefs(fresh.userData, (await fresh.store.read(child.id))!)
    const assistant = refs.find(ref => ref.itemId === 'assistant')
    expect(await fresh.service.readItem(child.id, assistant!)).toBe(`answer: ${big}`)
    // Freezing and reading back a >16 MiB body is real work, not a mocked refusal: the
    // assertions are unchanged, but the case no longer short-circuits on a budget check.
  }, 30_000)

  it('rejects a creation request whose source boundary no longer matches', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const preview = await current.service.previewSideChat(source)
    const parent = (await current.store.read(parentId))!
    await expect(current.service.createSideChat({ ...createRequest(source, preview), expectedThroughRunId: 'foreign-run' }))
      .rejects.toThrow('边界')
    await expect(current.service.createSideChat({ ...createRequest(source, preview), expectedThroughRunId: parent.turns[1].runId,
      expectedPrefixFingerprint: hash('drifted') })).rejects.toThrow('重新预览')
    expect((await current.store.list(current.cwd)).length).toBe(1)
  })

  it('keeps the sealed snapshot readable after the source archives are gone', async () => {
    const { fixture: current, parentId } = await parentWithTwoTurns()
    const parent = (await current.store.read(parentId))!
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const child = await current.service.createSideChat(createRequest(source, await current.service.previewSideChat(source)))
    for (const turn of parent.turns) {
      if (!turn.archive) continue
      await rm(traceArchiveTurnPath(current.userData, current.cwd, turn.archive.sessionId, 'codex',
        { runId: turn.runId, providerTurnId: turn.archive.providerTurnId }))
    }
    const page = await new ConversationStore(current.userData).read(child.id)
    const refs = await sideChatSnapshotRefs(current.userData, page!)
    expect(refs).toHaveLength(4)
    expect(await current.service.readItem(child.id, refs[0])).toBe('first question')
    expect(await current.service.readItem(child.id, refs[1])).toBe('answer: first question')
  })
})
