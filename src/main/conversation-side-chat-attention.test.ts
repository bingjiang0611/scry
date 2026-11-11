import { afterEach, describe, expect, it } from 'vitest'
import { modelEvent, sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { upsertTraceArchiveTurn } from './transcript-archive'
import { conversationAttentionKey, sessionAttentionKey } from '../shared/session-attention'
import { sideChatAttentionKey } from './conversation-side-chat-attention'
import type { SideChatSource } from '../shared/conversation'

const fixtures: SideChatFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())) })

async function childOf(current: SideChatFixture, source: SideChatSource, commandId: string) {
  const preview = await current.service.previewSideChat(source)
  const child = await current.service.createSideChat({ source, expectedThroughOrdinal: preview.throughOrdinal,
    expectedThroughRunId: preview.throughRunId, expectedPrefixFingerprint: preview.prefixFingerprint,
    expectedManifestFingerprint: preview.manifestFingerprint, commandId })
  return (await current.store.read(child.id))!
}

/**
 * A side chat has no sidebar row, so its attention must land on a row the user can open.
 * Keyed by the child's own id, a finished side chat left a Dock badge nothing could clear.
 */
describe('side-chat attention owner', () => {
  it('uses the managed parent, the native parent, or the conversation that adopted it', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const list = (cwd: string) => current.store.list(cwd)

    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'attention-parent-1', 'parent question')
    expect(await sideChatAttentionKey((await current.store.read(parent.id))!, list)).toBeUndefined()
    const managedChild = await childOf(current, { kind: 'conversation', conversationId: parent.id }, 'attention-child-managed')
    expect(await sideChatAttentionKey(managedChild, list)).toBe(conversationAttentionKey(parent.id))

    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId: 'native-parent', providerId: 'codex',
      turn: { runId: 'native-run', userText: 'native question', items: [modelEvent('native-run', 'native answer')],
        done: true, status: 'completed', ts: Date.now() } })
    const native = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: 'native-parent' }
    const nativeChild = await childOf(current, native, 'attention-child-native')
    expect(await sideChatAttentionKey(nativeChild, list))
      .toBe(sessionAttentionKey({ providerId: 'codex', cwd: current.cwd, sessionId: 'native-parent' }))

    // Once the Provider session is adopted, its own row is hidden behind the conversation.
    const adopted = await current.store.create(current.cwd, {
      target: { providerId: 'codex', continuationKey: 'identity:codex:default' }, nativeSessionId: 'native-parent', turns: [] })
    expect(await sideChatAttentionKey(nativeChild, list)).toBe(conversationAttentionKey(adopted.id))
    const catalog = await current.service.listCatalog(current.cwd)
    expect(catalog.conversations.find(item => item.id === nativeChild.id)?.sideChat?.parentConversationId).toBe(adopted.id)
    expect(catalog.conversations.find(item => item.id === managedChild.id)?.sideChat?.parentConversationId).toBeUndefined()

    // An unreadable workspace list falls back to the native source row, never to the child.
    const unreadable = async (): Promise<never> => { throw new Error('store unavailable') }
    expect(await sideChatAttentionKey(nativeChild, unreadable))
      .toBe(sessionAttentionKey({ providerId: 'codex', cwd: current.cwd, sessionId: 'native-parent' }))
    expect(await sideChatAttentionKey(nativeChild, unreadable)).not.toBe(conversationAttentionKey(nativeChild.id))
  })

  it('reports a create the host is still executing as in-flight, not as not-found', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'inflight-parent-1', 'parent question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    const request = { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'inflight-command' }
    const creating = current.service.createSideChat(request)
    // Asked while the create is still running, e.g. by a renderer that reloaded mid-create.
    expect(await current.service.findSideChatCommand(source, 'inflight-command')).toEqual({ commandId: 'inflight-command', status: 'in-flight' })
    await creating
    expect((await current.service.findSideChatCommand(source, 'inflight-command')).status).toBe('found')
    expect(await current.service.findSideChatCommand(source, 'never-sent-command')).toEqual({ commandId: 'never-sent-command', status: 'not-found' })
  })

  it('keeps a command in flight until every concurrent submission of it has settled', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const source = { kind: 'conversation' as const, conversationId: '11111111-2222-4333-8444-555555555555' }
    let releaseSecond!: () => void
    const second = current.service.trackSideChatCreate('shared-command', () => new Promise<void>(resolve => { releaseSecond = resolve }))
    // The first submission fails before publishing anything; the second is still running.
    await expect(current.service.trackSideChatCreate('shared-command', async () => { throw new Error('refused') })).rejects.toThrow('refused')
    expect((await current.service.findSideChatCommand(source, 'shared-command')).status).toBe('in-flight')
    releaseSecond()
    await second
    expect((await current.service.findSideChatCommand(source, 'shared-command')).status).toBe('not-found')
  })
})
