import { sideChatFixture, sendTurn } from '../../src/main/conversation-side-chat.fixture'
import type { SideChatSnapshotBodyPage } from '../../src/shared/conversation-api'

/**
 * Real viewer pages for the component fixture, produced by the shipped reader.
 *
 * The pages come from the same main-process fixture the body API tests use: a real
 * conversation store, real sealed snapshot artifact and the production page reader, with a
 * history reader available so a prefix longer than the handoff budget can still be frozen.
 * Nothing here is a hand-written page body, so the component sees what production produces.
 */
export async function snapshotPages(turns: number): Promise<{ pages: SideChatSnapshotBodyPage[]; childId: string }> {
  const fixture = await sideChatFixture()
  try {
    const parent = await fixture.service.create(fixture.cwd)
    const prompts = Array.from({ length: turns }, (_, index) => `冻结第 ${index + 1} 轮🙂🀄️ 正文`)
    for (const [index, prompt] of prompts.entries()) await sendTurn(fixture, parent.id, `parent-${String(index).padStart(4, '0')}`, prompt)
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await fixture.service.previewSideChat(source)
    const child = await fixture.service.createSideChat({
      source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-snapshot-fixture'
    })
    const pages: SideChatSnapshotBodyPage[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await fixture.service.readSideChatSnapshot(child.id, cursor)
      pages.push(page)
      if (!page.nextCursor) return { pages, childId: child.id }
      cursor = page.nextCursor
    }
    throw new Error('snapshot pagination did not finish')
  } finally {
    await fixture.cleanup()
  }
}
