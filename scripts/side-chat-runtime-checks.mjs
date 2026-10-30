import { CHILD_COMPOSER, CHILD_PANEL, MAIN_COMPOSER, json, sideChatDriver } from './side-chat-driving.mjs'

/**
 * Side-chat runtime independence in the isolated production App.
 *
 * The two surfaces share a window, not a runtime: a side chat keeps its own run while the
 * parent streams, an approval belongs to the run that asked for it, and stopping one side
 * never stops the other. Attention is proven from the tab/sidebar status the App derives
 * from real run state, not from an optimistic marker.
 */
export async function exerciseSideChatRuntime({ cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, childId, rendererFailures = [] }) {
  const {
    capture, click, clickAt, idle, send, stopRun, wait, conversation, inputs, selectProvider, createChild, showPanel,
    counts, since, openChildById, awaitFixtureRun
  } = sideChatDriver({
    cdp, evaluate, check, ipcCountsPath, inputsPath, callsPath, rendererFailures, label: 'Side-chat runtime'
  })
  const childTab = `[data-side-chat-tab-id="${childId}"]`
  const activeChildRun = () => evaluate(`window.scry.conversations.read(${json(childId)}).then(page => page.summary.activeRunId ?? null)`)
  const mainBusy = () => evaluate(`document.querySelector('#main-pane .runtime-composer .run-status') != null`)
  const childBusy = () => evaluate(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`)
  const tabStatus = () => evaluate(`document.querySelector('${childTab} [data-side-chat-tab-status]')?.textContent ?? null`)
  const stopChild = () => stopRun(CHILD_PANEL)
  const stopMain = () => stopRun('#main-pane')
  const awaitDispatched = awaitFixtureRun
  /** Two equal reads prove a child turn settled: the page lags a newly dispatched run. */
  const settleTurn = async (prompt) => {
    let previous = null
    const deadline = Date.now() + 45000
    while (Date.now() < deadline) {
      const page = await conversation(childId)
      const last = page.turns.at(-1)
      const settled = last?.history?.userText === prompt && last.delivery.outcome != null && page.summary.activeRunId == null
        && !(await childBusy())
      const state = settled ? `${last.ordinal}:${last.delivery.outcome}:${page.summary.revision}` : null
      if (state && state === previous) return page
      previous = state
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    const page = await conversation(childId)
    await capture(`turn-not-settled-${prompt.replace(/[^a-z0-9]+/gi, '-')}`)
    throw new Error(`the child never settled "${prompt}": ${json({ activeRunId: page.summary.activeRunId ?? null,
      turns: page.turns.map(turn => [turn.ordinal, turn.delivery.status, turn.delivery.outcome ?? null, turn.history?.userText ?? null]),
      fixture: inputs().map(entry => entry.prompt).slice(-4) })}`)
  }

  // 1. The parent keeps streaming while a child starts from the last completed turn.
  await send(MAIN_COMPOSER, 'side chat hold parent-stream')
  await wait(`document.querySelector('#main-pane .runtime-composer .run-status') != null`)
  const childDuringParentStream = await evaluate(`document.querySelector('${childTab}') != null`)
  check(childDuringParentStream, 'the child tab disappeared while the parent was streaming')
  check(await mainBusy(), 'the parent run did not stay open for the concurrency check')
  await capture('runtime-parent-streaming')
  await awaitDispatched('side chat hold parent-stream')
  await stopMain()
  await idle()
  const parentInterrupted = inputs().filter(entry => entry.prompt === 'side chat hold parent-stream').length
  check(parentInterrupted === 1, `the parent fixture must have run once: ${json(inputs().map(entry => entry.prompt).slice(-4))}`)

  // 2. A child run is independent: it holds while the parent is idle, and stopping the
  //    child leaves the parent untouched.
  await click(`${childTab} [role="tab"]`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface') != null`)
  await selectProvider('codex')
  const childTurnsBefore = (await conversation(childId)).turns.length
  await send(CHILD_COMPOSER, 'side chat hold child-only')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`)
  const whileChildRuns = { main: await mainBusy(), child: await childBusy(), status: await tabStatus(), activeRunId: await activeChildRun() }
  check(whileChildRuns.activeRunId != null, `the child run never became active: ${json(whileChildRuns)}`)
  check(whileChildRuns.main === false, `a child run must not put the parent composer into a running state: ${json(whileChildRuns)}`)
  check(whileChildRuns.status === '运行中', `the child tab must report its own running state: ${json(whileChildRuns)}`)
  await capture('runtime-child-holding')
  await awaitDispatched('side chat hold child-only')
  await stopChild()
  const stopped = await settleTurn('side chat hold child-only')
  check(stopped.turns.length === childTurnsBefore + 1, `stopping a child must still record its turn: ${json(stopped.turns.map(turn => turn.delivery.status))}`)
  check(stopped.turns.at(-1).delivery.outcome === 'interrupted',
    `a stopped child turn must record its interruption: ${json(stopped.turns.at(-1).delivery)}`)
  check(await mainBusy() === false, 'stopping the child disturbed the parent composer')

  // 3. Reverse direction: the parent is stopped while the child keeps running, and the
  //    child's own record still finishes.
  await send(CHILD_COMPOSER, 'side chat write reverse')
  await send(MAIN_COMPOSER, 'side chat hold parent-reverse')
  await wait(`document.querySelector('#main-pane .runtime-composer .run-status') != null`)
  await awaitDispatched('side chat hold parent-reverse')
  await stopMain()
  // The child's own turn must still land even though the parent was stopped mid-flight.
  // A settled turn carries a terminal outcome; the summary's active run can lag the
  // accepted turn by a moment, so the outcome is the end state, not the absence of a run.
  const reverse = await settleTurn('side chat write reverse')
  const reverseTurn = reverse.turns.at(-1)
  check(reverseTurn != null, `the child never recorded its reverse turn: ${json({
    turns: reverse.turns.map(turn => [turn.ordinal, turn.commandId ?? null, turn.delivery.status, turn.delivery.outcome ?? null, turn.history?.userText ?? null, turn.unavailableReason ?? null]),
    revision: reverse.summary.revision, activeRunId: reverse.summary.activeRunId ?? null,
    fixturePrompts: inputs().map(entry => entry.prompt).slice(-6),
    after: await conversation(childId).then(page => ({ revision: page.summary.revision, activeRunId: page.summary.activeRunId ?? null,
      turns: page.turns.map(turn => [turn.ordinal, turn.delivery.status, turn.history?.userText ?? null]) }))
  })}`)
  check(reverseTurn.history?.userText === 'side chat write reverse',
    `the child's turn must survive the parent stop: ${json(reverseTurn.history?.userText ?? null)}`)
  check(reverseTurn.delivery.status === 'accepted', `the child turn must stay accepted: ${json(reverseTurn.delivery)}`)

  // 4. A hidden child keeps running, but only a visible workbench may mount its body. The
  //    run belongs to main: hiding unmounts the scoped view and its stream subscription and
  //    leaves the run, the attention and the ability to come back to the same run intact.
  await send(CHILD_COMPOSER, 'side chat hold hidden')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`)
  const hideCounts = counts()
  await click('.panel-pill:not(.summary-pill)')
  await wait(`document.querySelector('.app.right-panel-hidden') != null`)
  // Hiding runs a structural transition; the slot keeps `data-pane-leaving` (and its
  // space) until it ends, so the "hidden" snapshot is taken after the animation settles.
  await wait(`document.querySelector('#right-surface-pane')?.hasAttribute('data-pane-leaving') !== true`)
  await idle()
  const hidden = await evaluate(`(() => {
    const panel = document.querySelector('${CHILD_PANEL}')
    return {
      panelVisible: panel ? panel.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : false,
      bodies: document.querySelectorAll('[data-side-chat-panel] [data-side-chat-id]').length,
      composers: document.querySelectorAll('[data-side-chat-panel] .runtime-composer').length,
      sidebarCounts: [...document.querySelectorAll('.sb-sess [data-side-chat-count]')].map(node => node.textContent)
    }
  })()`)
  const hiddenCounts = since(hideCounts)
  check(hidden.panelVisible === false, `the panel must really be off screen for the hidden check: ${json(hidden)}`)
  check(hidden.bodies === 0 && hidden.composers === 0,
    `a hidden workbench must not keep a mounted child body: ${json({ hidden, hiddenCounts })}`)
  check((hiddenCounts['runTraces:unsubscribe'] ?? 0) >= 1,
    `hiding must release the child's stream subscription: ${json(hiddenCounts)}`)
  // A hidden surface holds no stream subscription: whatever the transition started is
  // released again, so the net count cannot grow.
  check((hiddenCounts['runTraces:subscribe'] ?? 0) <= (hiddenCounts['runTraces:unsubscribe'] ?? 0),
    `hiding must leave no child subscription behind: ${json(hiddenCounts)}`)
  const hiddenRun = await activeChildRun()
  check(hiddenRun != null, `a hidden child must keep its run: ${json({ hidden, hiddenRun })}`)
  const parentLabel = hidden.sidebarCounts.find(label => label.includes('侧聊'))
  check(parentLabel != null && (parentLabel.includes('运行中') || parentLabel.includes('需处理')),
    `a hidden running child must still be visible in the sidebar: ${json(hidden)}`)
  await capture('runtime-child-hidden')
  const showCounts = counts()
  await click('.panel-pill:not(.summary-pill)')
  await wait(`document.querySelector('.app.right-panel-hidden') == null`)
  await wait(`document.querySelector('${CHILD_PANEL} .side-chat-surface') != null`)
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`, 20000)
  const reopened = await evaluate(`(() => ({
    childId: document.querySelector('${CHILD_PANEL} .side-chat-surface')?.dataset.sideChatId ?? null,
    running: document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null,
    bodies: document.querySelectorAll('[data-side-chat-panel] [data-side-chat-id]').length,
    text: document.querySelector('${CHILD_PANEL} .chat-body')?.textContent.includes('holding hidden') ?? false
  }))()`)
  const reopenedCounts = since(showCounts)
  check(reopened.childId === childId && reopened.running, `reopening must show the same child still running: ${json({ reopened, reopenedCounts })}`)
  check(reopened.bodies === 1, `reopening must mount exactly one child body: ${json({ reopened })}`)
  check((reopenedCounts['runTraces:subscribe'] ?? 0) >= 1,
    `reopening must resubscribe the visible child's run: ${json(reopenedCounts)}`)
  check(await activeChildRun() === hiddenRun, 'reopening showed another run than the one that kept going')
  check(reopened.text, `the reopened child must show its own streamed text: ${json({ reopened })}`)
  await stopChild()
  await settleTurn('side chat hold hidden')

  // 4b. Closing the tab is a view action, not a stop and not a delete: the run keeps going,
  //     and the child is reopened by its own id through the same history dialog.
  await send(CHILD_COMPOSER, 'side chat hold close')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`)
  const runWhileClosed = await activeChildRun()
  check(runWhileClosed != null, 'the closing child never started its own run')
  const closeCounts = counts()
  await click(`${childTab} .surface-tab-close`)
  await idle()
  const afterClose = await evaluate(`(() => ({
    tab: document.querySelector('${childTab}') != null,
    bodies: document.querySelectorAll('[data-side-chat-panel] [data-side-chat-id]').length
  }))()`)
  const closeDelta = since(closeCounts)
  check(afterClose.tab === false && afterClose.bodies === 0, `closing the tab left its body mounted: ${json({ afterClose })}`)
  check((closeDelta['conversation:delete'] ?? 0) === 0, `closing the tab deleted the child: ${json(closeDelta)}`)
  check((closeDelta['agent:stop'] ?? 0) === 0, `closing the tab stopped the run: ${json(closeDelta)}`)
  const closedRun = await activeChildRun()
  check(closedRun === runWhileClosed, `closing the tab changed the run: ${json({ runWhileClosed, closedRun })}`)
  await openChildById(childId)
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`, 20000)
  check(await activeChildRun() === runWhileClosed, 'the reopened tab showed a different run')
  await stopChild()
  await settleTurn('side chat hold close')


  // 5. An approval belongs to the run that asked for it: the child shows the permission
  //    card, the parent does not, and answering it resumes only the child.
  await send(CHILD_COMPOSER, 'side chat ask child-approval')
  await wait(`document.querySelector('${CHILD_PANEL} .question-inline-form') != null`, 30000)
  const approval = await evaluate(`(() => ({
    childCard: document.querySelector('${CHILD_PANEL} .question-inline-form')?.textContent ?? null,
    parentCard: document.querySelector('#main-pane .question-inline-form') != null,
    status: document.querySelector('${childTab} [data-side-chat-tab-status]')?.textContent ?? null,
    options: [...document.querySelectorAll('[data-side-chat-panel] .question-option')].map(node => node.textContent)
  }))()`)
  check(approval.parentCard === false, `a child approval must not appear in the parent: ${json(approval)}`)
  check(approval.status === '需权限', `the child tab must report the permission need: ${json(approval)}`)
  check((approval.options?.length ?? 0) >= 2, `the child approval lost its options: ${json(approval)}`)
  await capture('runtime-child-approval')
  await click(`${CHILD_PANEL} .question-option`)
  await wait(`document.querySelector('${CHILD_PANEL} .question-submit')?.disabled === false`)
  await click(`${CHILD_PANEL} .question-submit`)
  const approved = await settleTurn('side chat ask child-approval')
  const approvedBody = await evaluate(`document.querySelector('${CHILD_PANEL} .chat-body')?.textContent ?? ''`)
  check(approved.turns.at(-1).delivery.outcome === 'completed',
    `the approved child run did not finish: ${json({ delivery: approved.turns.at(-1).delivery,
      turns: approved.turns.map(turn => [turn.ordinal, turn.delivery.status, turn.delivery.outcome ?? null]),
      revision: approved.summary.revision, activeRunId: approved.summary.activeRunId ?? null,
      body: approvedBody.slice(-200), fixture: inputs().map(entry => [entry.prompt, entry.resume ?? null]).slice(-3) })}`)
  check(approvedBody.includes('continued after approval'), `the approved child never streamed its continuation: ${approvedBody.slice(-300)}`)
  check(await evaluate(`document.querySelector('#main-pane .question-inline-form') == null`),
    'answering the child approval disturbed the parent surface')
  await idle()

  // 6. Two parents own two children. Only the selected session may mount a child body: the
  //    other session's surface stays retained (its terminal included) but renders no child,
  //    so no second scoped subscription exists and the hidden run is not stopped by leaving.
  const openChild = () => evaluate(`(() => ({
    surfaces: document.querySelectorAll('#right-surface-pane [data-session-surface-current]').length,
    mounted: [...document.querySelectorAll('[data-side-chat-panel] .side-chat-surface')].map(node => node.dataset.sideChatId),
    ids: [...document.querySelectorAll('[data-side-chat-id]')].map(node => node.dataset.sideChatId)
  }))()`)
  await send(CHILD_COMPOSER, 'side chat hold scope-a')
  await wait(`document.querySelector('${CHILD_PANEL} .runtime-composer .run-status') != null`)
  const runA = await activeChildRun()
  check(runA != null, 'the first parent child never started its own run')
  // A second parent from the sidebar, then its own child through the same real chooser.
  await click('.sb-new')
  await wait(`document.querySelector('#main-pane .runtime-composer textarea') != null`)
  await idle()
  // A child freezes a completed parent turn, so this parent needs one of its own first.
  await send(MAIN_COMPOSER, 'side chat parent two')
  await wait(`document.querySelector('#main-pane .stop') == null && document.querySelector('#main-pane .chat-body')?.textContent.includes('side chat parent two')`, 30000)
  await idle()
  await showPanel()
  const childB = await createChild()
  check(childB !== childId, `the second parent reused the first parent child: ${json({ childB, childId })}`)
  const scoped = await openChild()
  check(scoped.surfaces >= 2, `the retained surfaces were not mounted for the ownership check: ${json(scoped)}`)
  check(scoped.mounted.length === 1 && scoped.mounted[0] === childB,
    `only the selected session may mount a child body: ${json(scoped)}`)
  check(scoped.ids.length === 1, `more than one child body was mounted across retained surfaces: ${json(scoped)}`)
  const runWhileHidden = await activeChildRun()
  check(runWhileHidden === runA, `leaving the session stopped or replaced the hidden child run: ${json({ runA, runWhileHidden })}`)
  await capture('runtime-retained-scope')

  // The retained child is back, still running, when its own session is selected again.
  const parentIndex = await evaluate(`[...document.querySelectorAll('.sb-sess')].findIndex(row => row.textContent.includes('side chat parent turn'))`)
  check(parentIndex >= 0, 'the first parent row disappeared from the sidebar')
  await clickAt(`[...document.querySelectorAll('.sb-sess')][${parentIndex}]`)
  await wait(`[...document.querySelectorAll('.sb-sess')][${parentIndex}].classList.contains('active') === true`)
  await idle()
  if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) await showPanel()
  const reopenedOwn = await openChild()
  check(reopenedOwn.mounted.length === 1 && reopenedOwn.mounted[0] === childId,
    `selecting the first parent again must show its own child only: ${json(reopenedOwn)}`)
  check(await activeChildRun() === runA, 'the hidden child lost its run while the other session was on screen')
  await stopChild()
  const stoppedHidden = await settleTurn('side chat hold scope-a')
  check(stoppedHidden.turns.at(-1).delivery.outcome === 'interrupted',
    `the retained child could not be stopped after coming back: ${json(stoppedHidden.turns.at(-1).delivery)}`)
  const otherParentChild = await conversation(childB)
  check(otherParentChild.summary.id === childB && otherParentChild.turns.length === 0,
    `stopping the first parent child touched the other parent's child: ${json({ childB, turns: otherParentChild.turns.length })}`)

  return {
    hiddenChildMountedBodies: hidden.bodies,
    retainedScopeOwnership: { surfaces: scoped.surfaces, mountedIds: scoped.mounted, childId, childB,
      sameRunWhileHidden: runWhileHidden === runA, reopened: reopenedOwn.mounted, stoppedOutcome: stoppedHidden.turns.at(-1).delivery.outcome },
    parentConcurrentRun: { fixtureRuns: parentInterrupted, mainBusyObserved: true },
    childIndependentStop: { turns: stopped.turns.length, activeRunId: stopped.summary.activeRunId ?? null, tabStatus: whileChildRuns.status },
    reverseStop: { childTurnStatus: reverseTurn.delivery.status, userText: reverseTurn.history?.userText ?? null },
    hiddenChild: { ...hidden, activeRunId: hiddenRun, reopened },
    childApproval: { status: approval.status, parentCard: approval.parentCard, options: approval.options?.length ?? 0 }
  }
}
