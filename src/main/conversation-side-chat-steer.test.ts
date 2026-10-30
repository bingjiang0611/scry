import { afterEach, describe, expect, it } from 'vitest'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { hash, modelEvent, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { loadSideChatSnapshotMessages, sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import type { TraceEvent } from '../shared/trace'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

interface SeedTurn {
  runId: string
  userText: string
  refs: Array<'user' | 'assistant' | string>
  items: TraceEvent[]
  /** Assistant texts the parent recorded, joined exactly as the handoff formatter does. */
  recordedAssistant: string
}

const steer = (runId: string, messageId: string, prompt: string, status: string): TraceEvent => ({
  id: `steer-${messageId}`, runId, ts: '2026-10-01T00:00:00.000Z', kind: 'human', stage: 'steer',
  steer: { messageId, prompt, attachments: [], status: status as 'accepted', ...(status === 'accepted' ? {} : { message: 'rejected' }) }
})

/** Parent records a dispatch turn whose archive carries steering evidence. */
async function parentWithSteerTurn(turns: SeedTurn[]): Promise<{ fixture: SideChatFixture; parentId: string }> {
  const current = await sideChatFixture()
  fixtures.push(current)
  const parent = await current.store.create(current.cwd, {
    target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
    nativeSessionId: 'native-parent',
    title: 'steered parent',
    turns: turns.map(turn => ({
      runId: turn.runId,
      archive: { sessionId: `archive-${turn.runId}` },
      items: turn.refs.map(itemId => ({ runId: turn.runId, itemId,
        contentHash: itemId === 'user' ? hash(turn.userText) : hash(turn.recordedAssistant) })),
      nativeItems: []
    }))
  })
  for (const turn of turns) {
    upsertTraceArchiveTurn({
      userDataDir: current.userData, cwd: current.cwd, sessionId: `archive-${turn.runId}`, providerId: 'codex',
      turn: { runId: turn.runId, userText: turn.userText, items: turn.items, done: true, status: 'completed', ts: Date.now() }
    })
  }
  return { fixture: current, parentId: parent.id }
}

describe('side-chat projection of accepted steering', () => {
  it('projects accepted steer prompts between completed assistant segments in trace order', async () => {
    const { fixture: current, parentId } = await parentWithSteerTurn([
      { runId: 'run-1', userText: 'first question', refs: ['user', 'assistant'],
        items: [modelEvent('run-1', 'answer: first')], recordedAssistant: 'answer: first' },
      { runId: 'run-2', userText: 'second question', refs: ['user', 'assistant'],
        items: [modelEvent('run-2', 'part one'), steer('run-2', 'steer-message', 'changed requirement', 'accepted'),
          modelEvent('run-2', 'part two')],
        recordedAssistant: 'part one\n\npart two' }
    ])
    const source = { kind: 'conversation' as const, conversationId: parentId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.messageCount).toBe(6)
    const child = await current.service.createSideChat({
      source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-steer'
    })
    const frozen = await loadSideChatSnapshotMessages(current.userData, (await current.store.read(child.id))!)
    const items = frozen.map(message => ({ ref: message.ref, role: message.role, sourceOrdinal: message.ordinal }))
    expect(items.map(item => [item.role, item.sourceOrdinal])).toEqual([
      ['user', 1], ['assistant', 1], ['user', 2], ['assistant', 2], ['user', 2], ['assistant', 2]
    ])
    const texts: Array<[string, string]> = []
    for (const item of items) texts.push([item.role, await current.service.readItem(child.id, item.ref)])
    expect(texts).toEqual([
      ['user', 'first question'], ['assistant', 'answer: first'],
      ['user', 'second question'], ['assistant', 'part one'],
      ['user', 'changed requirement'], ['assistant', 'part two']
    ])
    // The steered snapshot is deliverable: first send resolves each frozen message.
    const target = { providerId: 'codex' as const }
    const handoff = await current.service.preview(child.id, target)
    if (handoff.continuation.kind === 'blocked') throw new Error(handoff.continuation.reason)
    const stored = (await current.store.read(child.id))!
    await current.service.send({ conversationId: child.id, ...target, expectedRevision: stored.revision,
      expectedContinuationKey: handoff.target.continuationKey, commandId: 'side-chat-steer-send',
      prompt: 'child question', selectedItems: handoff.continuation.missingItems, confirmFresh: true,
      permissionMode: 'default' })
    const context = JSON.parse(current.runs.at(-1)!.context!) as { messages: Array<{ role: string; text: string }> }
    expect(context.messages.map(message => [message.role, message.text])).toEqual(texts)
  })

  it('excludes unaccepted steering evidence from the frozen prefix', async () => {
    const { fixture: current, parentId } = await parentWithSteerTurn([
      { runId: 'run-1', userText: 'question', refs: ['user', 'assistant'],
        items: [modelEvent('run-1', 'part one'), steer('run-1', 'pending-steer', 'not yet accepted', 'pending'),
          modelEvent('run-1', 'part two')],
        recordedAssistant: 'part one\n\npart two' }
    ])
    const preview = await current.service.previewSideChat({ kind: 'conversation', conversationId: parentId })
    // The unaccepted prompt adds no message and does not split the assistant body.
    expect(preview.messageCount).toBe(2)
    const child = await current.service.createSideChat({
      source: { kind: 'conversation', conversationId: parentId },
      expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-pending-steer'
    })
    const steered = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect(await current.service.readItem(child.id, steered[1])).toBe('part one\n\npart two')
  })

  it('fails closed when an accepted steer has no completed answer inside the turn', async () => {
    const { fixture: current, parentId } = await parentWithSteerTurn([
      { runId: 'run-1', userText: 'question', refs: ['user', 'assistant'],
        items: [modelEvent('run-1', 'part one'), steer('run-1', 'trailing-steer', 'unanswered', 'accepted')],
        recordedAssistant: 'part one' }
    ])
    await expect(current.service.previewSideChat({ kind: 'conversation', conversationId: parentId }))
      .rejects.toThrow('没有可见助手回复')
    expect((await current.store.list(current.cwd)).length).toBe(1)
  })
})
