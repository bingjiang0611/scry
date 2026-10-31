import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as contentStore from '../core/turn-recorder/content-store'
import {
  conversationItemKey, sideChatSnapshotRunId, splitOmittedItems,
  type Conversation, type ConversationItemRef, type DispatchedConversationTurn, type SideChatSnapshotManifest
} from '../shared/conversation'
import { conversationHistoryRoot } from './conversation-history-content'
import { loadConversationHistory, prepareConversationHandoff } from './conversation-history'
import { decodeConversation } from './conversation-schema'
import { SideChatSnapshotWriter } from './conversation-side-chat-manifest'
import { sealSink } from './conversation-side-chat-capture'
import { readSideChatManifestItems } from './conversation-side-chat-manifest'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const conversationId = '33333333-3333-4333-8333-333333333333'
const snapshotId = '44444444-4444-4444-8444-444444444444'
const cwd = '/tmp/handoff-workspace'
const COUNT = 400
// One message is far larger than any handoff budget, so selection must skip it from
// stored size alone instead of loading it.
const HUGE_INDEX = 17
const HUGE = `巨大消息${'内容'.repeat(1_500_000)}`
const origin = { id: conversationId, cwd }

let userData: string
let snapshot: SideChatSnapshotManifest
let conversation: Conversation

const textAt = (index: number): string => index === HUGE_INDEX ? HUGE : `message ${index} ${'x'.repeat(index % 7 === 0 ? 3_000 : 20)}`

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'scry-handoff-'))
  const writer = new SideChatSnapshotWriter({
    dataRoot: conversationHistoryRoot(userData, origin),
    identity: { id: snapshotId, prefixFingerprint: sha('prefix'), throughOrdinal: COUNT / 2, throughRunId: 'run-last', capturedAt: 1 }
  })
  const sink = sealSink(writer, snapshotId)
  for (let index = 0; index < COUNT; index += 1) {
    const role = index % 2 === 0 ? 'assistant' : 'user'
    const text = textAt(index)
    await sink.append({
      role, contentHash: sha(text), bytes: Buffer.byteLength(text, 'utf8'),
      text: (async function* () { yield text })()
    }, {
      role, sourceRunId: sideChatSnapshotRunId(snapshotId, index), sourceOrdinal: Math.floor(index / 2) + 1,
      providerId: 'claude', status: 'completed', delivery: 'snapshot'
    })
  }
  snapshot = await writer.seal()
  conversation = {
    version: 1, id: conversationId, cwd, revision: 1, bindings: [], turns: [],
    sideChat: {
      source: { kind: 'native-session', providerId: 'claude', cwd, nativeSessionId: 'session-1' },
      parentTitleAtCapture: 'source', initialTarget: { providerId: 'claude' }, snapshot,
      commandId: 'side-chat-create-1', intentHash: sha('intent')
    }
  } as unknown as Conversation
}, 120_000)

afterAll(async () => {
  await rm(userData, { recursive: true, force: true })
})

async function missingRefs(): Promise<ConversationItemRef[]> {
  const items = await readSideChatManifestItems(conversationHistoryRoot(userData, origin), snapshot, 0, COUNT)
  return items.map(item => ({ ...item.ref }))
}

