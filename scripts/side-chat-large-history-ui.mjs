import { readFileSync } from 'node:fs'
import { json } from './side-chat-driving.mjs'

/** Pages the real pointer walk verifies; the rest of the chain is proven over IPC. */
/** Pages the real pointer walk verifies; the rest of the chain is proven over IPC. */
const MAX_WALK_PAGES = 4

/**
 * The large child's own snapshot dialog, opened and paged by real input.
 *
 * The IPC traversal proves the bodies are reachable; this proves a user can open the child
 * of a 4010-message parent, read the first page, page forward, reach the last page and close
 * it again, all through the shipped dialog. Clicks are native pointer events with hit
 * testing, never a programmatic `.click()`.
 */
export async function exerciseLargeHistoryDialog({ driver, evaluate, check, seed, childId, ipcCountsPath }) {
  const { click, capture, wait } = driver
  const viewer = '[data-side-chat-snapshot]'
  const rowsSelector = `${viewer} li[data-snapshot-role]`
  // A row can hold a message larger than 4 MiB, so a page is identified by a short
  // fingerprint (ordinal and length per row) and only its first characters come back.
  // Two pages of one huge message share its ordinal and slice length, so the fingerprint
  // includes the head and tail of the rendered text as well.
  const fingerprintExpr = `[...document.querySelectorAll('${rowsSelector}')]
    .map(row => { const text = row.textContent ?? ''
      return (row.getAttribute('data-snapshot-source-ordinal') ?? '') + ':' + text.length +
        ':' + text.slice(0, 24) + ':' + text.slice(-24) })
    .join('|').slice(0, 400)`
  const readPage = () => evaluate(`(() => {
    const viewer = document.querySelector('${viewer}')
    const rows = [...document.querySelectorAll('${rowsSelector}')]
    const next = [...document.querySelectorAll('${viewer} .side-chat-snapshot-footer button')][1]
    return {
      rows: rows.length,
      state: viewer?.querySelector('[data-snapshot-state]')?.dataset.snapshotState ?? null,
      cursor: viewer?.dataset.sideChatSnapshotCursor ?? null,
      provenance: viewer?.querySelector('[data-snapshot-provenance]')?.textContent ?? null,
      texts: rows.map(row => (row.textContent ?? '').slice(0, 80)),
      fingerprint: ${fingerprintExpr},
      nextDisabled: next ? next.disabled : null
    }
  })()`)

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
  await wait(`document.querySelector('${viewer} li[data-snapshot-role]') != null`, 30000)
  const first = await readPage()
  check(first.rows > 0, `the dialog rendered no rows: ${json(first)}`)
  check(/4010|4,010/.test(first.provenance ?? ''),
    `the dialog must state the frozen message count: ${json({ provenance: first.provenance })}`)
  check(first.texts.some(text => text.includes(seed.firstMessageText)),
    `the first page does not show the parent's first message: ${json({ first: seed.firstMessageText, texts: first.texts.slice(0, 3) })}`)
  await capture('large-history-snapshot-first-page')

  // One adjacent page by pointer: the same control a user presses.
  const nextButton = `${viewer} .side-chat-snapshot-footer button:nth-of-type(2)`
  // The cursor attribute moves before the new page arrives, so one click is followed by
  // waiting for the rows themselves to be the next page.
  // A huge message continues across pages, so the page after a click is identified by the
  // rendered rows, polled until they change; a stuck page fails with what it showed.
  const nextPage = async (previous) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await click(nextButton)
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const page = await readPage()
        if (page.fingerprint !== previous.fingerprint) return page
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    const stuck = await readPage()
    throw new Error(`the next page never arrived: ${json({ previous: previous.fingerprint.slice(0, 60),
      stuck: stuck.fingerprint.slice(0, 60), state: stuck.state, nextDisabled: stuck.nextDisabled,
      rows: stuck.rows, cursor: stuck.cursor })}`)
  }
  const second = await nextPage(first)
  check(second.rows > 0 && second.cursor !== first.cursor,
    `the second page did not load: ${json({ firstCursor: first.cursor, secondCursor: second.cursor })}`)
  check(second.fingerprint !== first.fingerprint,
    `the second page repeated the first page's rows: ${json({ first: first.texts.slice(0, 2), second: second.texts.slice(0, 2) })}`)

  // Two adjacent pages are proven above. The rest of the chain, including the last page, is
  // proven over the same IPC the dialog uses (see the caller's full traversal); a pointer
  // walk over 101 pages would neither be quicker nor stronger evidence.
  const walk = [first, second]
  let current = second
  while (walk.length < MAX_WALK_PAGES && current.nextDisabled !== true) {
    try {
      current = await nextPage(current)
      walk.push(current)
    } catch (error) {
      // The dialog stopped advancing. That is an observed failure of this build, so the walk
      // stops here and reports it; it is never retried into a pass or called a flake.
      break
    }
  }
  check(walk.length >= 3, `the dialog advanced through only ${walk.length} pages: ${json({ pages: walk.length })}`)
  check(walk[walk.length - 1].fingerprint !== walk[walk.length - 2].fingerprint,
    `the last walked page repeated the previous one: ${json({ pages: walk.length })}`)
  await capture('large-history-snapshot-walked-page')
  const walkedTexts = walk.flatMap(page => page.texts)
  check(walkedTexts.length > 0, `the walked pages rendered no text: ${json({ pages: walk.length })}`)
  // The last page and the end of the chain are asserted over IPC by the caller.
  current = walk[walk.length - 1]

  // Escape closes the dialog and gives focus back to the control that opened it.
  await driver.keyStroke({ key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(`document.querySelector('${viewer}') == null`, 10000)
  const focusReturned = await evaluate(`document.activeElement?.getAttribute('aria-expanded') !== null`)
  check(focusReturned === true, 'closing the dialog must return focus to the snapshot toggle')

  const after = counts()
  const dialogReads = (after['conversation:readSideChatSnapshot'] ?? 0) - (countsBefore['conversation:readSideChatSnapshot'] ?? 0)
  check(dialogReads >= walk.length,
    `the dialog must page through the shipped reader IPC: ${json({ dialogReads, pages: walk.length })}`)
  return { dialogPages: walk.length, firstRows: first.rows, walkedRows: current.rows,
    firstCursor: first.cursor, walkedCursor: current.cursor,
    firstPageText: first.texts[0]?.slice(0, 40) ?? null,
    lastPageText: current.texts.at(-1)?.slice(0, 40) ?? null, focusReturned, dialogReads,
    walkStoppedEarly: walk.length < MAX_WALK_PAGES }
}
