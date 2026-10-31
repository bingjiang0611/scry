import { json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * What a source-less child can still prove about its frozen body and its own controls.
 *
 * This runs after the source parent was really deleted, on the child opened as the main
 * view. Every page comes from the child's sealed artifact, so a page that renders after
 * the delete is evidence the body is child-owned rather than a leftover source read. The
 * prefix is long in messages and short in bytes, so it spans real viewer pages without
 * weakening the single-message handoff budget, which is proven separately at the body API.
 */
export async function exerciseSideChatOrphanReader({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  rendererFailures = [], orphanChild, hostAgent, draft, expectedMessages }) {
  const { driver, capture, click, clickAt, idle, wait, counts, since } = sideChatDriver({ cdp, evaluate, check,
    ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat orphan reader' })
  const readCounts = () => counts()

  // The frozen body is read from the child's own sealed artifact, paged, after the source is gone.
  const beforeRead = readCounts()
  await clickAt(`[...document.querySelectorAll('#main-pane [data-side-chat-variant="main"] .side-chat-surface-actions button')].find(node => node.textContent.includes('查看来源快照'))`)
  await wait(`document.querySelector('[data-side-chat-snapshot]') != null`, 20000)
  await wait(`document.querySelectorAll('[data-side-chat-snapshot] li[data-snapshot-role]').length > 0`, 20000)
  await idle()
  const page = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-side-chat-snapshot] li[data-snapshot-role]')]
    const button = label => [...document.querySelectorAll('[data-side-chat-snapshot] button')].find(node => node.textContent.trim() === label)
    return { rows: rows.length, state: document.querySelector('[data-side-chat-snapshot] [data-snapshot-state]')?.dataset.snapshotState ?? null,
      cursor: document.querySelector('[data-side-chat-snapshot]')?.dataset.sideChatSnapshotCursor ?? null,
      older: button('上一页')?.disabled, newer: button('下一页')?.disabled,
      text: rows.map(node => node.textContent).join(String.fromCharCode(10)) }
  })()`)
  const reads = since(beforeRead)
  // The whole frozen prefix is inline (a readerless Provider cannot freeze more), so the
  // reader must show every frozen message on one page and offer no page it cannot produce.
  check(page.rows === expectedMessages, `the reader must show every frozen message: ${json({ page, expectedMessages })}`)
  check(page.rows <= 40, `the reader rendered more than one bounded page: ${json({ page })}`)
  check(page.state === 'complete', `a fully inline body must report a complete page: ${json({ page })}`)
  check(page.older === true && page.newer === true, `a single page must not offer paging: ${json({ page })}`)
  check(page.text.includes('冻结正文'), `the frozen page lost its text: ${json(page.text.slice(0, 200))}`)
  check(!page.text.includes('\uFFFD'), 'the frozen body lost a character')
  check(page.text.includes('🀄️'), 'the frozen body lost its astral-plane emoji')
  check((reads['conversation:readSideChatSnapshot'] ?? 0) === 1,
    `one page must cost one artifact read: ${json(reads)}`)
  check((reads['conversation:read'] ?? 0) === 0, `the viewer read the source conversation: ${json(reads)}`)
  await capture('orphan-snapshot-page')
  // Escape closes the modal and returns focus to the action that opened it.
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(`document.querySelector('[data-side-chat-snapshot]') == null`, 10000)
  const afterEscape = await evaluate(`(() => ({
    open: document.querySelector('[data-side-chat-snapshot]') != null,
    focused: document.activeElement?.textContent?.trim() ?? null,
    draft: document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null
  }))()`)
  check(afterEscape.open === false, 'Escape did not close the snapshot reader')
  check(afterEscape.focused != null && afterEscape.focused.includes('查看来源快照'),
    `focus did not return to the snapshot action: ${json(afterEscape)}`)
  check(afterEscape.draft === draft, `the child draft was lost after reading its source: ${json(afterEscape)}`)

  // The child's own runtime control is a child-owned preference, not the host's selection:
  // changing it here must not leak into another conversation, and it comes back with the
  // child after the view is left and reopened.
  const menuOpen = `document.querySelector('.climenu [data-agent-id]') != null`
  const pickOwnAgent = async () => {
    // Opening the Agent picker starts a catalog refresh. The already-closed model
    // picker must not dismiss it when that refresh enters its loading state.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved',
      ...await driver.pointFor('#main-pane .runtime-composer .clibtn') })
    await click('#main-pane .runtime-composer .clibtn')
    await wait(menuOpen, 10000)
    const options = await evaluate(`[...document.querySelectorAll('.climenu [data-agent-id]')]
      .map(node => node.dataset.agentId).filter(id => id != null && id !== ${json(hostAgent)})`)
    check(options.length > 0, 'Agent menu has no alternative provider')
    const target = options[0]
    await clickAt(`document.querySelector('.climenu [data-agent-id=' + ${json(JSON.stringify(target))} + ']')`)
    await wait(`document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId === ${json(target)}`)
    return target
  }
  const ownAgent = await pickOwnAgent()
  const chipAgent = await evaluate(`document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null`)
  check(ownAgent != null, `the child could not select an agent of its own: ${json({ hostAgent, chipAgent })}`)
  await idle()
  // The child really owns the main pane composer while it is shown as the main variant.
  const childComposer = await evaluate(
    `document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null`)
  check(childComposer === draft, `the child draft is not in its own main composer: ${json({ childComposer, draft })}`)
  await clickAt(`[...document.querySelectorAll('[data-orphan-side-chat-id]')].find(node => node.dataset.orphanSideChatId === ${json(orphanChild)})`)
  await wait(`document.querySelector('#main-pane [data-side-chat-variant="main"]')?.dataset.sideChatId === ${json(orphanChild)}`, 20000)
  await idle()
  const reopenedChild = await evaluate(`(() => ({
    provider: document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null,
    draft: document.querySelector('#main-pane .runtime-composer textarea')?.value ?? null
  }))()`)
  check(reopenedChild.provider === ownAgent, `the child lost its own saved provider: ${json({ reopenedChild, ownAgent })}`)
  check(reopenedChild.draft === draft, `the child lost its own draft: ${json(reopenedChild)}`)
  return {
    childId: orphanChild, snapshot: { rows: page.rows, expectedMessages, state: page.state,
      olderDisabled: page.older, newerDisabled: page.newer,
      reads: reads['conversation:readSideChatSnapshot'] ?? 0, afterEscape },
    hostAgent, ownAgent, reopenedChild
  }
}
