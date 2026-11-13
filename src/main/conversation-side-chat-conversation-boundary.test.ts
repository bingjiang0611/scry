import { afterEach, describe, expect, it } from 'vitest'
import { planConversationContinuation, type ConversationArchiveRef, type ConversationItemRef,
  type ConversationTarget } from '../shared/conversation'
import type { ConversationSideChatRequest } from '../shared/conversation-api'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { hash, modelEvent, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { readSideChatManifestItems } from './conversation-side-chat-manifest'
import { conversationHistoryRoot } from './conversation-history-content'

/**
 * A conversation source freezes a terminal prefix, not a successful one.
 *
 * These turns are real store records plus real archives; only the Provider terminal is
 * written by the test. A failed latest turn must be the default boundary and must keep its
 * own status, while a still-pending turn stays out.
 */

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

const TARGET: ConversationTarget = { providerId: 'claude', continuationKey: 'identity:claude:default' }
const SESSION = 'native-boundary-session'

/** One archived turn plus the item refs the conversation record stores for it. */
function archivedTurn(current: SideChatFixture, runId: string, prompt: string, answer: string,
  status: 'completed' | 'failed' | 'interrupted'): ConversationItemRef[] {
  const items = [modelEvent(runId, answer)]
  const written = upsertTraceArchiveTurn({
    userDataDir: current.userData, cwd: current.cwd, sessionId: SESSION, providerId: 'claude',
    turn: { runId, userText: prompt, items, done: true, status, ts: Date.now() }
  })
  if (!written) throw new Error('the fixture archive turn must be written')
  return [
    { runId, itemId: 'user', contentHash: hash(prompt) },
    { runId, itemId: 'assistant', contentHash: hash(answer) }
  ]
}

async function parentWithTurns(kinds: Array<'completed' | 'failed' | 'interrupted' | 'pending'>): Promise<{
  current: SideChatFixture
  conversationId: string
}> {
  const current = await sideChatFixture({ providerId: 'claude' })
  fixtures.push(current)
  let conversation = await current.store.create(current.cwd)
  for (const [index, kind] of kinds.entries()) {
    const runId = `run-${index + 1}`
    const plan = planConversationContinuation(conversation, TARGET)
    if (plan.kind === 'blocked') throw new Error(plan.reason)
    const begun = await current.store.begin(conversation.id, {
      expectedRevision: conversation.revision, commandId: `command-${runId}`, runId,
      target: structuredClone(TARGET), payloadHash: hash(`payload ${runId}`),
      items: [{ runId, itemId: 'user', contentHash: hash(`question ${index + 1}`) }],
      selectedItems: plan.missingItems
    })
    conversation = begun.conversation
    if (kind === 'pending') continue
    const items = archivedTurn(current, runId, `question ${index + 1}`, `answer ${index + 1}`, kind)
    const archive: ConversationArchiveRef = { sessionId: SESSION }
    conversation = await current.store.settle(conversation.id, runId, {
      status: 'accepted', nativeSessionId: SESSION, outcome: kind, nativeItems: items
    }, items, archive)
  }
  return { current, conversationId: conversation.id }
}

async function sealedStatuses(current: SideChatFixture, id: string): Promise<{ statuses: string[]; texts: string[] }> {
  const stored = (await current.store.read(id))!
  const snapshot = stored.sideChat!.snapshot
  if (snapshot.format !== 4) throw new Error('the fixture expects a format 4 snapshot')
  const items = await readSideChatManifestItems(conversationHistoryRoot(current.userData, stored), snapshot, 0, snapshot.messageCount)
  return { statuses: items.map(item => item.status), texts: await Promise.all(items.map(async item => current.service.readItem(id, item.ref))) }
}

const createRequest = (conversationId: string,
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId: string): ConversationSideChatRequest => ({
  source: { kind: 'conversation', conversationId }, expectedThroughOrdinal: preview.throughOrdinal,
  expectedThroughRunId: preview.throughRunId, expectedPrefixFingerprint: preview.prefixFingerprint,
  expectedManifestFingerprint: preview.manifestFingerprint, commandId
})

describe('conversation source terminal boundary', () => {
  it('freezes a latest failed turn as the default boundary and keeps its status', async () => {
    const { current, conversationId } = await parentWithTurns(['completed', 'failed'])
    const source = { kind: 'conversation' as const, conversationId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(2)
    expect(preview.throughRunId).toBe('run-2')
    const child = await current.service.createSideChat(createRequest(conversationId, preview, 'boundary-failed'))
    const sealed = await sealedStatuses(current, child.id)
    expect(sealed.texts).toEqual(['question 1', 'answer 1', 'question 2', 'answer 2'])
    expect(sealed.statuses).toEqual(['completed', 'completed', 'failed', 'failed'])
  })

  it('leaves out a still-pending trailing turn and refuses a boundary that names it', async () => {
    const { current, conversationId } = await parentWithTurns(['completed', 'pending'])
    const source = { kind: 'conversation' as const, conversationId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(1)
    expect(preview.throughRunId).toBe('run-1')
    const child = await current.service.createSideChat(createRequest(conversationId, preview, 'boundary-pending-tail'))
    const sealed = await sealedStatuses(current, child.id)
    expect(sealed.texts).toEqual(['question 1', 'answer 1'])
    expect(sealed.statuses).toEqual(['completed', 'completed'])
    // Selecting the pending turn as the boundary is still refused: it has no terminal.
    await expect(current.service.previewSideChat(source, { terminalThroughOrdinal: 2 })).rejects.toThrow()
  })
})
