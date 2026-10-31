import { CHILD_PANEL, SIDE_CHAT_SURFACE, json, sideChatDriver } from './side-chat-driving.mjs'

/** A transcript deeper than three 40-turn pages, so the old page budget cannot reach it. */
const LONG_TURNS = 130

/**
 * Anchor restore of a genuinely long child transcript in the isolated production App.
 *
 * The old restore walked at most three older pages and then silently landed on the oldest
 * loaded turn, which is a different place in a 130-turn child. A position now remembers the
 * anchor's own ordinal, so one bounded page read lands on that turn, and it also remembers
 * the anchor's distance from the top edge, so the reader returns to the same reading
 * position instead of the top of the window. Everything below is a real scroll, a real tab
 * switch and a real close/reopen of the shipped surface.
 */
export async function exerciseSideChatScroll({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, workspace, childId, rendererFailures = [] }) {
  const {
    capture, click, clickAt, idle, wait, counts, since, conversation, seedTurns, createChildOf, openChildById
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat scroll' })
  const source = await evaluate(`window.scry.conversations.read(${json(childId)}).then(page => page.sideChat.source)`)
  const longId = await createChildOf(source, `scroll-${Date.now()}`)
  // The oldest page must be taller than the viewport, otherwise "mid-transcript" is the
  // only page and a restore that lands on the first loaded turn cannot be told apart.
  const prompts = Array.from({ length: LONG_TURNS }, (_, index) =>
    index < 12 ? `side chat fill turn-${String(index + 1).padStart(3, '0')}` : `scroll turn ${String(index + 1).padStart(3, '0')}`)
  const seeded = await seedTurns(longId, prompts)
  check(seeded === LONG_TURNS, `the long child did not reach ${LONG_TURNS} turns: ${json({ seeded })}`)
  await idle()

  /** The reading position a user sees: the turn at the top edge and its distance above it. */
  const reading = () => evaluate(`(() => {
    // The shipped scroller is the transcript element, not its padded wrapper.
    const body = document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript')
    if (!body) return null
    const bounds = body.getBoundingClientRect()
    const turns = [...body.querySelectorAll('[data-turn-ordinal]')]
    const top = turns.find(node => node.getBoundingClientRect().bottom > bounds.top + 1)
    return {
      ordinal: top ? Number(top.dataset.turnOrdinal) : null, runId: top?.dataset.runId ?? null,
      offset: top ? Math.round(top.getBoundingClientRect().top - bounds.top) : null,
      turns: turns.length, first: turns[0] ? Number(turns[0].dataset.turnOrdinal) : null,
      scrollTop: Math.round(body.scrollTop),
      atBottom: body.scrollHeight - body.scrollTop - body.clientHeight <= 8
    }
  })()`)
  /** Where one exact turn sits relative to the top edge right now; null when it is not loaded. */
  const offsetOfTurn = (runId) => evaluate(`(() => {
    const body = document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript')
    const turn = body?.querySelector('[data-run-id="' + CSS.escape(${json(runId)}) + '"]')
    if (!body || !turn) return null
    return Math.round(turn.getBoundingClientRect().top - body.getBoundingClientRect().top)
  })()`)
  /**
   * Wait for the bounded restore to settle on the remembered turn, then require the same
   * reading position. A restore is allowed to read one older page, so it is not visible in
   * the first frame; sampling once would report the newest page as the answer.
   */
  const waitRestoredAnchor = async (anchor, label) => {
    const deadline = Date.now() + 30000
    let state = await reading()
    while (Date.now() < deadline) {
      state = await reading()
      if (state?.runId === anchor.runId) {
        const offset = await offsetOfTurn(anchor.runId)
        return { ...state, anchorOffset: offset }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await capture(`anchor-lost-${label.replace(/[^a-z0-9]+/gi, '-')}`)
    throw new Error(`the ${label} restore never landed on the remembered turn ${anchor.runId}: ${json({ anchor, state })}`)
  }

  await openChildById(longId)
  // Walk back with the shipped pager. One page takes a real read, so each step waits for
  // the transcript's own first ordinal to move instead of assuming it happened.
  const firstOrdinal = () => evaluate(`(() => {
    const turn = document.querySelector('${CHILD_PANEL} .chat-body [data-turn-ordinal]')
    return turn ? Number(turn.dataset.turnOrdinal) : null
  })()`)
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body [data-turn-ordinal]') != null`, 30000)
  await wait(`[...document.querySelectorAll('[data-side-chat-panel] .unified-pagination button')]
    .some(node => node.textContent.trim() === '更早记录' && node.disabled === false)`, 30000)
  const transcript = () => evaluate(`(() => {
    const panel = document.querySelector('${CHILD_PANEL}')
    const body = panel?.querySelector('.chat-body .chat-transcript')
    const ordinals = [...(body?.querySelectorAll('[data-turn-ordinal]') ?? [])].map(node => Number(node.dataset.turnOrdinal))
    return { body: body != null, loaded: ordinals.length, first: ordinals[0] ?? null, last: ordinals.at(-1) ?? null,
      panelChild: panel?.querySelector('.side-chat-surface')?.dataset.sideChatId ?? null,
      pagination: [...panel.querySelectorAll('.unified-pagination button')].map(node => [node.textContent.trim(), node.disabled]) }
  })()`)
  const paged = []
  for (let page = 0; page < 3; page += 1) {
    const before = await firstOrdinal()
    const older = await evaluate(`[...document.querySelectorAll('[data-side-chat-panel] .unified-pagination button')].find(node => node.textContent.trim() === '更早记录')?.disabled === false`)
    paged.push({ before, older })
    if (!older) break
    await clickAt(`[...document.querySelectorAll('[data-side-chat-panel] .unified-pagination button')].find(node => node.textContent.trim() === '更早记录')`)
    await wait(`(() => { const turn = document.querySelector('${CHILD_PANEL} .chat-body [data-turn-ordinal]');
      return turn != null && Number(turn.dataset.turnOrdinal) !== ${before === null ? 'null' : before} })()`, 15000)
    await idle()
  }
  const deep = await transcript()
  // The reader is now on the oldest bounded page. That page is deeper than three pages from
  // the newest one, so a restore that simply walks back three pages can never reach it.
  check(deep.first != null && deep.first <= 10, `the pager did not reach the oldest page: ${json({ deep, paged })}`)
  check(deep.loaded <= 40, `one page must stay bounded: ${json(deep)}`)
  // A reader part-way through one turn: the anchor's own top must sit above the edge, so
  // landing on the first loaded turn (offset 0) is a visibly different place. The chosen
  // turn must be mounted, otherwise its height is a placeholder estimate and the position
  // would be measured against a row that does not exist yet.
  const target = await evaluate(`(async () => {
    const body = document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript')
    const settle = async () => new Promise(resolve => setTimeout(resolve, 160))
    body.scrollTop = 0
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await settle()
    const bounds = body.getBoundingClientRect()
    const turns = [...body.querySelectorAll('[data-turn-ordinal]')]
    const chosen = turns.find(node => node.dataset.virtualized === undefined && node.getBoundingClientRect().height >= 200)
    const contentTop = chosen.getBoundingClientRect().top - bounds.top + body.scrollTop
    body.scrollTop = Math.min(body.scrollHeight - body.clientHeight, Math.round(contentTop) + 80)
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    await settle()
    const edges = body.getBoundingClientRect()
    const top = [...body.querySelectorAll('[data-turn-ordinal]')].find(node => node.getBoundingClientRect().bottom > edges.top + 1)
    return { ordinal: Number(top.dataset.turnOrdinal), runId: top.dataset.runId ?? null,
      offset: Math.round(top.getBoundingClientRect().top - edges.top), height: Math.round(top.getBoundingClientRect().height),
      mounted: top.dataset.virtualized === undefined,
      scrollTop: Math.round(body.scrollTop), loaded: body.querySelectorAll('[data-turn-ordinal]').length,
      atBottom: body.scrollHeight - body.scrollTop - body.clientHeight <= 8 }
  })()`)
  check(target.atBottom === false, `the scroll fixture must record a mid-transcript anchor: ${json({ target, deep })}`)
  check(target.mounted === true && Math.abs(target.offset + 80) <= 4,
    `the anchor must sit part-way inside one mounted turn, not on a row boundary: ${json({ target })}`)
  check(target.ordinal <= 10 && target.runId != null,
    `the anchor must sit on the oldest page, beyond a three-page walk: ${json({ target, deep })}`)
  await idle()
  await capture('scroll-long-anchor')

  // A real tab switch away (a tool surface) and back: the same turn comes back to the same
  // edge, and one bounded read is enough to find it.
  await click(`${SIDE_CHAT_SURFACE} [aria-label="添加 Surface"]`)
  await wait(`document.querySelector('[role="menu"]') != null`, 10000)
  await clickAt(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(node => node.textContent.includes('文件'))`)
  await wait(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} [role="tab"]')].some(node => node.textContent.trim() === '文件')`, 15000)
  await clickAt(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} [role="tab"]')].find(node => node.textContent.trim() === '文件')`)
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript') == null`, 15000)
  const readsBefore = counts()['conversation:read'] ?? 0
  await click(`[data-side-chat-tab-id="${longId}"] [role="tab"]`)
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript [data-turn-ordinal]') != null`, 30000)
  const afterSwitch = await waitRestoredAnchor(target, 'tab switch')
  const readsAfter = (counts()['conversation:read'] ?? 0) - readsBefore
  // The same turn AND the same distance above the edge: a landing on the top of the loaded
  // window would be a different ordinal or a zero offset.
  check(afterSwitch.anchorOffset != null && Math.abs(afterSwitch.anchorOffset - target.offset) <= 2,
    `a tab switch lost the long-transcript reading position: ${json({ target, afterSwitch })}`)
  check(afterSwitch.turns <= 40, `a restore must stay inside one bounded window: ${json({ afterSwitch })}`)
  check(readsAfter <= 3, `restoring one anchor read too many pages: ${json({ readsAfter })}`)
  await capture('scroll-restored-after-switch')

  // Close the tab (a view action) and reopen it by id: the record and the anchor survive.
  const before = counts()
  while (await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tab-close') != null`)) {
    await click(`${SIDE_CHAT_SURFACE} .surface-tab-close`)
    await idle()
  }
  check((since(before)['conversation:delete'] ?? 0) === 0, 'closing the long child deleted its record')
  const closedTabs = await evaluate(`document.querySelectorAll('${SIDE_CHAT_SURFACE} [data-side-chat-tab-id]').length`)
  check(closedTabs === 0, `the last tab close left a tab behind: ${json({ closedTabs })}`)
  await idle()
  const readsBeforeReopen = counts()['conversation:read'] ?? 0
  await openChildById(longId)
  const afterReopen = await waitRestoredAnchor(target, 'close and reopen')
  const readsReopen = (counts()['conversation:read'] ?? 0) - readsBeforeReopen
  check(afterReopen.anchorOffset != null && Math.abs(afterReopen.anchorOffset - target.offset) <= 2,
    `closing and reopening the last tab lost the reading position: ${json({ target, afterReopen })}`)
  check(afterReopen.turns <= 40, `a reopen restore must stay inside one bounded window: ${json({ afterReopen })}`)
  check(readsReopen <= 4, `reopening one child read too many pages: ${json({ readsReopen })}`)
  const record = await conversation(longId)
  check(record.summary.turnCount === LONG_TURNS, `the long child record changed: ${json({ turns: record.summary.turnCount })}`)
  await capture('scroll-restored-after-reopen')
  return { childId: longId, seeded, deep, target, afterSwitch, readsAfter, afterReopen, readsReopen,
    closeDeleted: false, turns: record.summary.turnCount }
}
