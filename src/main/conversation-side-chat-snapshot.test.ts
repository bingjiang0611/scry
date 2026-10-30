import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sideChatSnapshotRunId, type SideChatSnapshotItem } from '../shared/conversation'
import { conversationHistoryRoot, type HistoryMessage } from './conversation-history-content'
import { SideChatSnapshotWriter } from './conversation-side-chat-manifest'
import { sealSink } from './conversation-side-chat-capture'
import {
  loadSideChatSnapshotMessages, readSideChatSnapshotItem, sideChatSnapshotRefs
} from './conversation-side-chat-snapshot'
import type { SideChatSnapshotManifest } from '../shared/conversation'

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const conversation = { id: '11111111-1111-4111-8111-111111111111', cwd: '/tmp/snapshot-workspace' }
const snapshotId = '22222222-2222-4222-8222-222222222222'
const HUGE = `${'正文'.repeat(1_200_000)}结尾`
const COUNT = 4200

let userData: string
let sealed: SideChatSnapshotManifest

function frozenItems(): { items: SideChatSnapshotItem[]; messages: HistoryMessage[] } {
  const items: SideChatSnapshotItem[] = []
  const messages: HistoryMessage[] = []
  for (let index = 0; index < COUNT; index += 1) {
    const text = index === 0 ? HUGE : `message ${index}`
    const role = index % 2 === 0 ? 'assistant' : 'user'
    const ref = { runId: sideChatSnapshotRunId(snapshotId, index), itemId: role, contentHash: sha(text) }
    items.push({ ref, sourceOrdinal: Math.floor(index / 2) + 1, providerId: 'claude', role })
    messages.push({
      ref, providerId: 'claude', ordinal: Math.floor(index / 2) + 1, role,
      status: 'completed', delivery: 'accepted', text
    })
  }
  return { items, messages }
}

beforeAll(async () => {
  userData = await mkdtemp(join(tmpdir(), 'scry-snapshot-'))
  const { messages } = frozenItems()
  // Sealed through the same streaming writer creation uses, one message at a time.
  const writer = new SideChatSnapshotWriter({
    dataRoot: conversationHistoryRoot(userData, conversation),
    identity: {
      id: snapshotId, prefixFingerprint: sha('prefix'), throughOrdinal: COUNT / 2, throughRunId: 'run-last',
      capturedAt: 1
    }
  })
  const sink = sealSink(writer, snapshotId)
  for (const message of messages) {
    await sink.append({
      role: message.role, contentHash: message.ref.contentHash, bytes: Buffer.byteLength(message.text, 'utf8'),
      text: (async function* () { yield message.text })()
    }, {
      role: message.role, sourceRunId: message.ref.runId, sourceOrdinal: message.ordinal,
      providerId: 'claude', status: message.status, delivery: 'snapshot'
    })
  }
  sealed = await writer.seal()
  // 4200 items and a message far beyond the old 4 MiB artifact budget need durable
  // content writes (one leaf per 32 items), which is the measured cost here.
}, 120_000)

afterAll(async () => {
  await rm(userData, { recursive: true, force: true })
})

describe('format 4 side-chat snapshot seal', () => {
  it('seals more than 4000 items and a message beyond the old 4 MiB budget', () => {
    expect(sealed.messageCount).toBe(COUNT)
    expect(sealed.bodyBytes).toBeGreaterThan(4 * 1024 * 1024)
    expect(sealed.items.count).toBe(COUNT)
  })

  it('reads the first, a middle and the last frozen item by position', async () => {
    const record = { ...conversation, sideChat: { snapshot: sealed } as never }
    expect((await readSideChatSnapshotItem(userData, record, 0)).ref.runId).toBe(sideChatSnapshotRunId(snapshotId, 0))
    expect((await readSideChatSnapshotItem(userData, record, COUNT - 1)).ref.runId)
      .toBe(sideChatSnapshotRunId(snapshotId, COUNT - 1))
    expect(await sideChatSnapshotRefs(userData, record)).toHaveLength(COUNT)
  })

  it('returns the exact huge body and the untouched neighbours', async () => {
    const record = { ...conversation, sideChat: { snapshot: sealed } as never }
    const messages = await loadSideChatSnapshotMessages(userData, record)
    expect(messages).toHaveLength(COUNT)
    expect(messages[0].text).toBe(HUGE)
    expect(sha(messages[0].text)).toBe(messages[0].ref.contentHash)
    expect(messages[1].text).toBe('message 1')
    expect(messages[COUNT - 1].text).toBe(`message ${COUNT - 1}`)
  })
})
