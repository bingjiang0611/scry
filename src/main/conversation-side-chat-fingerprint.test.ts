import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../shared/trace'
import type { ConversationSideChatRequest } from '../shared/conversation-api'
import { traceArchiveTurnPath, upsertTraceArchiveTurn } from './transcript-archive'
import { fingerprints, type CaptureItem } from './conversation-side-chat-source'
import { readSideChatManifestItems } from './conversation-side-chat-manifest'
import { conversationHistoryRoot } from './conversation-history-content'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'

/**
 * A preview binds the whole sealed manifest, not just the message tuple.
 *
 * A source that rewrote only its terminal status is a different snapshot: creation must
 * refuse the stale preview before it publishes a child, and the unchanged source must
 * still create one.
 */

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

const captureItem = (overrides: Partial<CaptureItem> = {}): CaptureItem => ({
  role: 'user', sourceRunId: 'run-1', sourceOrdinal: 1, providerId: 'claude',
  contentHash: 'a'.repeat(64), status: 'completed', delivery: 'snapshot', bytes: 5, inlineBytes: 9, ...overrides
})

const source = { kind: 'conversation' as const, conversationId: '11111111-2222-4333-8444-555555555555' }
const through = { ordinal: 1, runId: 'run-1' }

const createRequest = (conversationId: string,
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId: string): ConversationSideChatRequest => ({
  source: { kind: 'conversation', conversationId }, expectedThroughOrdinal: preview.throughOrdinal,
  expectedThroughRunId: preview.throughRunId, expectedPrefixFingerprint: preview.prefixFingerprint,
  expectedManifestFingerprint: preview.manifestFingerprint, commandId
})

/** One real parent turn through the real managed send path. */
async function parentWithOneTurn(): Promise<{ current: SideChatFixture; conversationId: string; runId: string }> {
  const current = await sideChatFixture({ providerId: 'claude' })
  fixtures.push(current)
  const created = await current.service.create(current.cwd)
  await sendTurn(current, created.id, 'command-parent-1', 'question 1')
  const runId = current.runs[0]?.managed.runId
  if (!runId) throw new Error('the fixture parent turn must be recorded')
  return { current, conversationId: created.id, runId }
}

describe('side-chat source fingerprints', () => {
  it('covers every sealed metadata field, and has the same result for identical facts', () => {
    const base = fingerprints(source, through, [captureItem()])
    expect(fingerprints(source, through, [captureItem()])).toEqual(base)
    // Each of these fields is stored on the sealed entry, so rewriting any one of them
    // makes this a different snapshot.
    for (const rewrite of [{ status: 'failed' }, { delivery: 'accepted' }, { nativeSessionId: 'native-a' },
      { providerTurnId: 'provider-turn-a' }, { contentHash: 'b'.repeat(64) }]) {
      const rewritten = fingerprints(source, through, [captureItem(rewrite)])
      expect(rewritten.prefixFingerprint).not.toBe(base.prefixFingerprint)
      expect(rewritten.manifestFingerprint).not.toBe(base.manifestFingerprint)
    }
  })

  it('refuses a preview whose source only rewrote its terminal status, and creates the unchanged source', async () => {
    const { current, conversationId, runId } = await parentWithOneTurn()
    const conversationSource = { kind: 'conversation' as const, conversationId }
    const before = await current.service.previewSideChat(conversationSource)
    expect(before.throughOrdinal).toBe(1)

    // Rewrite only the archive turn's status: same order, same text, same identities.
    const sessionId = `native-${runId}`
    const path = traceArchiveTurnPath(current.userData, current.cwd, sessionId, 'claude', { runId })
    const stored = JSON.parse(await readFile(path, 'utf8')) as {
      turns: Array<{ ts: number; userText: string; items: TraceEvent[] }>
    }
    const turn = stored.turns[0]
    if (!turn) throw new Error('the fixture archive must hold the parent turn')
    expect(upsertTraceArchiveTurn({
      userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'claude',
      turn: { runId, userText: turn.userText, items: turn.items, done: true, status: 'failed', ts: turn.ts }
    })).toBe(true)

    const after = await current.service.previewSideChat(conversationSource)
    expect(after.throughOrdinal).toBe(before.throughOrdinal)
    expect(after.throughRunId).toBe(before.throughRunId)
    expect(after.prefixFingerprint).not.toBe(before.prefixFingerprint)
    expect(after.manifestFingerprint).not.toBe(before.manifestFingerprint)

    // The stale preview is refused before any child record exists.
    await expect(current.service.createSideChat(createRequest(conversationId, before, 'command-stale-status')))
      .rejects.toThrow('来源快照范围已变化')
    expect(await current.store.findSideChat('command-stale-status')).toBeUndefined()

    // The unchanged source still creates, and its sealed entry keeps the new verdict.
    const child = await current.service.createSideChat(createRequest(conversationId, after, 'command-current-status'))
    const persisted = (await current.store.read(child.id))!
    const snapshot = persisted.sideChat!.snapshot
    if (snapshot.format !== 4) throw new Error('the fixture expects a format 4 snapshot')
    const items = await readSideChatManifestItems(conversationHistoryRoot(current.userData, persisted), snapshot,
      0, snapshot.messageCount)
    expect(items.map(item => item.status)).toEqual(['failed', 'failed'])
    expect(await current.service.readItem(child.id, items[0]!.ref)).toBe('question 1')
  })
})
