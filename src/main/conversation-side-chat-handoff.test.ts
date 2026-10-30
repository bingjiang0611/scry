import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { hash, modelEvent, sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'
import type { ConversationSummary } from '../shared/conversation-api'
import type { Conversation as ConversationRecord, DispatchedConversationTurn } from '../shared/conversation'
import type { ProviderId } from '../shared/provider'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(options: { providerId?: ProviderId } = {}): Promise<SideChatFixture> {
  const created = await sideChatFixture(options)
  fixtures.push(created)
  return created
}

function dispatched(conversation: ConversationRecord, index: number): DispatchedConversationTurn {
  const turn = conversation.turns.at(index)
  if (turn?.origin !== 'dispatch') throw new Error('expected a dispatched turn')
  return turn
}

function request(source: ConversationSideChatRequest['source'], preview: SideChatPreview, commandId = 'side-chat-1'): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

/** Parent with two completed turns, then a child whose snapshot is frozen at turn 2. */
async function frozenChild(): Promise<{ fixture: SideChatFixture; parentId: string; child: ConversationSummary }> {
  const current = await fixture()
  const parent = await current.service.create(current.cwd)
  await sendTurn(current, parent.id, 'parent-1', 'first question')
  await sendTurn(current, parent.id, 'parent-2', 'second question')
  const source = { kind: 'conversation' as const, conversationId: parent.id }
  const preview = await current.service.previewSideChat(source)
  const child = await current.service.createSideChat(request(source, preview))
  return { fixture: current, parentId: parent.id, child }
}

describe('side-chat first send and frozen context', () => {
  it('delivers the sealed snapshot bytes on first send and only real execution in the child turn', async () => {
    const { fixture: current, child } = await frozenChild()
    await sendTurn(current, child.id, 'child-cmd-1', 'child question')
    const run = current.runs.at(-1)!
    expect(run.context).toBeDefined()
    const artifact = JSON.parse(run.context!) as { messages: Array<{ role: string; text: string; delivery: string; ordinal: number }> }
    expect(artifact.messages.map(message => [message.role, message.text])).toEqual([
      ['user', 'first question'], ['assistant', 'answer: first question'],
      ['user', 'second question'], ['assistant', 'answer: second question']
    ])
    expect(artifact.messages.map(message => message.ordinal)).toEqual([1, 1, 2, 2])
    expect(artifact.messages.every(message => message.delivery === 'snapshot')).toBe(true)
    const stored = (await current.store.read(child.id))!
    expect(stored.turns).toHaveLength(1)
    expect(dispatched(stored, 0).importedItems).toHaveLength(4)
    // The child's own items and native session are its execution, never the parent's.
    expect(stored.turns[0].items.map(item => [item.itemId, item.runId]))
      .toEqual([['user', stored.turns[0].runId], ['assistant', stored.turns[0].runId]])
    expect(stored.bindings[0].nativeSessionId).toBe(`native-${stored.turns[0].runId}`)
    const handoff = await current.store.history(child.id, stored.turns[0].runId)
    expect(handoff?.text).toBe(run.context)
    // A reopened store still validates the sealed body against the snapshot metadata.
    const reopened = new (current.store.constructor as typeof import('./conversation-store').ConversationStore)(current.userData)
    expect((await reopened.history(child.id, stored.turns[0].runId))?.text).toBe(run.context)
  })

  it('does not repeat the snapshot on resume or on a duplicate command', async () => {
    const { fixture: current, child } = await frozenChild()
    await sendTurn(current, child.id, 'child-cmd-1', 'child question')
    await sendTurn(current, child.id, 'child-cmd-2', 'second child question')
    expect(current.runs.at(-1)!.context).toBeUndefined()
    const stored = (await current.store.read(child.id))!
    expect(stored.turns).toHaveLength(2)
    expect(dispatched(stored, 1).importedItems).toEqual([])
    expect(dispatched(stored, 1).resumeSessionId).toBe(stored.bindings[0].nativeSessionId)
    const duplicate = await current.service.send({
      conversationId: child.id, providerId: 'codex', expectedRevision: 0, expectedContinuationKey: 'identity:codex:default',
      commandId: 'child-cmd-2', prompt: 'second child question', selectedItems: [], confirmFresh: false, permissionMode: 'default'
    })
    expect(duplicate.disposition).toBe('duplicate')
    expect(current.runs.filter(run => run.prompt === 'second child question')).toHaveLength(1)
  })

  it('re-hands the same frozen snapshot once after a Provider switch', async () => {
    const { fixture: current, child } = await frozenChild()
    await sendTurn(current, child.id, 'child-cmd-1', 'child question')
    const profile = 'pi:0123456789abcdef'
    await sendTurn(current, child.id, 'child-pi-01', 'switch question', 'pi', profile)
    const switched = current.runs.at(-1)!
    expect(switched.context).toBeDefined()
    const messages = (JSON.parse(switched.context!) as { messages: Array<{ text: string; role: string }> }).messages
    expect(messages.filter(message => message.text === 'answer: first question')).toHaveLength(1)
    expect(messages.filter(message => message.text === 'first question')).toHaveLength(1)
    const stored = (await current.store.read(child.id))!
    expect(stored.bindings.map(binding => binding.providerId)).toEqual(['codex', 'pi'])
    expect(dispatched(stored, -1).resumeSessionId).toBeNull()
    // The switch re-hands both frozen and own context; the previous binding stays intact.
    expect(dispatched(stored, -1).importedItems).toHaveLength(6)
  })

  it('reads frozen refs only inside the child and rejects forged or parent refs', async () => {
    const { fixture: current, parentId, child } = await frozenChild()
    const page = await current.service.read(child.id)
    expect(page.sideChat?.messageCount).toBe(4)
    expect(page.sideChat?.parentTitleAtCapture).toBeDefined()
    const items = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect(items).toHaveLength(4)
    expect(await current.service.readItem(child.id, items[0])).toBe('first question')
    expect(await current.service.readItem(child.id, items[3])).toBe('answer: second question')
    const parent = (await current.store.read(parentId))!
    await expect(current.service.readItem(child.id, parent.turns[0].items[0])).rejects.toThrow('不属于当前对话')
    // A frozen run id names this snapshot, so a forged hash is refused by the snapshot
    // body check rather than by ownership.
    await expect(current.service.readItem(child.id, { ...items[0], contentHash: hash('forged') })).rejects.toThrow('正文引用不匹配')
    expect(page.summary.sideChat?.source).toEqual({ kind: 'conversation', conversationId: parentId })
    expect(page.summary.turnCount).toBe(0)
  })

  it('keeps the frozen snapshot usable after the parent conversation is deleted', async () => {
    const { fixture: current, parentId, child } = await frozenChild()
    const parent = (await current.store.read(parentId))!
    await current.service.update(parentId, parent.revision, { kind: 'archive', archived: true })
    const archived = (await current.store.read(parentId))!
    const fingerprint = hash('parent-deletion')
    await current.store.beginDeletion(parentId, archived.revision, fingerprint)
    await current.store.finishDeletion(parentId, fingerprint, { ok: true, deleted: [], retained: [], failed: [] })
    expect((await current.store.read(parentId))?.deletion?.status).toBe('complete')

    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect(await current.service.readItem(child.id, refs[0])).toBe('first question')
    await sendTurn(current, child.id, 'child-after-delete', 'after parent deletion')
    const artifact = JSON.parse(current.runs.at(-1)!.context!) as { messages: Array<{ text: string }> }
    expect(artifact.messages.map(message => message.text)).toContain('answer: second question')
  })

  it.each(['claude', 'codex', 'qoder', 'opencode', 'pi'] as const)(
    'freezes a verified native %s session without creating a conversation or adopting it',
    async (providerId) => {
      const current = await fixture({ providerId })
      const sessionId = `native-session-${providerId}`
      upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId,
        turn: { runId: `run-${providerId}-1`, userText: 'native question', items: [modelEvent(`run-${providerId}-1`, 'native answer')],
          done: true, status: 'completed', ts: Date.now() } })
      // A trailing turn that is still generating stays out of the frozen prefix.
      upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId,
        turn: { runId: `run-${providerId}-2`, userText: 'still running', items: [], done: false, ts: Date.now() } })
      const source = { kind: 'native-session' as const, providerId, cwd: current.cwd, nativeSessionId: sessionId }
      const preview = await current.service.previewSideChat(source)
      expect(preview.throughOrdinal).toBe(1)
      expect(preview.messageCount).toBe(2)
      expect(preview.target).toEqual({ providerId, permissionMode: 'default' })
      const child = await current.service.createSideChat(request(source, preview))
      expect(child.sideChat?.source).toEqual(source)
      expect((await current.store.list(current.cwd)).map(item => item.id)).toEqual([child.id])
      const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
      expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
        .toEqual(['native question', 'native answer'])
      expect((await current.service.listSideChats({ source })).items.map(item => item.id)).toEqual([child.id])
    }
  )

  it('refuses to start a send when the sealed snapshot body is missing', async () => {
    const { fixture: current, child } = await frozenChild()
    const stored = (await current.store.read(child.id))!
    if (stored.sideChat?.snapshot.format !== 4) throw new Error('fixture must seal a format 4 snapshot')
    // Remove the item index root: the frozen item list is then unreadable, not empty.
    const content = stored.sideChat.snapshot.items.root
    const body = join(current.userData, 'conversation-history-v1', hash(JSON.stringify([child.id, stored.cwd])),
      'content', 'sha256', content.sha256.slice(0, 2), `${content.sha256}.bin`)
    await rm(body)
    const started = current.runs.length
    await expect(sendTurn(current, child.id, 'child-cmd-1', 'child question')).rejects.toThrow()
    // No Provider start and no published intent: an empty child is never a success.
    expect(current.runs).toHaveLength(started)
    expect((await current.store.read(child.id))!.turns).toHaveLength(0)
  })

  it('finds a native-session child after its parent is adopted into a conversation', async () => {
    const current = await fixture({ providerId: 'codex' })
    const sessionId = 'native-parent-adopted'
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'codex',
      turn: { runId: 'adopted-run-1', userText: 'native parent question',
        items: [modelEvent('adopted-run-1', 'native parent answer')], done: true, status: 'completed', ts: Date.now() } })
    const source = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const child = await current.service.createSideChat(request(source, await current.service.previewSideChat(source)))
    expect(child.sideChat?.source).toEqual(source)

    // The user then adopts that Provider session into a managed conversation: one real
    // conversation record whose binding names the exact same native tuple.
    const adopted = await current.store.create(current.cwd, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
      nativeSessionId: sessionId, title: 'adopted parent', turns: [] })
    const byConversation = await current.service.listSideChats({ source: { kind: 'conversation', conversationId: adopted.id } })
    expect(byConversation.items.map(item => item.id)).toEqual([child.id])
    // Restoring a tab validates the same identity through one bounded id lookup.
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: adopted.id },
      ids: [child.id] })).items.map(item => item.id)).toEqual([child.id])
    // The other direction stays true: the native tuple still finds its own child.
    expect((await current.service.listSideChats({ source })).items.map(item => item.id)).toEqual([child.id])

    // The alias covers one exact tuple only: another session, another workspace or
    // another Provider/profile never inherits these children.
    const otherSession = await current.store.create(current.cwd, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
      nativeSessionId: 'another-native-session', turns: [] })
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: otherSession.id } })).total).toBe(0)
    const otherWorkspace = await current.store.create(current.root, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' },
      nativeSessionId: sessionId, turns: [] })
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: otherWorkspace.id } })).total).toBe(0)
    const otherProfile = await current.store.create(current.cwd, {
      target: { providerId: 'codex', agentProfileId: 'other-profile', continuationKey: 'identity:codex:other-profile' },
      nativeSessionId: sessionId, turns: [] })
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: otherProfile.id } })).total).toBe(0)
  })

  it('does not claim native ownership from frozen snapshot provenance', async () => {
    const current = await fixture({ providerId: 'codex' })
    const sessionId = 'legacy-native-session'
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'codex',
      turn: { runId: 'legacy-run-1', userText: 'legacy question', items: [modelEvent('legacy-run-1', 'legacy answer')],
        done: true, status: 'completed', ts: Date.now() } })
    const source = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const child = await current.service.createSideChat(request(source, await current.service.previewSideChat(source)))
    await expect(current.store.assertLegacyWriteAllowed({ providerId: 'codex', cwd: current.cwd, nativeSessionId: sessionId }))
      .resolves.toBeUndefined()
    const stored = (await current.store.read(child.id))!
    expect(stored.bindings).toEqual([])
    await sendTurn(current, child.id, 'child-cmd-1', 'child question')
    const sent = (await current.store.read(child.id))!
    expect(sent.bindings[0].nativeSessionId).not.toBe(sessionId)
  })
})
