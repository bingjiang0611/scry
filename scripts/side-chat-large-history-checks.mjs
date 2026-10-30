import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { json, readJsonLines, sideChatDriver } from './side-chat-driving.mjs'

const MiB = 1024 * 1024
/** Paged viewer reads must finish inside this budget, or the check fails as incomplete. */
const VIEWER_DEADLINE_MS = 120_000

const seedOf = (path) => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Positive large-history acceptance in the packaged App.
 *
 * Runs on an App launched with the reader-enabled smoke adapter, so the Provider really
 * owns a history-reader transport. The seeded parent is one the App itself reads back:
 * more than 2000 turns, more than 4000 messages, a >16 MiB archive and a >4 MiB visible
 * message. The shipped preview freezes it, creation publishes a v4 child, the first send
 * really dispatches, the Provider pages the earliest/middle/latest omitted bodies over
 * the loopback MCP endpoint, and the child still reads them after the parent is deleted.
 */
export async function exerciseSideChatLargeHistory({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, readsPath, seedPath, userDataDir }) {
  const driver = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
    rendererFailures: [], label: 'Large history' })
  const seed = seedOf(seedPath)
  const source = { kind: 'conversation', conversationId: seed.conversationId }

  const preview = await evaluate(`window.scry.conversations.previewSideChat(${json(source)}, {})`)
  check(preview.firstSendBlockedReason === undefined,
    `a reader-capable Provider must not refuse this range: ${json({ reason: preview.firstSendBlockedReason })}`)
  check(preview.coverage.readerAvailable === true, `the reader must be available on this run: ${json(preview.coverage)}`)
  check(preview.messageCount === seed.messageCount,
    `the preview must freeze every message: ${json({ preview: preview.messageCount, seeded: seed.messageCount })}`)
  check(preview.bodyBytes > 4 * MiB, `the >4 MiB message must be frozen whole: ${json({ bodyBytes: preview.bodyBytes })}`)
  check(preview.coverage.inlineCount + preview.coverage.retrievableCount === seed.messageCount,
    `every frozen message must be classified: ${json(preview.coverage)}`)

  const created = await evaluate(`(async () => {
    const created = await window.scry.conversations.createSideChat({ source: ${json(source)},
      expectedThroughOrdinal: ${json(preview.throughOrdinal)}, expectedThroughRunId: ${json(preview.throughRunId)},
      expectedPrefixFingerprint: ${json(preview.prefixFingerprint)}, expectedManifestFingerprint: ${json(preview.manifestFingerprint)},
      commandId: crypto.randomUUID(), initialTarget: ${json(preview.target)} })
    return { id: created.id, bytes: JSON.stringify(created).length }
  })()`)
  check(typeof created.id === 'string' && created.id.length > 0, `creation returned no child: ${json(created)}`)
  check(created.bytes < 40_000, `the child summary grew with the history: ${json({ bytes: created.bytes })}`)
  const childId = created.id
  let child = await driver.conversation(childId)
  check(child.sideChat?.messageCount === seed.messageCount,
    `the sealed count must equal the preview: ${json({ sealed: child.sideChat?.messageCount })}`)
  // The record the App itself persisted must stay a bounded descriptor, not a transcript.
  const recordPath = join(userDataDir, 'conversations', `${childId}.json`)
  const record = readFileSync(recordPath, 'utf8')
  const descriptor = JSON.parse(record).sideChat?.snapshot
  check(descriptor?.format === 4, `creation must seal a format 4 descriptor: ${json({ descriptor })}`)
  check(descriptor.messageCount === seed.messageCount,
    `the descriptor must count every frozen message: ${json({ messageCount: descriptor.messageCount })}`)
  check(record.length < 20_000, `the child record grew with the history: ${json({ bytes: record.length })}`)

  // The first send really dispatches, and the Provider really reads the omitted history.
  const readsBefore = readJsonLines(readsPath).length
  // The send plan must not carry one reference per frozen message across the IPC boundary.
  const planShape = await evaluate(`(async () => {
    const id = ${json(childId)}
    const target = { providerId: ${json(seed.providerId)} }
    const plan = await window.scry.conversations.preview(id, target)
    if (plan.continuation.kind === 'blocked') throw new Error(plan.continuation.reason)
    await window.scry.conversations.send({ ...target, conversationId: id, expectedRevision: plan.revision,
      expectedContinuationKey: plan.target.continuationKey, commandId: crypto.randomUUID(),
      prompt: 'large history first send', selectedItems: plan.missingItems.map(item => item.ref), confirmFresh: true })
    return { missingItems: plan.missingItems.length, continuationItems: plan.continuation.missingItems.length }
  })()`)
  check(planShape.missingItems > 0 && planShape.missingItems <= 400 &&
    planShape.continuationItems === planShape.missingItems,
    `the send plan must stay a bounded inline window: ${json(planShape)}`)
  check(planShape.missingItems < seed.messageCount, `the send plan enumerated the whole snapshot: ${json(planShape)}`)
  const deadline = Date.now() + 120_000
  let dispatched
  while (Date.now() < deadline) {
    child = await driver.conversation(childId)
    // Imported prefixes report `imported`; only a real dispatch can settle otherwise.
    dispatched = child.turns.find(turn => turn.delivery.status !== 'imported')
    if (dispatched !== undefined && dispatched.delivery.status !== 'pending') break
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  check(dispatched !== undefined, `the first send published no dispatch turn: ${json({ turns: child.turns.map(turn => turn.delivery.status) })}`)
  check(dispatched.delivery.status === 'accepted',
    `the first send produced no accepted receipt: ${json({ delivery: dispatched.delivery })}`)

  const reads = readJsonLines(readsPath).slice(readsBefore)
  const read = reads.find(entry => Array.isArray(entry.reads) && entry.reads.length === 3)
  check(read != null, `the Provider never read the omitted history: ${json({ reads })}`)
  check(read.frozenItems === read.totalItems, `the manifest pages did not cover the child: ${json({ frozenItems: read.frozenItems, totalItems: read.totalItems })}`)
  // Every frozen message is either inline in the request or reachable through the reader.
  check(read.totalItems >= preview.coverage.retrievableCount,
    `the reader authorized ${json({ totalItems: read.totalItems, retrievable: preview.coverage.retrievableCount, inline: preview.coverage.inlineCount })}`)

  // Every body the Provider read must equal the frozen body it names.
  const sealed = await evaluate(`(async () => {
    const lengths = new Map()
    let rows = 0
    let cursor
    const started = Date.now()
    for (;;) {
      const read = await window.scry.conversations.readSideChatSnapshot(${json(childId)}, cursor)
      for (const item of read.items) {
        const id = JSON.stringify([item.ref.runId, item.ref.itemId, item.ref.contentHash])
        lengths.set(id, (lengths.get(id) ?? 0) + item.text.length)
        rows += 1
      }
      if (read.nextCursor == null) return { pages: [...lengths], rows, complete: true, elapsedMs: Date.now() - started }
      if (Date.now() - started > ${VIEWER_DEADLINE_MS}) return { pages: [...lengths], rows, complete: false, elapsedMs: Date.now() - started }
      cursor = read.nextCursor
    }
  })()`)
  check(sealed.complete === true, `the viewer chain never reached the end: ${json({ rows: sealed.rows, elapsedMs: sealed.elapsedMs })}`)
  const sealedById = new Map(sealed.pages)
  for (const entry of read.reads) {
    const length = sealedById.get(entry.id)
    check(typeof length === 'number', `the Provider read an id this child does not own: ${json({ id: entry.id })}`)
    check(entry.characters === length, `a read body was truncated: ${json({ id: entry.id, read: entry.characters, sealed: length })}`)
    check(entry.pages > 0, `a read body never completed: ${json({ id: entry.id, pages: entry.pages })}`)
  }

  // Deleting the parent must not take the child's own frozen bodies with it.
  await evaluate(`(async () => {
    const id = ${json(seed.conversationId)}
    const page = await window.scry.conversations.read(id)
    await window.scry.conversations.update(id, page.summary.revision, { kind: 'archive', archived: true })
    const plan = await window.scry.conversations.previewDeletion(id)
    await window.scry.conversations.delete(id, plan.fingerprint)
  })()`)
  const afterDelete = await evaluate(`(async () => {
    const lengths = new Map()
    let cursor
    const started = Date.now()
    for (;;) {
      const read = await window.scry.conversations.readSideChatSnapshot(${json(childId)}, cursor)
      for (const item of read.items) {
        const id = JSON.stringify([item.ref.runId, item.ref.itemId, item.ref.contentHash])
        lengths.set(id, (lengths.get(id) ?? 0) + item.text.length)
      }
      if (read.nextCursor == null) return { pages: [...lengths], complete: true, elapsedMs: Date.now() - started }
      if (Date.now() - started > ${VIEWER_DEADLINE_MS}) return { pages: [...lengths], complete: false, elapsedMs: Date.now() - started }
      cursor = read.nextCursor
    }
  })()`)
  check(afterDelete.complete === true, `the child stopped reading after its parent was deleted: ${json(afterDelete)}`)
  check(afterDelete.pages.length === sealed.pages.length,
    `the child lost rows after its parent was deleted: ${json({ before: sealed.pages.length, after: afterDelete.pages.length })}`)
  const afterById = new Map(afterDelete.pages)
  for (const entry of read.reads) {
    check(afterById.get(entry.id) === entry.characters,
      `a frozen body changed after its parent was deleted: ${json({ id: entry.id, before: entry.characters, after: afterById.get(entry.id) })}`)
  }
  return { parentId: seed.conversationId, childId, parentTurns: seed.turnCount, messageCount: seed.messageCount,
    archiveBytes: seed.archiveBytes, hugeMessageBytes: seed.hugeMessageBytes, viewerRows: sealed.pages.length,
    viewerElapsedMs: sealed.elapsedMs, planItems: planShape.missingItems, providerReads: read.reads.length,
    readsAfterDelete: afterDelete.pages.length, coverage: preview.coverage }
}

