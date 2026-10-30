import { CHILD_COMPOSER, CHILD_PANEL, json, sideChatDriver } from './side-chat-driving.mjs'

/** The row a user selects to go back to the parent: the one that owns the side-chat count. */
const PARENT_ROW = `[...document.querySelectorAll('.sb-sess')].filter(node =>
  node.textContent.includes('side chat parent turn') && node.querySelector('[data-side-chat-count]') != null)`

/**
 * A user-driven Provider switch of the parent, with the child still open and running.
 *
 * The parent is only ever adopted by an explicit user action (choosing another Agent in the
 * parent composer), never by a side chat. The child's own frozen source, its tabs and its
 * run must survive, the child must stay reachable from the new conversation scope, and the
 * window may hold at most one child body and one child subscription next to the main one.
 */
export async function exerciseSideChatAdoption({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
  runChildId, rendererFailures = [] }) {
  const { capture, click, clickAt, counts, idle, inputs, wait, conversation, selectProvider, stopRun,
    showPanel, awaitFixtureRun } = sideChatDriver({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath,
    rendererFailures, label: 'Side-chat adoption' })
  // The child this step runs is the one with no draft of its own: the draft and receipt
  // children keep exactly the state their own assertions proved, untouched by this step.
  await showPanel()
  const childTab = `[data-side-chat-tab-id="${runChildId}"]`
  if (await evaluate(`document.querySelector('${childTab}') != null`)) await click(`${childTab} [role="tab"]`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId === ${json(runChildId)}`, 20000)
  await idle()
  const child = await conversation(runChildId)
  const source = child.sideChat?.source
  check(source?.kind === 'native-session', `the child has no native frozen source to adopt: ${json(source)}`)
  const parentNativeSession = source.nativeSessionId

  // A child run under another Provider: the parent's own Provider must stay idle, otherwise
  // the host would (correctly) refuse to adopt a session that is still executing.
  await selectProvider('claude')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .clibtn')?.dataset.agentId === 'claude'`)
  await click(CHILD_COMPOSER)
  await cdp.send('Input.insertText', { text: 'side chat hold adoption' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value.includes('adoption') === true`)
  await click(`${CHILD_PANEL} .send`)
  await awaitFixtureRun('side chat hold adoption')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`, 20000)
  const childTurnsBefore = (await conversation(runChildId)).turns.length
  const before = await evaluate(`(() => {
    const pane = document.querySelector('#right-surface-pane')
    return { tabs: [...pane.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
      active: [...pane.querySelectorAll('[data-side-chat-tab-id]')]
        .find(node => node.querySelector('[role="tab"][aria-selected="true"]'))?.dataset.sideChatTabId ?? null,
      surface: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null,
      bodies: document.querySelectorAll('[data-side-chat-id]').length,
      composers: document.querySelectorAll('${CHILD_PANEL} .runtime-composer').length,
      sidebarCount: ${PARENT_ROW}[0]?.querySelector('[data-side-chat-count]')?.dataset.sideChatCount ?? null }
  })()`)
  const runBefore = (await conversation(runChildId)).summary.activeRunId ?? null
  check(runBefore != null, `the child run never became active before the switch: ${json(before)}`)

  // The explicit user action: choose another Agent in the parent composer. Adoption and the
  // move of the workbench scope are the App's own behaviour, not something this test calls.
  const switchCounts = counts()
  await selectProvider('claude', '#main-pane')
  const adopted = await evaluate(`(async () => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const row = document.querySelector('.sb-sess.active')
      const conversationId = row?.dataset.conversationId ?? null
      if (conversationId) {
        const page = await window.scry.conversations.read(conversationId).then(page => ({ id: page.summary.id,
          cwd: page.summary.cwd, turnCount: page.summary.turnCount,
          bindings: page.bindings.map(binding => ({ providerId: binding.providerId,
            nativeSessionId: binding.nativeSessionId ?? null })) }), () => null)
        if (page) return { conversationId, page }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return { conversationId: null, page: null }
  })()`)
  check(adopted.page != null, `the parent was never adopted into a conversation: ${json(adopted)}`)
  const binding = adopted.page.bindings.find(candidate => candidate.nativeSessionId === parentNativeSession)
  check(binding?.providerId === source.providerId,
    `the adopted conversation must bind the parent's own native session: ${json({ adopted, parentNativeSession, source })}`)
  await idle()
  const after = await evaluate(`(() => {
    const pane = document.querySelector('#right-surface-pane')
    return { tabs: [...pane.querySelectorAll('[data-side-chat-tab-id]')].map(node => node.dataset.sideChatTabId),
      active: [...pane.querySelectorAll('[data-side-chat-tab-id]')]
        .find(node => node.querySelector('[role="tab"][aria-selected="true"]'))?.dataset.sideChatTabId ?? null,
      surface: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null,
      running: document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null,
      bodies: document.querySelectorAll('[data-side-chat-id]').length,
      composers: document.querySelectorAll('${CHILD_PANEL} .runtime-composer').length,
      sidebarCount: ${PARENT_ROW}[0]?.querySelector('[data-side-chat-count]')?.dataset.sideChatCount ?? null,
      provider: document.querySelector('#main-pane .runtime-composer .clibtn')?.dataset.agentId ?? null,
      mainView: document.querySelector('.sb-sess.active')?.dataset.conversationId ?? null }
  })()`)
  const delta = (() => {
    const now = counts()
    return Object.fromEntries(Object.entries(now).filter(([channel, value]) => value - (switchCounts[channel] ?? 0) > 0)
      .map(([channel, value]) => [channel, value - (switchCounts[channel] ?? 0)]))
  })()
  const childAfter = await conversation(runChildId)
  await capture('adoption-switched')
  check(after.provider === 'claude', `the parent did not switch its Agent: ${json(after)}`)
  check(after.mainView === adopted.conversationId,
    `the parent did not become the conversation it was adopted into: ${json({ after, adopted: adopted.conversationId })}`)
  check(after.active === runChildId, `the active child tab must survive the switch: ${json({ before, after, runChildId })}`)
  check(json(after.tabs) === json(before.tabs) && after.active === before.active,
    `the switch changed the child tabs or the active tab: ${json({ before, after })}`)
  check(after.surface === runChildId && after.running,
    `the running child must stay visible across the switch: ${json({ before, after })}`)
  check(after.bodies === 1 && after.composers === 1 && before.bodies === 1,
    `the switch mounted a duplicate child body: ${json({ before, after })}`)
  check((delta['runTraces:subscribe'] ?? 0) <= 2 && (delta['runTraces:unsubscribe'] ?? 0) <= 2,
    `the switch must keep at most the main and one child subscription: ${json(delta)}`)
  check(childAfter.summary.id === runChildId && json(childAfter.sideChat?.source) === json(source) &&
    childAfter.turns.length === childTurnsBefore,
    `the switch rewrote the child's own record or sent into it: ${json({ runChildId, before: childTurnsBefore,
      after: childAfter.turns.length, source: childAfter.sideChat?.source })}`)
  check(childAfter.summary.activeRunId === runBefore,
    `the switch replaced the child's run: ${json({ runBefore, after: childAfter.summary.activeRunId ?? null })}`)
  check(inputs().filter((entry) => entry.prompt === 'side chat hold adoption').length === 1,
    `the switch dispatched the child prompt again: ${json(inputs().map((entry) => entry.prompt).slice(-3))}`)

  // The same child must be reachable from the conversation the user switched to: the scope
  // the workbench now asks for is the conversation, and the host must answer with the child
  // frozen from the native session that conversation now binds.
  const listed = await evaluate(`window.scry.conversations.listSideChats({ source: { kind: 'conversation',
    conversationId: ${json(adopted.conversationId)} }, ids: [${json(runChildId)}] })
    .then(list => ({ total: list.total, ids: list.items.map(item => item.id) }), error => ({ error: String(error) }))`)
  check(listed.ids?.includes(runChildId) === true,
    `the adopted scope does not own the child frozen before it: ${json({ listed, adopted: adopted.conversationId,
      parentNativeSession }) }`)
  // …and the shipped history action in that scope lists the same child, by a real click.
  await click(`#right-surface-pane [data-session-surface-current="true"] button[aria-label="添加 Surface"]`)
  await wait(`document.querySelector('#right-surface-pane .surface-menu') != null`, 5000)
  await clickAt(`[...document.querySelectorAll('#right-surface-pane .surface-menu [role="menuitem"]')]
    .find(node => node.textContent.trim() === '历史侧边会话')`)
  await wait(`document.querySelectorAll('[data-side-chat-history-id]').length > 0`, 20000).catch(async () => {
    throw new Error(`the adopted scope listed no side chat: ${json({ listed, rows: await evaluate(
      `document.querySelector('.side-chat-history-modal')?.textContent?.slice(0, 120) ?? null`) })}`)
  })
  const dialogIds = await evaluate(`[...document.querySelectorAll('[data-side-chat-history-id]')]
    .map(node => node.dataset.sideChatHistoryId)`)
  check(dialogIds.includes(runChildId),
    `the adopted scope's history does not list the child: ${json({ dialogIds, runChildId })}`)
  await capture('adoption-history')
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await wait(`document.querySelector('.side-chat-history-modal') == null`, 5000)
  await idle()
  const stopped = await stopRun(CHILD_PANEL)
  await idle()
  return { parentConversationId: adopted.conversationId, binding, parentNativeSession, childId: runChildId,
    tabs: after.tabs, active: after.active, runId: runBefore, childTurns: childAfter.turns.length,
    bodies: after.bodies, subscriptions: delta, listed: { total: listed.total },
    historyRows: dialogIds.length, stopAttempts: stopped, mainView: after.mainView }
}
