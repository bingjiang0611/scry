import { afterEach, describe, expect, it } from 'vitest'
import { stat } from 'node:fs/promises'
import { sendTurn, sideChatFixture, modelEvent, hash, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs, SIDE_CHAT_BODY_PAGE_ITEMS } from './conversation-side-chat-snapshot'
import { readSideChatManifestItem, readSideChatMessagePage } from './conversation-side-chat-manifest'
import { conversationHistoryRoot } from './conversation-history-content'
import { traceArchiveTurnPath, readTraceArchiveForMigration } from './transcript-archive'
import { traceArchiveCaptureInfo } from './transcript-archive-capture'
import type { Conversation } from '../shared/conversation'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(): Promise<SideChatFixture> {
  const created = await sideChatFixture()
  fixtures.push(created)
  return created
}

const TOOL_PAYLOAD = 512 * 1024
const TURNS = 36
const HUGE_VISIBLE = 5 * 1024 * 1024

/**
 * A parent whose committed archive is far past every old read budget: many turns each
 * carrying a large tool payload, plus one message whose visible text alone is > 4 MiB.
 *
 * Tool output is not visible text, so a derived snapshot must skip it without reading it;
 * the visible message must be frozen and readable in full.
 */
async function largeParent(current: SideChatFixture): Promise<Conversation> {
  const parent = await current.service.create(current.cwd)
  for (let index = 0; index < TURNS; index += 1) {
    // The event must claim the run the Provider fixture actually starts.
    current.extraEvents = runId => [{ ...modelEvent(runId, ''), id: `${runId}-tool`, kind: 'tool', stage: 'tool:Bash',
      outputContent: { storage: 'inline', content: `tool-payload-${index}:`.padEnd(TOOL_PAYLOAD, String(index % 10)) } } as never]
    await sendTurn(current, parent.id, `parent-${index}`, `question ${index}`)
  }
  await sendTurn(current, parent.id, 'parent-huge', `huge question ${'v'.repeat(HUGE_VISIBLE)}`)
  return (await current.store.read(parent.id))!
}

/** Total committed archive bytes of the parent's own turns. */
async function archiveBytes(current: SideChatFixture, parent: Conversation): Promise<number> {
  let total = 0
  for (const turn of parent.turns) {
    if (!turn.archive) continue
    const path = traceArchiveTurnPath(current.userData, current.cwd, turn.archive.sessionId, current.providerId, { runId: turn.runId })
    total += (await stat(path)).size
  }
  return total
}

function descriptorOf(record: Conversation) {
  const snapshot = record.sideChat?.snapshot
  if (!snapshot || snapshot.format !== 4) throw new Error('creation must seal a format 4 snapshot')
  return snapshot
}

/** The child's own content root; a frozen body never lives in the parent's store. */
function childRoot(current: SideChatFixture, record: Conversation): string {
  return conversationHistoryRoot(current.userData, record)
}

/** Reads one frozen message the way a viewer does: bounded pages, never one join. */
async function readFrozenBody(current: SideChatFixture, record: Conversation, index: number): Promise<string> {
  const descriptor = descriptorOf(record)
  let offset = 0
  let text = ''
  for (;;) {
    const page = await readSideChatMessagePage(childRoot(current, record), descriptor, index, offset, 256 * 1024)
    text += page.text
    if (!page.hasMore) return text
    offset = page.nextOffset
  }
}

async function sealChild(current: SideChatFixture, parentId: string, commandId: string): Promise<Conversation> {
  const source = { kind: 'conversation' as const, conversationId: parentId }
  const preview = await current.service.previewSideChat(source)
  const child = await current.service.createSideChat({
    source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId
  })
  return (await current.store.read(child.id))!
}

