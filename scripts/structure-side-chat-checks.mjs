import { readFileSync, rmSync, writeFileSync } from 'node:fs'

/**
 * Side-chat acceptance inside the isolated production App.
 *
 * Every step is a real click on the shipped surface: no mock renderer and no direct IPC
 * call. The IPC counters come from the App's own `ipcMain.handle` registration, so a
 * runaway effect or a second dispatch shows up as a number instead of an opinion.
 */
export async function exerciseSideChatApp({ cdp, evaluate, capture, check, click, idle, pointFor, wait, ipcCountsPath, lostReplyPath }) {
  const currentSurface = '#right-surface-pane [data-session-surface-current="true"]'
  const childComposer = '[data-side-chat-panel] .runtime-composer textarea'
  const mainComposer = '#main-pane .runtime-composer textarea'
  const counts = () => {
    try { return JSON.parse(readFileSync(ipcCountsPath, 'utf8')) } catch { return {} }
  }
  const since = (before) => {
    const now = counts()
    return Object.fromEntries(Object.entries(now).filter(([channel, value]) => value - (before[channel] ?? 0) > 0)
      .map(([channel, value]) => [channel, value - (before[channel] ?? 0)]))
  }
  const mouseClick = async (clickCount, point) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount, ...point })
  }
  /** The history item is the second side-chat menu entry; its position is what a user hits. */
  const clickHistoryItem = async () => {
    const point = await evaluate(`(() => {
      const item = document.querySelectorAll('.surface-menu [role="menuitem"]')[1]
      const rect = item.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    await mouseClick(1, point)
  }
  /** Wait for the chooser notice to say one specific thing; report what it did say. */
  const waitNotice = async (fragment, before) => {
    const current = () => evaluate(`document.querySelector('[data-side-chat-creation-notice]')?.textContent ?? ''`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const text = await current()
      if (text.includes(fragment)) return text
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Side-chat notice never said ${JSON.stringify(fragment)}; it said ${JSON.stringify(await current())}` +
      (before ? ` after ${JSON.stringify(since(before))}` : ''))
  }
  const showPanel = async () => {
    if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
      await click('.panel-pill:not(.summary-pill)')
      await wait(`document.querySelector('.app.right-panel-hidden') == null`)
    }
  }
  const openChooser = async () => {
    await showPanel()
    while (await evaluate(`document.querySelector('${currentSurface} .surface-tab-close') != null`)) {
      await click(`${currentSurface} .surface-tab-close`)
      await idle()
    }
    await wait(`document.querySelector('${currentSurface} [data-surface-chooser] [data-side-chat-entry]') != null`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const state = await evaluate(`(() => {
        const card = document.querySelector('${currentSurface} [data-surface-chooser] [data-side-chat-entry]')
        return { disabled: card.disabled, reason: card.getAttribute('title') ?? '', notice: card.closest('[data-surface-chooser]').querySelector('[data-side-chat-creation-notice]')?.textContent ?? '' }
      })()`)
      if (!state.disabled) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const stuck = await evaluate(`document.querySelector('${currentSurface} [data-surface-chooser] [data-side-chat-entry]')?.getAttribute('title') ?? ''`)
    throw new Error(`Side-chat entry stayed disabled: ${JSON.stringify(stuck)}`)
  }

  await click('button.sb-sess')
  await wait(`document.querySelector('.tool-group-row') != null`)
  await idle()
  await openChooser()
  const beforeCreate = counts()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  await wait(`document.querySelector('${currentSurface} [data-side-chat-tab-id]') != null && document.querySelector('[data-side-chat-panel] .side-chat-surface') != null`)
  await idle()
  const createdDelta = since(beforeCreate)
  check(createdDelta['conversation:createSideChat'] === 1,
    `One click must dispatch exactly one side-chat create: ${JSON.stringify(createdDelta)}`)
  check(await evaluate(`document.querySelectorAll('${currentSurface} [data-side-chat-tab-id]').length === 1`),
    'One click created more than one side-chat tab')
  const childId = await evaluate(`document.querySelector('[data-side-chat-panel] .side-chat-surface').dataset.sideChatId`)
  const workspacePath = await evaluate(`document.querySelector('${currentSurface} [data-side-chat-workspace]')?.dataset.sideChatWorkspace ?? ''`)
  check(await evaluate(`document.activeElement?.matches('${childComposer}') === true`),
    'A new child did not take composer focus')

  await click(mainComposer)
  await cdp.send('Input.insertText', { text: 'main draft kept' })
  await click(childComposer)
  await cdp.send('Input.insertText', { text: 'child draft kept' })
  await wait(`document.querySelector('${childComposer}')?.value.endsWith('child draft kept') === true`)
  await capture('side-chat-child')

  await click(`${currentSurface} .surface-tab-close`)
  await wait(`document.querySelector('${currentSurface} [data-surface-chooser]') != null`)
  check(await evaluate(`document.querySelector('${mainComposer}')?.value.endsWith('main draft kept') === true`),
    'Closing the child tab lost the main draft')
  check(await evaluate(`document.querySelector('#main-pane').getBoundingClientRect().width > 0`),
    'Closing the child tab hid the parent pane')

  await click(`${currentSurface} [aria-label="添加 Surface"]`)
  await wait(`document.querySelector('.surface-menu [role="menuitem"]') != null`)
  await clickHistoryItem()
  await wait(`document.querySelector('[data-side-chat-history] [data-side-chat-history-id="${childId}"]') != null`)
  await capture('side-chat-history')
  await click(`[data-side-chat-history] [data-side-chat-history-id="${childId}"]`)
  await wait(`document.querySelector('[data-side-chat-panel] .side-chat-surface')?.dataset.sideChatId === '${childId}'`)
  check(await evaluate(`document.querySelector('${childComposer}')?.value.endsWith('child draft kept') === true`),
    'Reopened child lost its own draft')
  check(await evaluate(`document.querySelector('${mainComposer}')?.value.endsWith('main draft kept') === true`),
    'Reopening a child overwrote the main draft')

  // Switching tabs is a tab action: focus stays on the tab and no metadata is rewritten.
  const beforeSwitch = counts()
  await click(`${currentSurface} [data-surface-tab="side-chat"] button[role="tab"]`)
  await idle()
  check(await evaluate(`document.activeElement?.getAttribute('role') === 'tab'`),
    'Switching tabs stole composer focus')
  check((since(beforeSwitch)['conversation:listSideChats'] ?? 0) <= 2,
    'Switching one tab rewrote the tab metadata repeatedly')

  // An idle App must stop reading side-chat metadata.
  const beforeIdle = counts()
  await new Promise(resolve => setTimeout(resolve, 1200))
  const idleDelta = since(beforeIdle)
  check(['conversation:listSideChats', 'conversation:previewSideChat', 'conversation:createSideChat']
    .every((channel) => (idleDelta[channel] ?? 0) === 0),
  `An idle App kept reading side-chat metadata: ${JSON.stringify(idleDelta)}`)

  // A rapid double click must not race two children into existence.
  await openChooser()
  const cardPoint = await pointFor(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  const beforeDouble = counts()
  await mouseClick(1, cardPoint)
  await mouseClick(2, cardPoint)
  await idle()
  await wait(`document.querySelector('${currentSurface} [data-side-chat-tab-id]') != null`)
  const doubleDelta = since(beforeDouble)
  check(doubleDelta['conversation:createSideChat'] === 1,
    `A double click dispatched more than one create: ${JSON.stringify(doubleDelta)}`)
  check(await evaluate(`document.querySelectorAll('${currentSurface} [data-side-chat-tab-id]').length === 1`),
    'A double click created two children')
  await capture('side-chat-double-click')

  // A second parent keeps its own tab layout: the open child above is not shown there.
  const keptChild = await evaluate(`document.querySelector('${currentSurface} [data-side-chat-tab-id]').dataset.sideChatTabId`)
  check(typeof keptChild === 'string' && keptChild.length > 0, 'The double click did not open its own child')
  await click('.sb-new')
  await idle()
  check(await evaluate(`document.querySelectorAll('${currentSurface} [data-side-chat-tab-id]').length === 0`),
    'Side-chat tabs leaked into another parent session')
  await showPanel()
  await click(mainComposer)
  await cdp.send('Input.insertText', { text: 'second parent turn' })
  await wait(`document.querySelector('.send')?.disabled === false`)
  await click('.send')
  await wait(`document.querySelector('.tool-group-row') != null && document.querySelector('.stop') == null`)
  await idle()
  await openChooser()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  await wait(`document.querySelector('${currentSurface} [data-side-chat-tab-id]') != null`)
  const secondChild = await evaluate(`document.querySelector('[data-side-chat-panel] .side-chat-surface').dataset.sideChatId`)
  check(secondChild !== childId, 'The second parent reused the first parent child id')
  await capture('side-chat-second-parent')

  // A reply lost after the host committed is recovered by reading the same command back.
  await openChooser()
  writeFileSync(lostReplyPath, 'after-commit')
  const beforeLost = counts()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  // A recovered child opens as a tab, so the chooser notice is gone by design: the tab,
  // the read-back and the cleared ledger are the evidence.
  await wait(`document.querySelectorAll('${currentSurface} [data-side-chat-tab-id]').length === 1`)
  const recovered = since(beforeLost)
  check(recovered['conversation:createSideChat'] === 1, `A lost reply dispatched more than one create: ${JSON.stringify(recovered)}`)
  check((recovered['conversation:findSideChatCommand'] ?? 0) >= 1, 'A lost reply was not read back')
  check(await evaluate(`JSON.parse(localStorage.getItem('scry.side-chat-create-commands.v1') ?? '[]').length === 0`),
    'A recovered create command stayed in the durable ledger')
  await capture('side-chat-recovered')

  // A full ledger refuses the next creation before it dispatches anything.
  const otherScopeRow = (index) => ({
    commandId: `structure-ledger-row-${index}`, scopeKey: 'other-scope',
    source: { kind: 'conversation', conversationId: 'structure-ledger-parent' },
    expectedThroughOrdinal: 1, expectedThroughRunId: 'structure-run',
    expectedPrefixFingerprint: 'a'.repeat(64), expectedManifestFingerprint: 'b'.repeat(64), createdAt: 1
  })
  await openChooser()
  await evaluate(`localStorage.setItem('scry.side-chat-create-commands.v1', ${JSON.stringify(JSON.stringify(
    Array.from({ length: 8 }, (_, index) => otherScopeRow(index))))})`)
  const beforeFull = counts()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  await waitNotice('先核对它们')
  const refused = since(beforeFull)
  check((refused['conversation:createSideChat'] ?? 0) === 0, `A full ledger still dispatched a create: ${JSON.stringify(refused)}`)
  check((refused['conversation:listSideChats'] ?? 0) === 0, 'A full ledger read children before refusing')
  await capture('side-chat-ledger-full')

  // A reply lost before the host created anything stays unknown, and the next attempt is
  // a read-only check that never dispatches a second create.
  await evaluate(`localStorage.removeItem('scry.side-chat-create-commands.v1')`)
  await openChooser()
  writeFileSync(lostReplyPath, 'before-commit')
  const beforeUnknown = counts()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  await waitNotice('创建结果尚未确认')
  const unknown = since(beforeUnknown)
  check(unknown['conversation:createSideChat'] === 1, `An unconfirmed create replied more than once: ${JSON.stringify(unknown)}`)
  check(await evaluate(`JSON.parse(localStorage.getItem('scry.side-chat-create-commands.v1') ?? '[]').length === 1`),
    'An unconfirmed create discarded the durable command')
  check(await evaluate(`document.querySelectorAll('${currentSurface} [data-side-chat-tab-id]').length === 0`),
    'An unconfirmed create opened a tab')
  await capture('side-chat-unconfirmed')
  const beforeCheck = counts()
  await click(`${currentSurface} [data-surface-chooser] [data-side-chat-entry]`)
  await waitNotice('这不代表没有创建')
  const checked = since(beforeCheck)
  check((checked['conversation:findSideChatCommand'] ?? 0) >= 1, `The unconfirmed command was not read back: ${JSON.stringify(checked)}`)
  check((checked['conversation:createSideChat'] ?? 0) === 0, `The unconfirmed command was dispatched again: ${JSON.stringify(checked)}`)
  await evaluate(`localStorage.removeItem('scry.side-chat-create-commands.v1')`)
  rmSync(lostReplyPath, { force: true })

  return { oneClickOneChild: true, childDraftKept: true, mainDraftKept: true, historyReopen: true,
    tabSwitchKeepsFocus: true, idleIpcBounded: true, doubleClickOneChild: true, parentsIsolated: true,
    closeKeptParentPane: true, lostReplyRecovered: true, unconfirmedRecoveryChecked: true, ledgerFullRefused: true, createdDelta, idleDelta }
}
