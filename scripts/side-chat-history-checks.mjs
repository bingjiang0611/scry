import { CHILD_PANEL, SIDE_CHAT_SURFACE, json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * Side-chat history and tab bounds in the isolated production App.
 *
 * The parent already owns more than two hundred real children. The tab strip stays bounded
 * to eight, and the history dialog is the way back to every one of them: it pages through
 * the host cursor, so the oldest child is still openable by its own id after a restart of
 * the window (close != delete).
 */
export async function exerciseSideChatHistory({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, childId, rendererFailures = [] }) {
  const {
    capture, click, clickAt, idle, wait, counts, since, conversation
  } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat history' })
  const seeded = await evaluate(`(async () => {
    const page = await window.scry.conversations.read(${json(childId)})
    const source = page.sideChat.source
    const preview = await window.scry.conversations.previewSideChat(source, {})
    const created = []
    for (let index = 0; index < 200; index += 1) {
      const child = await window.scry.conversations.createSideChat({
        source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
        expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
        commandId: crypto.randomUUID(), initialTarget: preview.target
      })
      created.push(child.id)
    }
    return { source, created, total: created.length }
  })()`)
  check(seeded.created.length === 200, `the parent could not own 200 children: ${json({ created: seeded.created.length })}`)
  await idle()

  // The tab strip is a display bound, not a data loss: at most eight children stay open.
  const strip = await evaluate(`[...document.querySelectorAll('#right-surface-pane [data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId)`)
  check(strip.length > 0 && strip.length <= 8, `the tab strip must stay bounded to eight children: ${json(strip)}`)

  // Open the history dialog from the chooser and walk back to the oldest child.
  while (await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tab-close') != null`)) {
    await click(`${SIDE_CHAT_SURFACE} .surface-tab-close`)
    await idle()
  }
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser]') != null`)
  const footerButtons = await evaluate(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-chooser-footer button')].map(node => node.textContent.trim())`)
  check(footerButtons.includes('历史侧边会话'), `the chooser must offer the child history: ${json(footerButtons)}`)
  await clickAt(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-chooser-footer button')]
    .find(node => node.textContent.trim() === '历史侧边会话')`)
  await wait(`document.querySelector('[data-side-chat-history-total]') != null && document.querySelectorAll('[data-side-chat-history-id]').length > 0`)
  const total = await evaluate(`document.querySelector('[data-side-chat-history-total]')?.textContent ?? null`)
  check(total === '共 201 个侧边会话', `the history header must count every child: ${json(total)}`)
  const pages = []
  for (let page = 0; page < 12; page += 1) {
    const state = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-side-chat-history-id]')].map(node => node.dataset.sideChatHistoryId)
      const buttons = [...document.querySelectorAll('.side-chat-history-footer button')].map(node => node.textContent.trim())
      return { rows, buttons, range: document.querySelector('.side-chat-history-footer')?.textContent ?? '' }
    })()`)
    pages.push({ rows: state.rows, first: state.rows[0], last: state.rows.at(-1), count: state.rows.length, buttons: state.buttons })
    if (state.rows.includes(childId)) break
    const older = state.buttons.includes('更早的侧边会话')
    check(older, `paging stopped before the oldest child was reachable: ${json(pages)}`)
    await clickAt(`[...document.querySelectorAll('.side-chat-history-footer button')].find(node => node.textContent.trim() === '更早的侧边会话')`)
    await wait(`document.querySelector('[data-side-chat-history]') != null`)
    await wait(`[...document.querySelectorAll('[data-side-chat-history-id]')].map(node => node.dataset.sideChatHistoryId)[0] !== ${json(pages.at(-1).first)}`)
  }
  const oldestReachable = pages.length > 1 && pages.at(-1).rows?.includes(childId) ||
    (await evaluate(`[...document.querySelectorAll('[data-side-chat-history-id]')].some(node => node.dataset.sideChatHistoryId === ${json(childId)})`))
  check(oldestReachable, `the oldest of 201 children never became reachable: ${json(pages)}`)
  await capture('history-oldest-page')

  // Reopening the oldest row by its own id opens exactly that record.
  await clickAt(`[...document.querySelectorAll('[data-side-chat-history-id]')]
    .find(node => node.dataset.sideChatHistoryId === ${json(childId)})`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`, 30000)
  const opened = await evaluate(`(() => ({
    childId: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null,
    tabs: [...document.querySelectorAll('#right-surface-pane [data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId).length,
    dialog: document.querySelector('[data-side-chat-history]') != null
  }))()`)
  check(opened.childId === childId, `reopening by id opened another child: ${json(opened)}`)
  check(opened.tabs <= 8, `reopening by id exceeded the tab bound: ${json(opened)}`)
  await capture('history-oldest-open')

  // Close is a view action: the record stays, and the tab strip proves it is gone.
  const before = counts()
  await click(`${SIDE_CHAT_SURFACE} .surface-tab-close`)
  await idle()
  const closed = await evaluate(`(() => ({
    tabs: [...document.querySelectorAll('#right-surface-pane [data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
    panel: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null
  }))()`)
  check(!closed.tabs.includes(childId), `closing a tab left it open: ${json(closed)}`)
  check((since(before)['conversation:delete'] ?? 0) === 0, `closing a tab deleted a child: ${json(since(before))}`)
  const stillThere = await conversation(childId)
  check(stillThere.summary.id === childId, 'the closed child record disappeared')
  await idle()
  // Leave the workbench with the source child open again: the restart check restores the
  // same tab, and nothing about this close/paging pass may have dropped its record.
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tab-close') == null`)
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-chooser-footer') != null`)
  await clickAt(`[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-chooser-footer button')]
    .find(node => node.textContent.trim() === '历史侧边会话')`)
  await wait(`document.querySelector('[data-side-chat-history-total]') != null`)
  for (let page = 0; page < 12; page += 1) {
    const present = await evaluate(`[...document.querySelectorAll('[data-side-chat-history-id]')].some(node => node.dataset.sideChatHistoryId === ${json(childId)})`)
    if (present) break
    await clickAt(`[...document.querySelectorAll('.side-chat-history-footer button')].find(node => node.textContent.trim() === '更早的侧边会话')`)
    await wait(`document.querySelector('[data-side-chat-history]') != null`)
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  await clickAt(`[...document.querySelectorAll('[data-side-chat-history-id]')]
    .find(node => node.dataset.sideChatHistoryId === ${json(childId)})`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(childId)}`, 30000)
  await idle()
  return {
    seededChildren: seeded.created.length,
    tabBound: strip.length,
    historyTotal: total,
    pages: pages.map(page => ({ count: page.count, first: page.first, last: page.last })),
    reopenedOldest: opened,
    closed: { tabs: closed.tabs.length, recordKept: stillThere.summary.id === childId, deleteCalls: since(before)['conversation:delete'] ?? 0 },
    oldestId: childId,
    childId
  }
}