describe('large side-chat history through the production service', () => {
  it('freezes an archive past the old 16 MiB budget and reads its visible text back', async () => {
    const current = await fixture()
    const parent = await largeParent(current)
    const bytes = await archiveBytes(current, parent)
    expect(bytes).toBeGreaterThan(16 * 1024 * 1024)

    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(TURNS + 1)
    // Only visible user/assistant messages become frozen items; tool payloads never do.
    expect(preview.messageCount).toBe((TURNS + 1) * 2)
    expect(preview.coverage.readerAvailable).toBe(true)
    expect(preview.firstSendBlockedReason).toBeUndefined()

    const record = await sealChild(current, parent.id, 'large-history-1')
    const descriptor = descriptorOf(record)
    expect(descriptor.messageCount).toBe((TURNS + 1) * 2)
    // The 5 MiB visible message dominates the frozen bytes; the tool payloads stay out.
    expect(descriptor.bodyBytes).toBeGreaterThan(HUGE_VISIBLE)
    expect(descriptor.bodyBytes).toBeLessThan(bytes)

    const refs = await sideChatSnapshotRefs(current.userData, record)
    expect(refs.length).toBe((TURNS + 1) * 2)
    expect(await readFrozenBody(current, record, 0)).toBe('question 0')
    const hugeIndex = refs.length - 2
    const huge = await readSideChatManifestItem(childRoot(current, record), descriptor, hugeIndex)
    expect(huge.role).toBe('user')
    const text = await readFrozenBody(current, record, hugeIndex)
    expect(text.length).toBeGreaterThan(HUGE_VISIBLE)
    expect(hash(text)).toBe(huge.ref.contentHash)
    expect(text.startsWith('huge question v')).toBe(true)
    // No tool payload leaked into a frozen body.
    for (const index of [0, 1, refs.length - 1]) {
      expect(await readFrozenBody(current, record, index)).not.toContain('tool-payload-')
    }
  }, 240_000)

  it('pages the frozen viewer from the first item to the last by index only', async () => {
    const current = await fixture()
    const parent = await largeParent(current)
    const record = await sealChild(current, parent.id, 'large-history-2')
    const descriptor = descriptorOf(record)
    expect(Math.ceil(descriptor.messageCount / SIDE_CHAT_BODY_PAGE_ITEMS)).toBeGreaterThan(1)
    const last = descriptor.messageCount - 1
    const middle = Math.floor(last / 2)
    const root = childRoot(current, record)
    expect((await readSideChatManifestItem(root, descriptor, 0)).ref.runId)
      .not.toBe((await readSideChatManifestItem(root, descriptor, middle)).ref.runId)
    const lastItem = await readSideChatManifestItem(root, descriptor, last)
    expect(lastItem.role).toBe('assistant')
    expect(await readFrozenBody(current, record, last)).toBe(`answer: huge question ${'v'.repeat(HUGE_VISIBLE)}`)
    // A middle body is a real message from the parent, never a placeholder.
    expect((await readFrozenBody(current, record, middle)).length).toBeGreaterThan(0)
  }, 240_000)

  it('keeps the durable record compact instead of one reference per frozen message', async () => {
    const current = await fixture()
    const parent = await largeParent(current)
    const before = await sealChild(current, parent.id, 'large-history-3')
    // The descriptor keeps the child record itself small: no per-message refs on disk.
    expect(JSON.stringify(before).length).toBeLessThan(24_000)
    const preview = await current.service.preview(before.id, { providerId: 'claude' })
    const continuation = preview.continuation
    if (continuation.kind === 'blocked') {
      // A capability refusal is honest; it must not look like a successful empty send.
      expect(continuation.reason).not.toBe('')
      return
    }
    await current.service.send({
      conversationId: before.id, providerId: 'claude', expectedRevision: before.revision,
      expectedContinuationKey: preview.target.continuationKey, commandId: 'first-send-1', prompt: '继续',
      selectedItems: continuation.missingItems, confirmFresh: true, permissionMode: 'default'
    })
    const after = (await current.store.read(before.id))!
    const dispatched = after.turns.find(turn => turn.origin === 'dispatch')
    if (!dispatched || dispatched.origin !== 'dispatch') throw new Error('the first send must publish a dispatch turn')
    const ledger = dispatched.omittedItems.length +
      (dispatched.omittedRanges ?? []).reduce((sum, range) => sum + range.to - range.from + 1, 0)
    expect(ledger + dispatched.importedItems.length).toBe((TURNS + 1) * 2)
    // 74 frozen messages must not become 74 references in the durable record.
    expect(JSON.stringify(dispatched).length).toBeLessThan(8_000)
    expect(dispatched.omittedItems.length).toBe(0)
    // One contiguous frozen prefix stays one range however many messages it holds.
    expect((dispatched.omittedRanges ?? []).every(range => range.to > range.from)).toBe(true)
  }, 240_000)

  it('preserves the original failure for the pre-fix read path on the same archive', async () => {
    const current = await fixture()
    const parent = await largeParent(current)
    const archive = parent.turns[0].archive
    if (!archive) throw new Error('fixture turn must carry an archive')
    await expect(readTraceArchiveForMigration({
      cwd: current.cwd, sessionId: archive.sessionId, userDataDir: current.userData, providerId: current.providerId
    })).rejects.toThrow('迁移归档超过 16 MiB 读取预算')
    // The new path reads the same bytes through the streaming inventory instead.
    const info = await traceArchiveCaptureInfo({
      userDataDir: current.userData, cwd: current.cwd, sessionId: archive.sessionId, providerId: current.providerId
    })
    expect(info.totalTurns).toBe(TURNS + 1)
  }, 240_000)
})