describe('frozen manifest handoff', () => {
  it('selects by metadata, omits in compact ranges, and keeps bodies off the wire', async () => {
    const missing = await missingRefs()
    const prepared = await prepareConversationHandoff(userData, conversation, missing, { userText: 'continue', attachments: [] }, true)
    expect(prepared.selectedItems.length).toBeGreaterThan(0)
    expect(prepared.selectedItems.length).toBeLessThan(missing.length)
    // The oversized message is omitted without ever being a selection candidate.
    const huge = missing.find(ref => ref.runId === sideChatSnapshotRunId(snapshotId, HUGE_INDEX))
    expect(prepared.omitted?.some(ref => conversationItemKey(ref) === conversationItemKey(huge!))).toBe(true)
    const split = splitOmittedItems(conversation, prepared.omitted ?? [])
    expect(split.items).toEqual([])
    // Omitting almost every one of 400 messages stays one contiguous range.
    expect(split.ranges.length).toBeLessThanOrEqual(2)
    expect(prepared.reader?.count).toBe(prepared.omitted?.length)
  }, 60_000)

  it('pages the earliest, a middle and the latest omission from the sealed child alone', async () => {
    const missing = await missingRefs()
    const prepared = await prepareConversationHandoff(userData, conversation, missing, { userText: 'continue', attachments: [] }, true)
    const omitted = prepared.omitted ?? []
    const indexes = [0, Math.floor(omitted.length / 2), omitted.length - 1].map(position => {
      const runId = omitted[position].runId
      return Number(runId.slice(runId.lastIndexOf(':') + 1))
    })
    for (const index of indexes) {
      const pages = await prepared.reader!.page(omitted.findIndex(ref => ref.runId === sideChatSnapshotRunId(snapshotId, index)), 1)
      expect(pages).toHaveLength(1)
      let text = ''
      for (let offset = 0; ;) {
        const page = await prepared.reader!.read(pages[0].id, offset)
        text += page.text
        if (page.nextOffset === null) break
        offset = page.nextOffset
      }
      expect(text).toBe(textAt(index))
      expect(sha(text)).toBe(pages[0].contentHash)
    }
  }, 60_000)

  it('reads bodies only for the selection, not for every omitted message', async () => {
    const missing = await missingRefs()
    const read = vi.spyOn(contentStore, 'readRecorderContentPage')
    const prepared = await prepareConversationHandoff(userData, conversation, missing, { userText: 'continue', attachments: [] }, true)
    const calls = read.mock.calls.length
    read.mockRestore()
    // The 400-message index alone costs ~13 leaf reads; every body read would add 400.
    expect(calls).toBeLessThan(80)
    expect(prepared.selectedItems.length + 60).toBeGreaterThan(calls)
  }, 60_000)

  it('reopens the sealed ledger and rejects a range that did not seal it', async () => {
    const missing = await missingRefs()
    const prepared = await prepareConversationHandoff(userData, conversation, missing, { userText: 'continue', attachments: [] }, true)
    const split = splitOmittedItems(conversation, prepared.omitted ?? [])
    const turn = {
      origin: 'dispatch', ordinal: 1, runId: 'run-1', bindingId: 'binding-1', items: [],
      commandId: 'side-chat-send-1', intentHash: sha('intent-1'), resumeSessionId: null,
      importedItems: prepared.selectedItems, omittedItems: split.items, omittedRanges: split.ranges,
      historyPolicy: 'retrievable-v1', history: prepared.history, delivery: { status: 'pending' }
    } as DispatchedConversationTurn
    expect((await loadConversationHistory(userData, conversation, turn))?.requiresReader).toBe(true)
    const wider = { ...split.ranges[0], to: Math.min(COUNT - 1, split.ranges[0].to + 1) }
    await expect(loadConversationHistory(userData, conversation,
      { ...turn, omittedRanges: [wider] })).rejects.toThrow('遗漏项引用不匹配')
  }, 60_000)

  it('round-trips the compact ledger through the record schema', async () => {
    const missing = await missingRefs()
    const prepared = await prepareConversationHandoff(userData, conversation, missing, { userText: 'continue', attachments: [] }, true)
    const split = splitOmittedItems(conversation, prepared.omitted ?? [])
    const turn = {
      origin: 'dispatch', ordinal: 1, runId: 'run-1', bindingId: 'binding-1', items: [],
      commandId: 'side-chat-send-1', intentHash: sha('intent-1'), resumeSessionId: null,
      importedItems: prepared.selectedItems, omittedItems: split.items, omittedRanges: split.ranges,
      historyPolicy: 'retrievable-v1', history: prepared.history, delivery: { status: 'pending' }
    }
    const record = { ...conversation, revision: 2, turns: [turn], bindings: [{
      id: '55555555-5555-4555-8555-555555555555', providerId: 'claude',
      agentProfileId: 'default', continuationKey: 'key'
    }] }
    turn.bindingId = '55555555-5555-4555-8555-555555555555'
    expect(decodeConversation(record).turns[0].origin).toBe('dispatch')
    const foreign = { ...turn, omittedRanges: [{ snapshotId, from: 0, to: COUNT }] }
    expect(() => decodeConversation({ ...record, turns: [foreign] })).toThrow('遗漏区间无效')
    const reversed = { ...turn, omittedRanges: [{ snapshotId, from: 5, to: 4 }] }
    expect(() => decodeConversation({ ...record, turns: [reversed] })).toThrow('遗漏区间无效')
  }, 60_000)
})
