import { json, sideChatDriver } from './side-chat-driving.mjs'

const MiB = 1024 * 1024
/** Larger than the removed 4 MiB body budget, and five of them pass the 16 MiB archive budget. */
const HUGE = 4 * MiB + 4096
const PARENT_TURNS = 5

/**
 * Large frozen history in the isolated production App process.
 *
 * The parent's own recorder archives more than 16 MiB of visible text with one message
 * larger than the removed 4 MiB budget. Preview, creation, the viewer's own
 * `readSideChatSnapshot` cursor chain and a real first send all run against the shipped
 * services in the packaged App; the Provider is the packaged fixture adapter, so the send
 * really executes and reports its own input receipt without contacting an account.
 *
 * This pass drives the shipped IPC seam, not rendered rows: a conversation the sidebar
 * lists as a Provider session has no row to guess. Pointer-level proof for the same
 * surfaces is the small-history execution pass and the snapshot component fixture.
 */
export async function exerciseSideChatLargeHistory({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, workspace, rendererFailures = [] }) {
  const { counts, since, conversation, seedTurns } =
    sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Large history' })

  // A real conversation of this workspace, then one visible first turn.
  const parentId = await evaluate(`window.scry.conversations.create(${json(workspace)}).then(created => created.id)`)
  check(typeof parentId === 'string' && parentId.length > 0, `the parent conversation has no id: ${json({ parentId })}`)
  // One visible first turn through the same preview/send seam the composer uses; it has
  // to settle before anything else is sent, or the next preview is refused.
  await seedTurns(parentId, ['large history parent'], 1)
  const seeded = await conversation(parentId)
  check(seeded.summary.turnCount === 1, `the parent's first turn did not settle: ${json(seeded.summary)}`)

  // Five more turns of >4 MiB each: the committed archive is far past 16 MiB of text.
  const body = size => `${'大'.repeat(Math.ceil(size / 3))}\n${Date.now()}`
  await seedTurns(parentId, Array.from({ length: PARENT_TURNS },
    (_unused, index) => `大历史第 ${index} 轮 ${body(HUGE)}`), 1)
  const parent = await conversation(parentId)
  check(parent.summary.turnCount >= PARENT_TURNS + 1, `the parent did not keep its turns: ${json(parent.summary)}`)

  // The App freezes a Provider session from its own binding: the recorder archives the
  // turns under that native session, which is what makes the prefix capturable at all.
  const binding = parent.bindings[0]
  check(binding?.nativeSessionId != null, `the parent has no native session to freeze: ${json({ bindings: parent.bindings })}`)
  const source = { kind: 'native-session', providerId: binding.providerId, cwd: parent.cwd ?? workspace,
    nativeSessionId: binding.nativeSessionId }
  const before = counts()
  const preview = await evaluate(`window.scry.conversations.previewSideChat(${json(source)}, {})`)
  check(preview.throughOrdinal === parent.summary.turnCount,
    `the preview must reach the last completed turn: ${json({ throughOrdinal: preview.throughOrdinal, turns: parent.summary.turnCount })}`)
  // The packaged smoke Provider archives one visible message per turn; what matters here
  // is that every recorded turn reached the snapshot and nothing was refused for size.
  check(preview.messageCount >= PARENT_TURNS, `the preview lost turns: ${json({ messageCount: preview.messageCount, turns: parent.turns.length })}`)
  check(preview.coverage.messageCount === preview.messageCount, `the coverage disagrees with the preview: ${json(preview.coverage)}`)
  // Freezing is never refused for size. A Provider without a verified history reader can
  // still be told honestly that the handoff would not fit; that is a capability boundary,
  // not the removed size budget, and it must name the missing reader.
  check(preview.firstSendBlockedReason === undefined || /历史检索工具/.test(preview.firstSendBlockedReason),
    `a large parent must freeze, and any refusal must name the missing capability: ${json({ reason: preview.firstSendBlockedReason })}`)
  check(preview.bodyBytes > 4 * MiB, `a >4 MiB visible message must be frozen whole: ${json({ bodyBytes: preview.bodyBytes })}`)
  // Retrievability is a Provider capability the App must report as it is: this fixture
  // declares no reader, so the frozen messages are counted as retrievable but unusable.
  check(typeof preview.coverage.readerAvailable === 'boolean', `the coverage must state reader availability: ${json(preview.coverage)}`)
  if (preview.coverage.readerAvailable === false) {
    // This fixture Provider declares no verified history reader, so creation must fail
    // closed with the capability reason instead of publishing a child whose history can
    // never reach a model. The size refusal this fix removed is gone from the same call.
    const refusal = await evaluate(`window.scry.conversations.createSideChat({ source: ${json(source)},
      expectedThroughOrdinal: ${json(preview.throughOrdinal)}, expectedThroughRunId: ${json(preview.throughRunId)},
      expectedPrefixFingerprint: ${json(preview.prefixFingerprint)}, expectedManifestFingerprint: ${json(preview.manifestFingerprint)},
      commandId: crypto.randomUUID(), initialTarget: ${json(preview.target)} })
      .then(() => null, error => String(error))`)
    check(typeof refusal === 'string' && /历史检索工具/.test(refusal),
      `creation must refuse for the missing reader, not for size: ${json({ refusal })}`)
    check(!/16 MiB|4 MiB|读取预算/.test(refusal), `a size budget still leaked into the refusal: ${json({ refusal })}`)
    const children = await evaluate(`window.scry.conversations.listSideChats({ source: ${json(source)}, limit: 5 })`)
    check((children?.sideChats ?? children?.items ?? []).length === 0,
      `a refused creation published a child: ${json({ children })}`)
    return { parentId, childId: null, messageCount: preview.messageCount, bodyBytes: preview.bodyBytes,
      readerAvailable: false, blocked: true, viewerPages: 0, parentTurns: parent.summary.turnCount }
  }

  // A reader-capable Provider: the same pass then seals, pages and sends.
  const childId = await evaluate(`(async () => {
    const created = await window.scry.conversations.createSideChat({ source: ${json(source)},
      expectedThroughOrdinal: ${json(preview.throughOrdinal)}, expectedThroughRunId: ${json(preview.throughRunId)},
      expectedPrefixFingerprint: ${json(preview.prefixFingerprint)}, expectedManifestFingerprint: ${json(preview.manifestFingerprint)},
      commandId: crypto.randomUUID(), initialTarget: ${json(preview.target)} })
    return created.id
  })()`)
  check(since(before)['conversation:createSideChat'] === 1, `one create call must reach main once: ${json(since(before))}`)
  const child = await conversation(childId)
  check(child.sideChat?.snapshot.format === 4, `creation must seal a format 4 snapshot: ${json({ snapshot: child.sideChat?.snapshot })}`)
  check(child.sideChat.snapshot.messageCount === preview.messageCount,
    `the sealed count must equal the preview: ${json({ sealed: child.sideChat.snapshot.messageCount, preview: preview.messageCount })}`)
  check(JSON.stringify(child).length < 40_000, `the child record grew with the history: ${json({ bytes: JSON.stringify(child).length })}`)

  // The viewer's own read chain: one cursor page at a time, front to back.
  const pages = []
  let cursor
  for (let page = 0; page < 80; page += 1) {
    const read = await evaluate(`window.scry.conversations.readSideChatSnapshot(${json(childId)}, ${cursor === undefined ? 'undefined' : json(cursor)})`)
    const bytes = read.items.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0)
    check(read.items.length <= 40, `a viewer page exceeded its row bound: ${json({ rows: read.items.length })}`)
    check(bytes <= read.byteLimit, `a viewer page exceeded its byte bound: ${json({ bytes, byteLimit: read.byteLimit })}`)
    pages.push({ rows: read.items.length, next: read.nextCursor ?? null, lastRole: read.items.at(-1)?.role ?? null })
    if (read.nextCursor == null) break
    cursor = read.nextCursor
  }
  check(pages.length > 1 && pages.at(-1).lastRole === 'assistant',
    `the frozen viewer chain stopped before the last message: ${json({ pages: pages.length, lastPage: pages.at(-1) })}`)

  // First send: the packaged Provider fixture really runs with the frozen source.
  const plan = await evaluate(`(async () => {
    const id = ${json(childId)}
    const target = { providerId: 'codex' }
    const preview = await window.scry.conversations.preview(id, target)
    if (preview.continuation.kind === 'blocked') throw new Error(preview.continuation.reason)
    await window.scry.conversations.send({ ...target, conversationId: id, expectedRevision: preview.revision,
      expectedContinuationKey: preview.target.continuationKey, commandId: crypto.randomUUID(),
      prompt: 'large history first send', selectedItems: preview.missingItems.map(item => item.ref), confirmFresh: true })
    return { sent: true }
  })()`)
  check(plan.sent === true, `the first send was not dispatched: ${json(plan)}`)
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const settled = await conversation(childId).then(page => page.turns.some(turn => turn.origin === 'dispatch'))
    if (settled) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const dispatched = await conversation(childId)
  const turn = dispatched.turns.find(candidate => candidate.origin === 'dispatch')
  if (turn?.origin === 'dispatch') {
    const omitted = turn.omittedItems.length +
      (turn.omittedRanges ?? []).reduce((sum, range) => sum + range.to - range.from + 1, 0)
    check(omitted + turn.importedItems.length === preview.messageCount,
      `the omission ledger does not add up: ${json({ omitted, imported: turn.importedItems.length, messages: preview.messageCount })}`)
    check(JSON.stringify(turn).length < 20_000,
      `the dispatch turn kept one reference per frozen message: ${json({ bytes: JSON.stringify(turn).length })}`)
  }
  return { parentId, childId, messageCount: preview.messageCount, bodyBytes: preview.bodyBytes,
    readerAvailable: preview.coverage.readerAvailable, blocked: preview.firstSendBlockedReason != null,
    viewerPages: pages.length, parentTurns: parent.summary.turnCount }
}
