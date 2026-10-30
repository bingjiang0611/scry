import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(): Promise<SideChatFixture> {
  const created = await sideChatFixture()
  fixtures.push(created)
  return created
}

function request(source: ConversationSideChatRequest['source'], preview: SideChatPreview, commandId = 'side-chat-1'): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

async function contentRoots(userData: string): Promise<string[]> {
  try {
    return (await readdir(join(userData, 'conversation-history-v1'), { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

describe('side-chat preview narrowing and handoff budget', () => {
  it('previews a smaller completed range and creation keeps that boundary', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    for (const index of [1, 2, 3]) await sendTurn(current, parent.id, `parent-${index}`, `question ${index}`)
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const full = await current.service.previewSideChat(source)
    expect(full.smallestThroughOrdinal).toBe(1)
    const narrow = await current.service.previewSideChat(source, { completedThroughOrdinal: 1 })
    expect(narrow.throughOrdinal).toBe(1)
    expect(narrow.messageCount).toBe(2)
    expect(narrow.prefixFingerprint).not.toBe(full.prefixFingerprint)
    await expect(current.service.previewSideChat(source, { completedThroughOrdinal: 0 })).rejects.toThrow('截止轮次')
    await expect(current.service.previewSideChat(source, { completedThroughOrdinal: 1, file: '/etc/passwd' }))
      .rejects.toThrow('字段不受支持')
    const child = await current.service.createSideChat(request(source, narrow))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.snapshot.throughOrdinal).toBe(1)
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['question 1', 'answer: question 1'])
  })

  it('separates inline coverage from reader-only coverage and refuses undeliverable targets', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    const body = 'x'.repeat(20_000)
    for (const index of [1, 2, 3]) await sendTurn(current, parent.id, `parent-${index}`, `${body} ${index}`)
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const withReader = await current.service.previewSideChat(source, { initialTarget: { providerId: 'claude' } })
    expect(withReader.coverage.readerAvailable).toBe(true)
    expect(withReader.coverage.retrievableCount).toBeGreaterThan(0)
    expect(withReader.coverage.inlineCount).toBeLessThan(withReader.coverage.messageCount)
    expect(withReader.coverage.inlineCount + withReader.coverage.retrievableCount).toBe(withReader.coverage.messageCount)
    expect(withReader.firstSendBlockedReason).toBeUndefined()

    const noReader = new (current.service.constructor as typeof import('./conversation-service').ConversationService)({
      store: current.store,
      resolveContinuationKey: async ({ providerId }) => `identity:${providerId}:default`,
      supportsHistoricalInput: () => true,
      supportsHistoryReader: () => false,
      startAppRun: async () => { throw new Error('no Provider may start here') }
    })
    const blocked = await noReader.previewSideChat(source, { initialTarget: { providerId: 'qoder' } })
    expect(blocked.firstSendBlockedReason).toContain('没有已验证的历史检索工具')
    const roots = await contentRoots(current.userData)
    await expect(noReader.createSideChat(request(source, blocked))).rejects.toThrow('没有已验证的历史检索工具')
    // Refused before publication: no child record and no sealed child body.
    expect((await current.store.list(current.cwd)).length).toBe(1)
    expect(await contentRoots(current.userData)).toEqual(roots)
  })

  it('narrows only on a real budget refusal and keeps an explicit boundary exact', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    // Three ~3 MiB turns exceed the 4 MiB snapshot budget; one turn still fits it.
    const body = 'y'.repeat(1_500_000)
    for (const index of [1, 2, 3]) await sendTurn(current, parent.id, `parent-${index}`, `${body} ${index}`)
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    // The bounded source read is a tagged budget boundary, not prose: three large turns
    // exhaust it, and the preview answers with the smallest frozen prefix that fits.
    const narrowed = await current.service.previewSideChat(source)
    expect(narrowed.narrowed?.message).toContain('4 MiB 读取预算')
    expect(narrowed.throughOrdinal).toBe(1)
    expect(narrowed.messageCount).toBe(2)
    // The explicit smaller boundary the user chose stays exactly that boundary.
    const child = await current.service.createSideChat(request(source, narrowed))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.snapshot.throughOrdinal).toBe(1)
    expect(stored.sideChat?.snapshot.format === 4 ? stored.sideChat.snapshot.messageCount : 0).toBe(2)
    // An unknown failure never becomes a successful narrowing: an explicit boundary that
    // still exceeds the budget is reported, not silently replaced by a smaller prefix.
    await expect(current.service.previewSideChat(source, { completedThroughOrdinal: 3 }))
      .rejects.toThrow('4 MiB 读取预算')
  })

  it('measures the sealed artifact with one authority for preview and creation', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'parent-1', 'question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(request(source, preview))
    const stored = (await current.store.read(child.id))!
    if (stored.sideChat?.snapshot.format !== 4) throw new Error('creation must seal a format 4 snapshot')
    // Preview and the sealed record agree on the same counts and body bytes.
    expect(stored.sideChat.snapshot.messageCount).toBe(preview.messageCount)
    expect(stored.sideChat.snapshot.bodyBytes).toBe(preview.bodyBytes)
    expect(preview.coverage.snapshotByteLimit).toBe(4 * 1024 * 1024)
    expect(preview.coverage.handoffBudgetBytes).toBeGreaterThan(0)
  })
})
