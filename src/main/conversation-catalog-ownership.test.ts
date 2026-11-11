import { afterEach, describe, expect, it } from 'vitest'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'

const fixtures: SideChatFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())) })

/**
 * Which Provider catalog rows the sidebar must hide because a conversation owns them.
 *
 * A conversation's run is catalogued under its run id as soon as it starts, but its binding
 * only learns the native session id from the receipt. A side chat whose first turn was
 * still running therefore showed up in the sidebar as an ordinary Provider session.
 */
describe('catalog ownership of conversation runs', () => {
  it('owns a running first turn by its run id before the native session id is known', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'catalog-parent-1', 'parent question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat({ source, expectedThroughOrdinal: preview.throughOrdinal,
      expectedThroughRunId: preview.throughRunId, expectedPrefixFingerprint: preview.prefixFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint, commandId: 'catalog-child' })
    current.pending = true
    await sendTurn(current, child.id, 'catalog-child-1', 'child question')
    const running = (await current.store.read(child.id))!
    const turn = running.turns.at(-1)!
    expect(running.bindings.find(binding => binding.id === turn.bindingId)?.nativeSessionId).toBeUndefined()

    const catalog = await current.service.listCatalog(current.cwd)
    expect(catalog.ownedRunIds.has(`codex\0${current.cwd}\0${turn.runId}`)).toBe(true)
    // The parent's settled run is owned too, and by its native alias as well.
    const parentTurn = (await current.store.read(parent.id))!.turns[0]
    expect(catalog.ownedRunIds.has(`codex\0${current.cwd}\0${parentTurn.runId}`)).toBe(true)
    expect(catalog.ownedNativeAliases.size).toBeGreaterThan(0)
    // Another Provider or workspace with the same run id is not owned.
    expect(catalog.ownedRunIds.has(`claude\0${current.cwd}\0${turn.runId}`)).toBe(false)
    expect(catalog.ownedRunIds.has(`codex\0${current.root}\0${turn.runId}`)).toBe(false)
  })
})
