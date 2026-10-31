import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore } from './conversation-store'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function parentWithTurn(): Promise<{ fixture: SideChatFixture; parentId: string; preview: SideChatPreview
  source: ConversationSideChatRequest['source'] }> {
  const current = await sideChatFixture()
  fixtures.push(current)
  const parent = await current.service.create(current.cwd)
  await sendTurn(current, parent.id, 'parent-1', 'first question')
  const source = { kind: 'conversation' as const, conversationId: parent.id }
  return { fixture: current, parentId: parent.id, source, preview: await current.service.previewSideChat(source) }
}

function request(source: ConversationSideChatRequest['source'], preview: SideChatPreview, commandId = 'side-chat-1'): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

async function contentRoots(userData: string): Promise<string[]> {
  try {
    const entries = await readdir(join(userData, 'conversation-history-v1'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('side-chat creation target and child-owned cleanup', () => {
  it('persists the requested initial target instead of guessing the source model', async () => {
    const { fixture: current, source, preview } = await parentWithTurn()
    const initialTarget = { providerId: 'pi' as const, agentProfileId: 'pi:0123456789abcdef',
      model: { id: 'source-model' }, effort: 'low', permissionMode: 'default' as const }
    const child = await current.service.createSideChat({ ...request(source, preview), initialTarget })
    expect(child.sideChat?.initialTarget).toEqual(initialTarget)
    // A requested choice is not evidence about the source session's own settings.
    expect(child.sideChat?.source).toEqual(source)
    const page = await current.service.read(child.id)
    expect(page.sideChat?.initialTarget).toEqual(initialTarget)
    const reopened = new ConversationStore(current.userData)
    expect((await reopened.read(child.id))?.sideChat?.initialTarget).toEqual(initialTarget)
    // The same creation command may not silently swap the target.
    await expect(current.service.createSideChat({ ...request(source, preview), initialTarget: { providerId: 'codex' } }))
      .rejects.toThrow('不能替换内容或来源')
    expect((await current.store.list(current.cwd)).length).toBe(2)
  })

  it('keeps the sealed body when a lost acknowledgement is resolved by readback', async () => {
    const { fixture: current, source, preview } = await parentWithTurn()
    const publish = current.store.createSideChat.bind(current.store)
    vi.spyOn(current.store, 'createSideChat').mockImplementationOnce(async (seed) => {
      await publish(seed)
      throw new Error('ipc reply lost')
    })
    const child = await current.service.createSideChat(request(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect(await current.service.readItem(child.id, refs[0])).toBe('first question')
    // The child-owned body survived the lost acknowledgement.
    expect((await contentRoots(current.userData)).length).toBe(1)
  })

  it('discards a sealed body only when publication is conclusively absent', async () => {
    const { fixture: current, source, preview } = await parentWithTurn()
    const before = await contentRoots(current.userData)
    vi.spyOn(current.store, 'createSideChat').mockRejectedValueOnce(new Error('ledger write failed'))
    await expect(current.service.createSideChat(request(source, preview))).rejects.toThrow('ledger write failed')
    expect((await current.store.list(current.cwd)).length).toBe(1)
    expect(await contentRoots(current.userData)).toEqual(before)
  })

  it('discards the new body when a concurrent identical command already published', async () => {
    const { fixture: current, source, preview } = await parentWithTurn()
    const child = await current.service.createSideChat(request(source, preview))
    const before = await contentRoots(current.userData)
    // Simulate the receipt race: the early lookup misses, the publish finds the record.
    vi.spyOn(current.store, 'findSideChat').mockResolvedValueOnce(undefined).mockImplementation(
      commandId => ConversationStore.prototype.findSideChat.call(current.store, commandId))
    const duplicate = await current.service.createSideChat(request(source, preview))
    expect(duplicate.id).toBe(child.id)
    expect(await contentRoots(current.userData)).toEqual(before)
    expect((await current.store.list(current.cwd)).length).toBe(2)
  })
})
