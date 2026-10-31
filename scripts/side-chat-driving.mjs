import { readFileSync } from 'node:fs'
import { createAppDriver } from './app-driving.mjs'
import { sideChatRequestsPath } from './smoke-app-entries.mjs'

/**
 * Shared real-interaction helpers for the side-chat App acceptance.
 *
 * Everything here drives the shipped surface with real pointer events and reads its own
 * evidence back: the fixture's input log (what the Provider really received), the App's
 * IPC counters, and the conversation records the App itself can read.
 */
export const json = JSON.stringify

export function readJsonLines(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

export const SIDE_CHAT_SURFACE = '#right-surface-pane [data-session-surface-current="true"]'
/**
 * The child body the workbench really has on screen.
 *
 * Every open child tab keeps its own panel section; only the active one holds a body. A
 * selector on the bare attribute would read a hidden section and prove nothing.
 */
export const CHILD_PANEL = `${SIDE_CHAT_SURFACE} [data-side-chat-panel]:not([hidden])`
export const CHILD_COMPOSER = `${CHILD_PANEL} .runtime-composer textarea`
export const MAIN_COMPOSER = '#main-pane .runtime-composer textarea'

export function sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures = [], label = 'Side-chat App' }) {
  const driver = createAppDriver({ cdp, evaluate, label })
  const { capture, click, clickAt, idle, keyStroke, wait } = driver
  const counts = () => {
    try { return JSON.parse(readFileSync(ipcCountsPath, 'utf8')) } catch { return {} }
  }
  const since = (before) => {
    const now = counts()
    return Object.fromEntries(Object.entries(now).filter(([channel, value]) => value - (before[channel] ?? 0) > 0)
      .map(([channel, value]) => [channel, value - (before[channel] ?? 0)]))
  }
  const inputs = () => readJsonLines(inputsPath)
  /** Every side-chat list request main really received, in dispatch order. */
  const sideChatRequests = () => readJsonLines(sideChatRequestsPath(ipcCountsPath))
  const conversation = id => evaluate(`window.scry.conversations.read(${JSON.stringify(id)})`)
  const type = async (selector, text) => {
    await click(selector)
    await cdp.send('Input.insertText', { text })
    await wait(`document.querySelector(${json(selector)})?.value.includes(${json(text)}) === true`)
  }
  const clearDraft = async (selector = CHILD_COMPOSER) => {
    await click(selector)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4, commands: ['SelectAll'] })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 })
    await keyStroke({ key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await wait(`document.querySelector(${json(selector)})?.value === ''`)
  }
  const surfaceOf = (selector = CHILD_COMPOSER) => selector.startsWith(CHILD_PANEL) ? CHILD_PANEL : '#main-pane'
  const send = async (selector, text) => {
    await type(selector, text)
    const scope = surfaceOf(selector)
    await wait(`document.querySelector('${scope} .send')?.disabled === false`)
    const before = inputs().length
    await click(`${scope} .send`)
    await wait(`document.querySelector(${json(selector)})?.value === ''`).catch(async (error) => {
      await capture('send-did-not-clear')
      const state = await evaluate(`(() => { const area = document.querySelector(${json(selector)});
        return { value: area?.value ?? null, send: document.querySelector('${scope} .send')?.outerHTML ?? null } })()`)
      throw new Error(`${error.message}: ${json({ state, fixtureRuns: inputs().length - before, rendererFailures })}`)
    })
  }
  const showPanel = async () => {
    if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
      await click('.panel-pill:not(.summary-pill)')
      await wait(`document.querySelector('.app.right-panel-hidden') == null`)
    }
  }
  const openChooser = async () => {
    await showPanel()
    while (await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} .surface-tab-close') != null`)) {
      await click(`${SIDE_CHAT_SURFACE} .surface-tab-close`)
      await idle()
    }
    await wait(`document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]') != null`)
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]').disabled === false`)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Side-chat entry stayed disabled: ' +
      await evaluate(`document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]')?.getAttribute('title') ?? ''`))
  }
  /** One click on the chooser entry must dispatch exactly one create. */
  const createChild = async () => {
    await openChooser()
    const before = counts()
    await click(`${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]`)
    await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface') != null`)
    await idle()
    check(since(before)['conversation:createSideChat'] === 1,
      `one click must dispatch one create: ${json(since(before))}`)
    return evaluate(`document.querySelector('${CHILD_PANEL} .side-chat-surface').dataset.sideChatId`)
  }
  /**
   * Choose a Provider the way a user does: hover the chip, open the menu, then click the
   * entry. The hover menu closes itself when the pointer leaves it, so a closed menu is
   * reopened instead of clicking a node that is already gone.
   */
  const selectProvider = async (agentId, scope = CHILD_PANEL) => {
    const chip = `${scope} .runtime-composer .clibtn`
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await wait(`document.querySelector('${chip}')?.disabled === false`)
      const pressed = await evaluate(`document.querySelector('${chip}')?.getAttribute('aria-expanded') === 'true'`)
      if (!pressed) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await driver.pointFor(chip) })
        await click(chip)
        await wait(`document.querySelector('${chip}')?.getAttribute('aria-expanded') === 'true'`, 5000).catch(() => undefined)
      }
      const item = `.climenu [data-agent-id=${json(agentId)}]`
      try {
        const point = await driver.pointerAt(`document.querySelector('${item}')`)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
      } catch {
        // The hover menu closed before the pointer reached the entry: reopen it.
        continue
      }
      const chosen = await wait(`document.querySelector('${chip}')?.dataset.agentId === ${json(agentId)}`, 5000).then(() => true).catch(() => false)
      if (chosen) return
    }
    await capture(`provider-choice-${agentId.replace(/[^a-z0-9]/gi, '-')}`)
    throw new Error(`could not choose ${agentId}: ${json(await evaluate(`(() => ({ chip: document.querySelector('${chip}')?.dataset.agentId ?? null,
      expanded: document.querySelector('${chip}')?.getAttribute('aria-expanded') ?? null,
      menus: [...document.querySelectorAll('.climenu [data-agent-id]')].map(node => node.dataset.agentId) }))()`))}`)
  }
  /** A conversation settles one turn per accepted send; nothing else may appear. */
  const waitSettled = async (id, total, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const page = await conversation(id)
      const last = page.turns.at(-1)
      if (page.turns.length === total && !page.summary.activeRunId && last && (last.delivery.status === 'accepted' || last.delivery.status === 'not_sent')) return page
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const page = await conversation(id)
    throw new Error(`child ${id} never settled ${total} turns: ${json(page.turns.map(turn => [turn.ordinal, turn.delivery.status]))}`)
  }
  /**
   * Stop the run of one surface. A stop that has not settled yet keeps the button
   * clickable, so a second real click is allowed; the loop is bounded and still fails.
   */
  const stopRun = async (scope) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stop = `${scope} .runtime-composer .run-status-stop`
      if (await evaluate(`document.querySelector('${stop}') == null`)) return attempt
      await click(stop)
      const cleared = await wait(`document.querySelector('${scope} .runtime-composer .run-status') == null`, 12000)
        .then(() => true).catch(() => false)
      if (cleared) return attempt + 1
    }
    throw new Error(`${scope} did not stop: ${json(await evaluate(`(() => ({
      status: document.querySelector('${scope} .runtime-composer .run-status')?.textContent ?? null,
      disabled: document.querySelector('${scope} .runtime-composer .run-status-stop')?.disabled ?? null }))()`))}`)
  }
  /**
   * Grow a real transcript through the shipped send IPC.
   *
   * The composer click path is proven elsewhere; what these blocks need is a genuine
   * 130-turn record and a long Unicode body, so they use the same preview+send calls the
   * composer builds, one bounded chunk per evaluation, and wait for each turn to settle.
   */
  const seedTurns = async (conversationId, prompts, chunk = 10) => {
    let total = 0
    for (let start = 0; start < prompts.length; start += chunk) {
      total = await evaluate(`(async () => {
        const id = ${json(conversationId)}
        const target = { providerId: 'codex' }
        for (const prompt of ${json(prompts.slice(start, start + chunk))}) {
          // A page holds at most 40 turns, so the conversation's own count is the progress
          // signal; comparing page lengths would wait forever after the first page.
          const before = (await window.scry.conversations.read(id)).summary.turnCount
          const preview = await window.scry.conversations.preview(id, target)
          if (preview.continuation.kind === 'blocked') throw new Error('seed blocked: ' + preview.continuation.reason)
          await window.scry.conversations.send({ ...target, conversationId: id,
            expectedRevision: preview.revision, expectedContinuationKey: preview.target.continuationKey,
            commandId: crypto.randomUUID(), prompt, selectedItems: preview.missingItems.map(item => item.ref), confirmFresh: true })
          let settled = false
          for (let attempt = 0; attempt < 300; attempt += 1) {
            const summary = (await window.scry.conversations.read(id)).summary
            if (summary.turnCount > before && summary.activeRunId == null) { settled = true; break }
            await new Promise(resolve => setTimeout(resolve, 40))
          }
          if (!settled) throw new Error('seed turn never settled: ' + prompt.slice(0, 40))
        }
        return (await window.scry.conversations.read(id)).summary.turnCount
      })()`)
    }
    return total
  }
  /**
   * Wait for one fixture run the App really dispatched. A stop must land after this: stopping
   * before dispatch is a different outcome and would make a phase a timing race.
   */
  const awaitFixtureRun = async (prompt) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (inputs().some(entry => entry.prompt === prompt)) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`the fixture never received "${prompt}": ${json(inputs().map(entry => entry.prompt).slice(-4))}`)
  }
  /** One child of one source, created through the shipped IPC the chooser also calls. */
  const createChildOf = async (source, commandId) => evaluate(`(async () => {
    const preview = await window.scry.conversations.previewSideChat(${json(source)}, {})
    const created = await window.scry.conversations.createSideChat({
      source: ${json(source)}, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: ${json(commandId)}, initialTarget: preview.target })
    return created.id
  })()`)
  /**
   * Show one child by its own id: the tab strip if it is still there, otherwise the
   * history dialog, which is the shipped way back to any child of this parent.
   */
  const openChildById = async (id) => {
    const tab = `[data-side-chat-tab-id="${id}"]`
    if (await evaluate(`document.querySelector(${json(tab)}) != null`)) await click(`${tab} [role="tab"]`)
    else await openChildFromHistory(id)
    await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(id)}`, 30000)
    await idle()
  }
  /**
   * The shipped way back to any child of this parent, with no warm-tab short circuit: a
   * retained tab must never be the only reason a child is reachable.
   *
   * Both shipped entry points carry the same action: the `+` menu while tabs are open and
   * the chooser footer while none is. Neither closes a tab, so the evidence never destroys
   * the layout a later restart has to restore.
   */
  const openChildFromHistory = async (id) => {
    const chooserShown = await evaluate(
      `document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]') != null`)
    const historyAction = chooserShown
      ? `[...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-chooser-footer button')]
        .find(node => node.textContent.trim() === '历史侧边会话')`
      : `[...document.querySelectorAll('#right-surface-pane .surface-menu [role="menuitem"]')]
        .find(node => node.textContent.trim() === '历史侧边会话')`
    // The chooser card states the scope this panel would create in; its own text is the
    // only honest proof of what the history action will ask the host for.
    const chooser = await evaluate(`(() => { const entry = document.querySelector('${SIDE_CHAT_SURFACE} [data-surface-chooser] [data-side-chat-entry]')
      return entry ? { text: entry.textContent, title: entry.getAttribute('title'), disabled: entry.disabled } : null })()`)
    if (!chooserShown) {
      await click(`${SIDE_CHAT_SURFACE} button[aria-label="添加 Surface"]`)
      await wait(`document.querySelector('#right-surface-pane .surface-menu') != null`, 5000)
    }
    // The action stays disabled while the chooser loads; a click on it would be
    // a silent no-op, so the real enabled state is the precondition.
    await wait(`${historyAction}?.disabled === false`, 20000)
    await clickAt(historyAction)
    // The dialog root is the real signal: its total and rows both load asynchronously,
    // and an empty scope shows neither.
    await wait(`document.querySelector('.side-chat-history-modal') != null`, 20000).catch(async () => {
      throw new Error(`the side-chat history dialog did not open: ${json({ chooser, state: await evaluate(`(() => ({
        panel: document.querySelector('${CHILD_PANEL}') != null,
        footer: [...document.querySelectorAll('${SIDE_CHAT_SURFACE} .surface-chooser-footer button')].map(node => node.textContent.trim()),
        tabs: [...document.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
        dialogs: document.querySelectorAll('.modal, .side-chat-history-modal').length }))()`) })}`)
    })
    // The dialog's total and rows both load asynchronously and an empty scope shows
    // neither, so the failure names the identity the App really asked for.
    await wait(`document.querySelectorAll('[data-side-chat-history-id]').length > 0`, 20000).catch(async () => {
      const evidence = await evaluate(`(async () => {
        const active = document.querySelector('.sb-sess.active')
        const child = await window.scry.conversations.read(${json(id)}).then(page => page.sideChat?.source ?? null, () => null)
        const parent = active?.dataset.conversationId
          ? await window.scry.conversations.read(active.dataset.conversationId).then(page => ({ id: page.summary.id,
            bindings: page.bindings.map(binding => ({ providerId: binding.providerId,
              agentProfileId: binding.agentProfileId ?? null, nativeSessionId: binding.nativeSessionId ?? null })) }),
            error => ({ error: String(error) }))
          : null
        return { row: { conversationId: active?.dataset.conversationId ?? null,
          provider: active?.dataset.provider ?? null,
          count: active?.querySelector('[data-side-chat-count]')?.dataset.sideChatCount ?? null,
          text: active?.textContent?.slice(0, 60) ?? null }, child, parent }
      })()`)
      throw new Error(`the history dialog listed no side chat: ${json({ ...evidence, chooser,
        dialog: await evaluate(`document.querySelector('.side-chat-history-modal')?.textContent?.slice(0, 240) ?? null`),
        requests: sideChatRequests().slice(-4) })}`)
    })
    for (let page = 0; page < 12; page += 1) {
      if (await evaluate(`[...document.querySelectorAll('[data-side-chat-history-id]')].some(node => node.dataset.sideChatHistoryId === ${json(id)})`)) break
      await clickAt(`[...document.querySelectorAll('.side-chat-history-footer button')].find(node => node.textContent.trim() === '更早的侧边会话')`)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    await clickAt(`[...document.querySelectorAll('[data-side-chat-history-id]')].find(node => node.dataset.sideChatHistoryId === ${json(id)})`)
  }
  return {
    driver, capture, click, clickAt, idle, keyStroke, wait, counts, since, inputs, conversation, stopRun, sideChatRequests,
    type, clearDraft, send, showPanel, openChooser, createChild, selectProvider, waitSettled, seedTurns,
    createChildOf, openChildById, openChildFromHistory, awaitFixtureRun
  }
}