/**
 * The same large range on a Provider that declares no verified history reader.
 *
 * This is a capability boundary, not the removed size budget: the preview must not refuse
 * for size, and creation must fail closed with the reader reason instead of publishing a
 * child whose history could never reach a model.
 */
export async function exerciseSideChatLargeHistoryRefusal({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, seedPath }) {
  const driver = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
    rendererFailures: [], label: 'Large history refusal' })
  const seed = seedOf(seedPath)
  const source = { kind: 'conversation', conversationId: seed.conversationId }
  const preview = await evaluate(`window.scry.conversations.previewSideChat(${json(source)}, {})`)
  check(preview.messageCount === seed.messageCount, `the refusal preview lost turns: ${json({ messageCount: preview.messageCount })}`)
  check(/历史检索工具/.test(preview.firstSendBlockedReason ?? ''),
    `without a reader the refusal must name the capability: ${json({ reason: preview.firstSendBlockedReason })}`)
  check(!/16 MiB|4 MiB|读取预算/.test(preview.firstSendBlockedReason ?? ''),
    `a size budget leaked into the refusal: ${json({ reason: preview.firstSendBlockedReason })}`)
  const refusal = await evaluate(`window.scry.conversations.createSideChat({ source: ${json(source)},
    expectedThroughOrdinal: ${json(preview.throughOrdinal)}, expectedThroughRunId: ${json(preview.throughRunId)},
    expectedPrefixFingerprint: ${json(preview.prefixFingerprint)}, expectedManifestFingerprint: ${json(preview.manifestFingerprint)},
    commandId: crypto.randomUUID(), initialTarget: ${json(preview.target)} }).then(() => null, error => String(error))`)
  check(typeof refusal === 'string' && /历史检索工具/.test(refusal), `creation must refuse for the missing reader: ${json({ refusal })}`)
  const children = await evaluate(`window.scry.conversations.listSideChats({ source: ${json(source)}, limit: 5 })`)
  check((children?.items ?? []).length === 0, `a refused creation published a child: ${json({ children })}`)
  const parent = await driver.conversation(seed.conversationId)
  check(parent.summary.turnCount === seed.turnCount && parent.summary.sideChat === undefined,
    `a refused creation must not touch the parent: ${json({ turnCount: parent.summary.turnCount })}`)
  return { parentId: seed.conversationId, messageCount: preview.messageCount, bodyBytes: preview.bodyBytes, refused: true }
}
