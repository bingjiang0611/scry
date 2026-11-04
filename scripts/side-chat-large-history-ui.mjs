import { readFileSync } from 'node:fs'
import { json } from './side-chat-driving.mjs'

/** Whole-chain pointer walk budget. It is a deadline, not a page cap: the walk ends on the
 * dialog's own end-of-chain state, and a chain that cannot finish inside the budget fails. */
const WALK_DEADLINE_MS = 300_000
/** Continuation marker the viewer prints on a row whose body is cut by the page boundary. */
const CONTINUED = '正文在下一页继续'

/**
 * The large child's own snapshot dialog, opened and paged by real pointer and key input.
 *
 * The IPC traversal proves the bodies are reachable; this proves a user can open the child of
 * a 4010-message parent and page from the first body to the end of the chain through the
 * shipped dialog: one native click per page, then wait until the page that actually loaded is
 * the one the previous page announced. Cursor identity is the oracle, not rendered text —
 * a 4 MiB body repeats, so two legal pages of it can read identically while being different
 * pages. Every assertion is about the loaded page, never about the requested one.
 */
export async function exerciseLargeHistoryDialog({ driver, evaluate, check, seed, childId, ipcCountsPath }) {
  const { click, capture, wait } = driver
  const viewer = '[data-side-chat-snapshot]'
  const rowsSelector = `${viewer} li[data-snapshot-role]`
  const readPage = () => evaluate(`(() => {
    const viewer = document.querySelector('${viewer}')
    const rows = [...document.querySelectorAll('${rowsSelector}')]
    const buttons = [...document.querySelectorAll('${viewer} .side-chat-snapshot-footer button')]
    return {
      requested: viewer?.dataset.sideChatSnapshotCursor ?? null,
      loaded: viewer?.dataset.sideChatSnapshotLoadedCursor ?? null,
      next: viewer?.dataset.sideChatSnapshotNextCursor || null,
      busy: viewer?.getAttribute('aria-busy') ?? null,
      rows: rows.length,
      state: viewer?.querySelector('[data-snapshot-state]')?.dataset.snapshotState ?? null,
      provenance: viewer?.querySelector('[data-snapshot-provenance]')?.textContent ?? null,
      ordinals: rows.map(row => Number(row.dataset.snapshotSourceOrdinal)),
      continued: rows.filter(row => (row.textContent ?? '').includes(${json(CONTINUED)})).length,
      texts: rows.map(row => (row.textContent ?? '').slice(0, 80)),
      olderDisabled: buttons[0]?.disabled ?? null,
      nextDisabled: buttons[1]?.disabled ?? null } })()`)
  /** The only evidence that a page arrived: the dialog says which page it finished loading. */
  const loadedIs = at => `document.querySelector('${viewer}')?.dataset.sideChatSnapshotLoadedCursor === ${json(at)}`
  const counts = () => {
    try { return JSON.parse(readFileSync(ipcCountsPath, 'utf8')) } catch { return {} }
  }
  const countsBefore = counts()

  // The parent is gone by now, so the shipped way back to this child is its orphan row: the
  // sidebar groups it under the captured source and opening it mounts a real main surface.
  await wait(`[...document.querySelectorAll('[data-orphan-side-chat-id]')].some(node => node.dataset.orphanSideChatId === ${json(childId)})`, 30000)
  await driver.clickAt(`[...document.querySelectorAll('[data-orphan-side-chat-id]')].find(node => node.dataset.orphanSideChatId === ${json(childId)})`)
  await wait(`document.querySelector('#main-pane [data-side-chat-variant="main"]') != null`, 20000)
  await driver.idle()
  check(await evaluate(`document.querySelector('#main-pane [data-side-chat-id="${childId}"]') != null`),
    'the large child never opened as a real side-chat surface')
  // The toggle is the shipped control; it is the only way into the dialog.
  const toggle = `#main-pane .side-chat-surface[data-side-chat-id="${childId}"] .side-chat-surface-actions button[aria-expanded]`
  check(await evaluate(`document.querySelector('${toggle}') != null`), 'the side-chat header has no snapshot toggle')
  await click(toggle)
  await wait(loadedIs('0:0'), 30000)
  const first = await readPage()
  check(first.rows > 0, `the dialog rendered no rows: ${json(first)}`)
  check(/4010|4,010/.test(first.provenance ?? ''),
    `the dialog must state the frozen message count: ${json({ provenance: first.provenance })}`)
  check(first.texts.some(text => text.includes(seed.firstMessageText)),
    `the first page does not show the parent's first message: ${json({ first: seed.firstMessageText, texts: first.texts.slice(0, 3) })}`)
  check(first.olderDisabled === true && first.nextDisabled === false,
    `the first page must offer only "next": ${json({ older: first.olderDisabled, next: first.nextDisabled })}`)
  await capture('large-history-snapshot-first-page')

  // One click per page, then wait for that exact page. No retry, no catch: a page that never
  // arrives fails with the state it was stuck in.
  const nextButton = `${viewer} .side-chat-snapshot-footer button:nth-of-type(2)`
  const olderButton = `${viewer} .side-chat-snapshot-footer button:nth-of-type(1)`
  const started = Date.now()
  let pages = 0
  let continuedRows = 0
  let hugeMessageSeen = false
  let current = first
  let previousPage
  let midCaptured = false
  while (current.next !== null) {
    if (Date.now() - started > WALK_DEADLINE_MS) {
      throw new Error(`the dialog did not reach the end of the chain inside ${WALK_DEADLINE_MS} ms: ${json({
        pages, loaded: current.loaded, next: current.next, rows: current.rows, state: current.state })}`)
    }
    await click(nextButton)
    await wait(loadedIs(current.next), 30000)
    previousPage = current
    current = await readPage()
    check(current.loaded === previousPage.next,
      `the dialog loaded a different page than the one it announced: ${json({ announced: previousPage.next, loaded: current.loaded })}`)
    check(current.busy === 'false', `the dialog stayed busy after a page loaded: ${json({ busy: current.busy })}`)
    pages += 1
    continuedRows += current.continued
    hugeMessageSeen ||= current.ordinals.includes(seed.hugeOrdinal)
    if (!midCaptured && current.ordinals.includes(seed.hugeOrdinal)) {
      await capture('large-history-snapshot-huge-message-page')
      midCaptured = true
    }
    if (pages % 20 === 0) {
      process.stderr.write(`[large history dialog] ${pages} pages, loaded ${current.loaded}, ${current.ordinals.at(-1) ?? '-'} / ${seed.turnCount}\r`)
    }
  }
  const last = current
  const walkedMs = Date.now() - started

  check(last.state === 'complete', `the last loaded page is not the end of the chain: ${json({ state: last.state, next: last.next })}`)
  check(last.nextDisabled === true && last.olderDisabled === false,
    `the end of the chain must disable "next" and keep "older": ${json({ next: last.nextDisabled, older: last.olderDisabled })}`)
  check(last.ordinals.at(-1) === seed.turnCount,
    `the last page must end at the parent's last turn (${seed.turnCount}): ${json({ ordinals: last.ordinals.slice(-3) })}`)
  check(hugeMessageSeen && continuedRows > 0,
    `the ${seed.hugeMessageBytes} byte message must page through the dialog: ${json({ hugeMessageSeen, continuedRows })}`)
  check(pages >= Math.ceil(seed.messageCount / 40) - 1,
    `a ${seed.messageCount} message chain must page in full, saw ${pages}`)
  await capture('large-history-snapshot-last-page')

  // Back and forward again: the previous page and this one are restored by cursor, so the
  // walk is reversible and the last page is reachable twice.
  await click(olderButton)
  await wait(loadedIs(previousPage.loaded), 20000)
  const restoredOlder = await readPage()
  check(restoredOlder.rows > 0 && restoredOlder.nextDisabled === false,
    `the older page did not come back: ${json({ rows: restoredOlder.rows, next: restoredOlder.nextDisabled })}`)
  await click(nextButton)
  await wait(loadedIs(last.loaded), 20000)
  const restoredLast = await readPage()
  check(restoredLast.state === 'complete' && restoredLast.nextDisabled === true,
    `the last page did not come back: ${json({ state: restoredLast.state, next: restoredLast.nextDisabled })}`)

  // Escape closes the dialog and gives focus back to the control that opened it.
  await driver.keyStroke({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(`document.querySelector('${viewer}') == null`, 10000)
  const focusReturned = await evaluate(`document.activeElement?.getAttribute('aria-expanded') !== null`)
  check(focusReturned === true, 'closing the dialog must return focus to the snapshot toggle')

  const after = counts()
  const dialogReads = (after['conversation:readSideChatSnapshot'] ?? 0) - (countsBefore['conversation:readSideChatSnapshot'] ?? 0)
  check(dialogReads >= pages + 2,
    `the dialog must page through the shipped reader IPC: ${json({ dialogReads, pages })}`)
  return { dialogPages: pages, firstRows: first.rows, walkedMs, lastCursor: last.loaded,
    firstPageText: first.texts[0]?.slice(0, 40) ?? null,
    lastPageText: last.texts.at(-1)?.slice(0, 40) ?? null,
    lastSourceOrdinal: last.ordinals.at(-1) ?? null, continuedRows, hugeMessageSeen,
    restoredCursor: restoredLast.loaded, focusReturned, dialogReads }
}
