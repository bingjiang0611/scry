import { SIDE_CHAT_SURFACE, json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * The workbench as the user sees it plus the row the App really saved for it.
 *
 * `wanted` is the set of children whose saved scope row is the one to read; the DOM half is
 * read from the current surface only, so a retained other session cannot answer for it.
 */
export const readWorkbench = (evaluate, wanted) => evaluate(`(() => {
  const pane = document.querySelector('#right-surface-pane')
  const strip = pane?.querySelector('[data-session-surface-current="true"] .surface-tabs')
  const tabs = [...(strip?.querySelectorAll('[role="tab"]') ?? [])].map(node => ({
    sideChat: node.closest('[data-side-chat-tab-id]')?.dataset.sideChatTabId ?? null,
    tool: node.closest('[data-surface-tab="tool"]')?.querySelector('.label')?.textContent ?? null,
    selected: node.getAttribute('aria-selected') === 'true' }))
  let saved = null
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !key.startsWith('scry.session-right-surfaces.')) continue
    let rows
    try { rows = JSON.parse(localStorage.getItem(key) ?? '[]') } catch { continue }
    for (const [scope, value] of rows) {
      const state = value?.state
      if (!Array.isArray(state?.sideChats) || !${json(wanted)}.every(id => state.sideChats.includes(id))) continue
      saved = { scope, key, sideChats: state.sideChats, activeSideChatId: state.activeSideChatId ?? null,
        openIds: state.openIds ?? [], visible: state.visible === true }
    }
  }
  return { shown: strip != null, childTabs: tabs.filter(tab => tab.sideChat).map(tab => tab.sideChat),
    toolTabs: tabs.filter(tab => tab.tool).map(tab => tab.tool),
    selectedChild: tabs.find(tab => tab.selected)?.sideChat ?? null,
    selectedTool: tabs.find(tab => tab.selected)?.tool ?? null, saved }
})()`)

/**
 * The workbench both children come back to after a real quit.
 *
 * The saved row and the tab strip must show the same ordered child tabs and the same active
 * child as before the quit, and this is read before any repair click: a tab that only
 * reappears after someone reopens the child is not a restored layout.
 */
export async function verifySideChatWorkbenchAfterRestart({ cdp, evaluate, check, ipcCountsPath, inputsPath,
  callsPath, documentEpoch, prepared, rendererFailures = [] }) {
  const { capture, clickAt, idle, wait } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath,
    callsPath, rendererFailures, label: 'Side-chat workbench restart' })
  const layout = prepared.workbench
  await wait(`performance.timeOrigin !== ${json(documentEpoch)} && Boolean(window.scry?.conversations && document.querySelector('.sidebar'))`)
  await wait(`document.querySelectorAll('.sb-sess').length > 0`)
  await idle()
  const savedOnly = await readWorkbench(evaluate, layout.children)
  check(savedOnly.saved != null && json(savedOnly.saved.sideChats) === json(layout.children),
    `the restarted App must restore the saved child tabs: ${json({ saved: savedOnly.saved, layout })}`)
  check(savedOnly.saved.activeSideChatId === layout.active,
    `the restarted App must restore the active child tab: ${json({ saved: savedOnly.saved, layout })}`)
  // Showing the parent is navigation, not a repair: no child tab and no history dialog is
  // touched before the strip is read.
  const parentIndex = await evaluate(`[...document.querySelectorAll('.sb-sess')]
    .findIndex(row => row.textContent.includes('side chat parent turn'))`)
  check(parentIndex >= 0, `the restarted sidebar lost the parent conversation: ${json(await evaluate(
    `[...document.querySelectorAll('.sb-sess')].map(row => row.textContent.slice(0, 40))`))}`)
  await clickAt(`[...document.querySelectorAll('.sb-sess')][${parentIndex}]`)
  await wait(`[...document.querySelectorAll('.sb-sess')][${parentIndex}].classList.contains('active') === true`)
  if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
    await clickAt(`document.querySelector('.panel-pill:not(.summary-pill)')`)
  }
  await wait(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tabs [role="tab"]') != null`)
  await idle()
  const shown = await readWorkbench(evaluate, layout.children)
  await capture('workbench-restored')
  check(json(shown.childTabs) === json(layout.children),
    `the restored strip must show the same child tabs in the same order: ${json({ shown: shown.childTabs, layout })}`)
  check(shown.toolTabs.includes(layout.tool), `the restored strip lost its tool tab: ${json({ shown, layout })}`)
  check(shown.selectedChild === layout.active,
    `the restored strip must keep the same active child: ${json({ shown, layout })}`)
  return { children: shown.childTabs, tool: shown.toolTabs, selected: shown.selectedChild,
    savedScope: shown.saved?.scope ?? null, openIds: shown.saved?.openIds ?? [] }
}
