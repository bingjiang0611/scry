import { afterEach, describe, expect, it } from 'vitest'
import { ConversationService } from './conversation-service'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest, SideChatPreview } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

function request(source: ConversationSideChatRequest['source'], preview: SideChatPreview): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
    commandId: 'side-chat-fork-source' }
}

describe('native fork source ownership', () => {
  it('refuses a side chat as a native fork source before any Provider call', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'parent-1', 'parent question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const child = await current.service.createSideChat(request(source, await current.service.previewSideChat(source)))
    // The child runs its own turn, so the requested source run really exists.
    await sendTurn(current, child.id, 'child-cmd-1', 'child question')
    const childTurn = (await current.store.read(child.id))!.turns[0]

    let providerCalls = 0
    current.service = new ConversationService({
      store: current.store,
      resolveContinuationKey: async ({ providerId }) => `identity:${providerId}:default`,
      supportsHistoricalInput: () => true,
      startAppRun: async () => { throw new Error('no Provider may start here') },
      forkNative: async () => { providerCalls += 1; return 'native-fork' }
    })
    const childRevision = (await current.store.read(child.id))!.revision
    await expect(current.service.fork({ conversationId: child.id, sourceRunId: childTurn.runId,
      expectedRevision: childRevision, commandId: 'fork-side-chat', permissionMode: 'default' }))
      .rejects.toThrow('侧聊不能作为原生分支的来源')
    expect(providerCalls).toBe(0)
    // Nothing was published: no fork record and no extra conversation.
    const after = (await current.store.read(child.id))!
    expect(after.fork).toBeUndefined()
    expect((await current.store.list(current.cwd)).map(item => item.id).sort()).toEqual([parent.id, child.id].sort())
  })
})
