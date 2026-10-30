import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { SIDE_CHAT_DEFAULT_TITLE } from '../shared/conversation'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const fixtures: SideChatFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

interface ChildFixture {
  fixture: SideChatFixture
  childId: string
  parentId: string
  source: ConversationSideChatRequest['source']
  preview: SideChatPreview
}

/** A source renamed "parent title": the child must never inherit that name. */
async function childOfParent(): Promise<ChildFixture> {
  const fixture = await sideChatFixture()
  fixtures.push(fixture)
  const parent = await fixture.service.create(fixture.cwd)
  await fixture.service.update(parent.id, parent.revision, { kind: 'rename', title: 'parent title' })
  await sendTurn(fixture, parent.id, 'parent-1', 'first question')
  const source = { kind: 'conversation' as const, conversationId: parent.id }
  const preview = await fixture.service.previewSideChat(source)
  const child = await fixture.service.createSideChat({
    source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
    commandId: 'side-chat-1'
  })
  return { fixture, childId: child.id, parentId: parent.id, source, preview }
}

describe('side-chat child title', () => {
  it('starts unset on the neutral default and keeps the source title as provenance only', async () => {
    const { fixture, childId } = await childOfParent()
    const stored = await fixture.store.read(childId)
    // Absence is the state: no copied title and no extra title state machine.
    expect(stored?.title).toBeUndefined()
    expect(stored?.sideChat?.parentTitleAtCapture).toBe('parent title')
    const listed = await fixture.service.listSideChats({ source: { kind: 'conversation', conversationId: childId } })
    expect(listed.total).toBe(0)
    const page = await fixture.service.read(childId)
    expect(page.summary.title).toBe(SIDE_CHAT_DEFAULT_TITLE)
  })

  it('takes the truncated first question during the first dispatch, without an extra model call', async () => {
    const { fixture, childId } = await childOfParent()
    const runsBefore = fixture.runs.length
    const question = `  first\n question  ${'长'.repeat(200)}  `
    await sendTurn(fixture, childId, 'child-0001', question)
    const stored = await fixture.store.read(childId)
    // Cleaned to one line, trimmed and truncated; the full prompt is not the title.
    expect(stored?.title).toBe(`first question ${'长'.repeat(200)}`.slice(0, 120))
    expect(stored?.title?.length).toBe(120)
    expect(stored?.title).not.toContain('\n')
    // Only the user's real send reached the Provider; naming issued no call of its own.
    expect(fixture.runs.length).toBe(runsBefore + 1)
  })

  it('keeps a manual rename that happened before the first send', async () => {
    const { fixture, childId } = await childOfParent()
    const page = await fixture.service.read(childId)
    await fixture.service.update(childId, page.summary.revision, { kind: 'rename', title: '手动名称' })
    await sendTurn(fixture, childId, 'child-0001', 'first question')
    expect((await fixture.store.read(childId))?.title).toBe('手动名称')
    await sendTurn(fixture, childId, 'child-0002', 'second question')
    expect((await fixture.store.read(childId))?.title).toBe('手动名称')
  })

  it('never renames from a duplicate command and leaves the source title untouched', async () => {
    const { fixture, childId, parentId } = await childOfParent()
    await sendTurn(fixture, childId, 'child-0001', 'first question')
    const before = (await fixture.store.read(childId))!
    await expect(sendTurn(fixture, childId, 'child-0001', 'another question')).rejects.toThrow('不能替换请求内容')
    const after = (await fixture.store.read(childId))!
    expect(after.title).toBe(before.title)
    expect(after.turns.length).toBe(before.turns.length)
    expect((await fixture.store.read(parentId))?.title).toBe('parent title')
  })

  it('leaves the title unset when the first dispatch carries no question text', async () => {
    const { fixture, childId } = await childOfParent()
    const page = await fixture.service.read(childId)
    const preview = await fixture.service.preview(childId, { providerId: fixture.providerId })
    const continuation = preview.continuation
    if (continuation.kind === 'blocked') throw new Error(continuation.reason)
    // A dispatch whose only user text is blank (for example an attachment-only
    // turn) must not name the child after nothing.
    await fixture.store.begin(childId, {
      expectedRevision: page.summary.revision, commandId: 'child-blank-01', runId: 'run-blank-01',
      target: preview.target, payloadHash: hash(''), items: [], selectedItems: continuation.missingItems,
      firstQuestion: '   '
    })
    expect((await fixture.store.read(childId))?.title).toBeUndefined()
    expect((await fixture.service.read(childId)).summary.title).toBe(SIDE_CHAT_DEFAULT_TITLE)
  })
})
