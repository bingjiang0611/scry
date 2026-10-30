import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { SIDE_CHAT_BODY_PAGE_BYTES, SIDE_CHAT_BODY_PAGE_ITEMS } from './conversation-side-chat-snapshot'
import { readRecorderContent, writeRecorderContent } from '../core/turn-recorder/content-store'
import { conversationHistoryRoot } from './conversation-history-content'
import type { Conversation } from '../shared/conversation'

const rootOf = (fixture: SideChatFixture, conversation: Pick<Conversation, 'id' | 'cwd'>): string =>
  conversationHistoryRoot(fixture.userData, conversation)
import type { ConversationSideChatRequest, SideChatSnapshotBodyPage } from '../shared/conversation-api'

// Counts real recorder body reads: one page must not re-read the sealed body per row.
const artifactReads = vi.hoisted(() => ({ count: 0 }))
vi.mock('../core/turn-recorder/content-store', async () => {
  const actual = await vi.importActual<typeof import('../core/turn-recorder/content-store')>('../core/turn-recorder/content-store')
  return {
    ...actual,
    readRecorderContentPage: (...args: Parameters<typeof actual.readRecorderContentPage>) => {
      artifactReads.count += 1
      return actual.readRecorderContentPage(...args)
    },
    readRecorderContent: (...args: Parameters<typeof actual.readRecorderContent>) => {
      artifactReads.count += 1
      return actual.readRecorderContent(...args)
    }
  }
})

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const fixtures: SideChatFixture[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  artifactReads.count = 0
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

const LONG_MESSAGE = `长正文开头😀 ${'你😀'.repeat(70_000)} 结尾`

async function childWith(prompts: readonly string[]): Promise<{ fixture: SideChatFixture; childId: string }> {
  const fixture = await sideChatFixture()
  fixtures.push(fixture)
  const parent = await fixture.service.create(fixture.cwd)
  for (const [index, prompt] of prompts.entries()) await sendTurn(fixture, parent.id, `parent-000${index}`, prompt)
  const source: ConversationSideChatRequest['source'] = { kind: 'conversation', conversationId: parent.id }
  const preview = await fixture.service.previewSideChat(source)
  const child = await fixture.service.createSideChat({
    source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
    commandId: 'side-chat-1'
  })
  return { fixture, childId: child.id }
}

/** Real text of every frozen message, in manifest order, through the page API only. */
async function traverse(fixture: SideChatFixture, childId: string): Promise<{ pages: SideChatSnapshotBodyPage[]
  texts: string[] }> {
  const pages: SideChatSnapshotBodyPage[] = []
  const texts: string[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard++) {
    const page: SideChatSnapshotBodyPage = await fixture.service.readSideChatSnapshot(childId, cursor)
    pages.push(page)
    for (const item of page.items) {
      const index = Number(item.ref.runId.split(':').at(-1))
      texts[index] = (texts[index] ?? '') + item.text
    }
    if (!page.nextCursor) return { pages, texts }
    cursor = page.nextCursor
  }
  throw new Error('pagination did not finish')
}

/** A lone surrogate cannot survive UTF-8 encoding; the page cut must never leave one. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

describe('side-chat snapshot body pages', () => {
  it('returns real inline bodies for every frozen message in one parse per page', async () => {
    const { fixture, childId } = await childWith(['first question'])
    artifactReads.count = 0
    const { pages, texts } = await traverse(fixture, childId)
    expect(texts).toEqual(['first question', 'answer: first question'])
    // 2 rows, still one artifact load: cost is per page, not per item.
    expect(pages.length).toBe(1)
    expect(artifactReads.count).toBe(1)
  })

  it('pages a single long unicode message by continuation instead of truncating it', async () => {
    const { fixture, childId } = await childWith([LONG_MESSAGE])
    const { pages, texts } = await traverse(fixture, childId)
    expect(texts[0]).toBe(LONG_MESSAGE)
    // The split happened inside one message and was reported as a continuation.
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].items[0].continuation).toBe(true)
    expect(pages[0].nextCursor).toBeDefined()
    for (const page of pages) {
      expect(page.items.length).toBeLessThanOrEqual(SIDE_CHAT_BODY_PAGE_ITEMS)
      const bytes = page.items.reduce((total, item) => total + Buffer.byteLength(item.text, 'utf8'), 0)
      expect(bytes).toBeLessThanOrEqual(SIDE_CHAT_BODY_PAGE_BYTES)
    }
    // No lone surrogate survived the boundary: every page body is valid UTF-8 text.
    for (const page of pages) for (const item of page.items) expect(hasLoneSurrogate(item.text)).toBe(false)
  })

  it('keeps pages bounded at 40 rows and refuses cursors outside the snapshot', async () => {
    const prompts = Array.from({ length: 21 }, (_, index) => `question ${index}`)
    const { fixture, childId } = await childWith(prompts)
    const first = await fixture.service.readSideChatSnapshot(childId)
    expect(first.items.length).toBe(SIDE_CHAT_BODY_PAGE_ITEMS)
    expect(first.nextCursor).toBe(`${SIDE_CHAT_BODY_PAGE_ITEMS}:0`)
    await expect(fixture.service.readSideChatSnapshot(childId, '99:0')).rejects.toThrow('游标已越界')
    await expect(fixture.service.readSideChatSnapshot(childId, '0:999999')).rejects.toThrow('游标已越界')
    await expect(fixture.service.readSideChatSnapshot(childId, 'forged')).rejects.toThrow('游标无效')
  })

  it('refuses a body whose frozen metadata no longer matches', async () => {
    const { fixture, childId } = await childWith(['first question'])
    const stored = (await fixture.store.read(childId))!
    if (stored.sideChat?.snapshot.format !== 4) throw new Error('fixture must seal a format 4 snapshot')
    // Re-link the item leaf with a forged hash: the node is valid content and correctly
    // addressed, so the mismatch can only be caught against the frozen message body.
    const leaf = JSON.parse(await readRecorderContent(rootOf(fixture, stored), stored.sideChat.snapshot.items.root)) as {
      entries: Array<{ ref: { contentHash: string } }>
    }
    leaf.entries[0].ref.contentHash = hash('forged')
    const forged = await writeRecorderContent(rootOf(fixture, stored), JSON.stringify(leaf), 'json')
    stored.sideChat.snapshot.items.root = forged
    await fixture.store.persist(fixture.store.checked(stored))
    await expect(fixture.service.readSideChatSnapshot(childId)).rejects.toThrow()
  })

  it('reads the child-owned body after the source conversation record is gone', async () => {
    const { fixture, childId } = await childWith(['first question'])
    const child = (await fixture.store.read(childId))!
    const sourceId = (child.sideChat!.source as { conversationId: string }).conversationId
    await rm(join(fixture.userData, 'conversations', `${sourceId}.json`))
    const { texts } = await traverse(fixture, childId)
    expect(texts).toEqual(['first question', 'answer: first question'])
  })

  it('refuses a conversation that has no frozen snapshot', async () => {
    const { fixture } = await childWith(['first question'])
    const plain = await fixture.service.create(fixture.cwd)
    await expect(fixture.service.readSideChatSnapshot(plain.id)).rejects.toThrow('没有冻结的侧聊快照')
    // A malformed id never reaches the ledger; an unknown id is not a snapshot either.
    await expect(fixture.service.readSideChatSnapshot('not-a-uuid')).rejects.toThrow('对话 ID 无效')
    await expect(fixture.service.readSideChatSnapshot('11111111-2222-4333-8444-555555555555'))
      .rejects.toThrow('没有冻结的侧聊快照')
  })
})
