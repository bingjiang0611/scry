import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function created(): Promise<{ fixture: SideChatFixture; parentId: string; childId: string
  source: ConversationSideChatRequest['source']; preview: SideChatPreview }> {
  const fixture = await sideChatFixture()
  fixtures.push(fixture)
  const parent = await fixture.service.create(fixture.cwd)
  await sendTurn(fixture, parent.id, 'parent-0001', 'first question')
  const source = { kind: 'conversation' as const, conversationId: parent.id }
  const preview = await fixture.service.previewSideChat(source)
  const child = await fixture.service.createSideChat({
    source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
    commandId: 'side-chat-1'
  })
  return { fixture, parentId: parent.id, childId: child.id, source, preview }
}

describe('side-chat creation command lookup', () => {
  it('finds the same child from its command id without creating another one', async () => {
    const { fixture, childId, source } = await created()
    const runsBefore = fixture.runs.length
    const receipt = await fixture.service.findSideChatCommand(source, 'side-chat-1')
    expect(receipt).toMatchObject({ commandId: 'side-chat-1', status: 'found' })
    if (receipt.status !== 'found') throw new Error('unreachable')
    expect(receipt.conversation.id).toBe(childId)
    expect(receipt.conversation.sideChat?.parentTitleAtCapture).toBeTruthy()
    expect((await fixture.store.list(fixture.cwd)).length).toBe(2)
    // Read-only: no Provider call and no second child.
    expect(fixture.runs.length).toBe(runsBefore)
  })

  it('answers not-found without creating a child and without claiming the input was unsent', async () => {
    const { fixture, source } = await created()
    const receipt = await fixture.service.findSideChatCommand(source, 'side-chat-unknown')
    expect(receipt).toEqual({ commandId: 'side-chat-unknown', status: 'not-found' })
    expect((await fixture.store.list(fixture.cwd)).length).toBe(2)
  })

  it('refuses a command that belongs to another source', async () => {
    const { fixture, source } = await created()
    const other = await fixture.service.create(fixture.cwd)
    await expect(fixture.service.findSideChatCommand({ kind: 'conversation', conversationId: other.id }, 'side-chat-1'))
      .rejects.toThrow('不属于此来源')
    await expect(fixture.service.findSideChatCommand(source, '../../etc/passwd')).rejects.toThrow('侧聊创建命令无效')
  })

  it('still resolves after the source conversation record is deleted', async () => {
    const { fixture, parentId, childId, source } = await created()
    await rm(join(fixture.userData, 'conversations', `${parentId}.json`))
    const receipt = await fixture.service.findSideChatCommand(source, 'side-chat-1')
    expect(receipt.status).toBe('found')
    if (receipt.status !== 'found') throw new Error('unreachable')
    expect(receipt.conversation.id).toBe(childId)
    // Listing keeps working from the children's own frozen provenance as well.
    expect((await fixture.service.listSideChats({ source })).total).toBe(1)
  })
})
