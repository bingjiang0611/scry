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

describe('side-chat snapshot boundary and handoff budget', () => {
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

  it('freezes a prefix beyond the old 4 MiB body budget without narrowing it', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    // Three ~3 MiB turns are ~9 MiB of visible text, more than twice the removed 4 MiB cap.
    const body = 'y'.repeat(1_500_000)
    for (const index of [1, 2, 3]) await sendTurn(current, parent.id, `parent-${index}`, `${body} ${index}`)
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    // The prefix is streamed into the manifest, so its size is not a resident budget and
    // the preview no longer offers a smaller prefix as the only way forward.
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(3)
    expect(preview.messageCount).toBe(6)
    const child = await current.service.createSideChat(request(source, preview))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.snapshot.throughOrdinal).toBe(3)
    expect(stored.sideChat?.snapshot.format === 4 ? stored.sideChat.snapshot.messageCount : 0).toBe(6)
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await current.service.readItem(child.id, refs.at(-1)!)).toBe(`answer: ${body} 3`)
    // An explicit boundary still means exactly that boundary.
    const explicit = await current.service.previewSideChat(source, { completedThroughOrdinal: 1 })
    expect(explicit.throughOrdinal).toBe(1)
    // 9 MiB of visible text is streamed twice (preview, then the seal) plus the read-back;
    // measured ~2.7 s idle, so the 5 s default is the artifact here, not the work.
  }, 60_000)

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
