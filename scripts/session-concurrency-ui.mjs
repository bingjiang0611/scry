import { nativeUiPointer } from './native-ui-pointer.mjs'

// Native UI operations against the real renderer: seeded catalog preparation, the newly started session
// row wait, history switches through native input, and the right-panel Overview steps. Every click is
// gated by a trusted on-target receipt and every readiness fact is read from the DOM; nothing here
// retries a dispatched click, writes to the page, or substitutes an IPC read for a UI operation.

// Readiness: the latest seeded turn mounted inside the transcript viewport with a usable composer; a
// transcript still holding turn 0 is not evidence that this switch arrived.
export function historyReadinessScript({ sessionId, latestIndex }) {
  return `(() => {
    const scroller = document.querySelector('.chat-transcript[aria-busy="false"]')
    const last = document.querySelector('[data-run-id="${sessionId}-turn-${latestIndex}"]')
    const input = document.querySelector('textarea')
    if (!scroller || !last || !last.textContent.includes('END ${sessionId} ${latestIndex}')) return false
    if (!input || input.disabled || input.readOnly) return false
    const rect = last.getBoundingClientRect(), viewport = scroller.getBoundingClientRect()
    return rect.bottom >= viewport.top && rect.top <= viewport.bottom && rect.height > 0
  })()`
}

// Native pointer dispatch through the shared helper (scroll, two settled frames, hit test, receipt); a
// click counts only when the receipt shows a trusted event on the target, else it stays unverified.
async function clickWithNativePointer({ session, evaluate, selector, text }) {
  let point
  try {
    point = await evaluate(`(${nativeUiPointer.toString()})(${JSON.stringify(selector)}, ${JSON.stringify({
      text, timeoutMs: 8_000, scroll: true, captureReceipt: true })})`)
  } catch (error) {
    return { dispatched: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 800) }
  }
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  const receipt = await evaluate(`(async () => {
    const deadline = performance.now() + 1000
    while (!window.__nativeUiPointerReceipt && performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve))
    }
    return window.__nativeUiPointerReceipt ?? null
  })()`)
  const proven = receipt?.trusted === true && receipt?.targetMatched === true
  return { dispatched: true, proven, receipt }
}

// Preparation before dispatch. Only the seeded catalog is proven here: both seeded sessions per run
// (the 20-turn history target and the pre-seeded live session) are rendered and each target's project
// group is open, so the seeded rows cannot shift. The row for a session started by this measurement does
// not exist yet; waitForAdmittedTasks covers that after dispatch, for every task of the batch. Production defaults projects to expanded
// (Sidebar.tsx collapsed = new Set(); Disclosure.tsx unmounts collapsed children), so a collapsed target
// is reported as an unexpected state, never repaired.
export async function prepareHistoryTargets({ evaluate, wait, targets }) {
  const historyIds = JSON.stringify([...new Set(targets.map(target => target.sessionId))])
  const seededLiveIds = JSON.stringify([...new Set(targets.map(target => target.seededLiveSessionId))])
  await wait(`(() => {
    if (typeof window.scry !== 'object') return false
    const labels = Array.from(document.querySelectorAll('button.sb-sess')).map(node => node.textContent)
    const listed = ids => ids.every(id => labels.some(label => label.includes(id)))
    return listed(${historyIds}) && listed(${seededLiveIds})
  })()`)
  const prepared = []
  for (const { sessionId, seededLiveSessionId, cwd } of targets) {
    const id = JSON.stringify(sessionId)
    const dir = JSON.stringify(cwd)
    prepared.push(await evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('button.sb-sess'))
      const found = rows.find(node => node.textContent.includes(${id}))
      if (!found) return { sessionId: ${id}, state: 'seeded-row-not-listed-after-wait' }
      const group = found.closest('.sb-proj')
      const head = group ? group.querySelector('button.sb-proj-head[data-project-path]') : null
      const groupPath = head ? head.dataset.projectPath : null
      const open = Boolean(group && group.classList.contains('open') && head?.getAttribute('aria-expanded') === 'true')
      // The seeded live row must sit in this target's own group: identity, not text proximity.
      const seededLiveInGroup = Boolean(group) && Array.from(group.querySelectorAll('button.sb-sess'))
        .some(node => node.textContent.includes(${JSON.stringify(seededLiveSessionId)}))
      return { sessionId: ${id}, groupPath, cwdMatched: groupPath === ${dir}, seededLiveInGroup, groupOpen: open,
        state: open && groupPath === ${dir} && seededLiveInGroup ? 'seeded-ready'
          : open ? 'unexpected-group-or-seeded-row' : 'unexpected-collapsed-group' }
    })()`))
  }
  return prepared
}

// After dispatch, before the first history click: each target project group must show the row of the
// session this measurement just started. Identity is the fixed scenario prompt together with that run's
// cwd, because both seeded previews are conc-N-* and cannot match the prompt; a global row count would
// also pass if a different project grew. The wait is bounded by the fixture deadline and never sleeps
// past it, and no click is dispatched from here.
// Read-only per-target admission state. Injected with toString(), so it must stay self-contained.
export function readAdmissionState(targets) {
  const replies = Array.isArray(window.__scryConcurrencyStartReplies) ? window.__scryConcurrencyStartReplies : []
  return targets.map(target => {
    const head = Array.from(document.querySelectorAll('button.sb-proj-head[data-project-path]'))
      .find(node => node.dataset.projectPath === target.cwd)
    const group = head ? head.closest('.sb-proj') : null
    const rowObserved = Boolean(group) && Array.from(group.querySelectorAll('button.sb-sess'))
      .some(node => node.textContent.includes(target.prompt))
    return { rowObserved, replyObserved: replies.some(reply => reply.cwd === target.cwd) }
  })
}

// Admission evidence for the whole batch. A task is admitted only when the App returned a start reply naming a
// run for that cwd AND its new session row is rendered: a row alone is not admission
// (src/main/bootstrap/run-live-state.ts records pending live state before the run is registered), and no fact
// is inferred from the other. One bounded wait covers every target instead of one bound per target, which
// would silently multiply the phase deadline (16 x 8 s); after the bound the state is read once, and whatever
// was not observed is reported unavailable for the missing part. No retry, no second wait.
export const ADMISSION_TIMEOUT_MS = 8_000
export async function waitForAdmittedTasks({ evaluate, targets, timeoutMs = ADMISSION_TIMEOUT_MS }) {
  const wanted = JSON.stringify(targets.map(target => ({ cwd: target.cwd, prompt: target.prompt })))
  const read = `(${readAdmissionState.toString()})(${wanted})`
  let waitError = null
  try {
    await evaluate(`(async () => {
      const deadline = performance.now() + ${timeoutMs}
      while (!${read}.every(entry => entry.rowObserved && entry.replyObserved) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 16))
      }
      return true
    })()`)
  } catch (error) {
    waitError = (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300)
  }
  let state = null
  try { state = await evaluate(read) } catch (error) {
    waitError = waitError ?? (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300)
  }
  return targets.map((target, index) => {
    const observed = Array.isArray(state) ? state[index] ?? null : null
    const rowObserved = observed?.rowObserved === true
    const replyObserved = observed?.replyObserved === true
    const missing = [rowObserved ? null : 'no new session row for this prompt in the task cwd',
      replyObserved ? null : 'no start reply was recorded for this cwd',
      waitError ? `admission wait reported: ${waitError}` : null].filter(Boolean)
    return { sessionId: target.sessionId, cwd: target.cwd, prompt: target.prompt,
      startedRow: rowObserved ? 'observed' : 'not-observed',
      startReply: replyObserved ? 'observed' : 'not-observed',
      ...(missing.length === 0 ? { status: 'measured' } : { status: 'unavailable', reason: missing.join('; ') }) }
  })
}

// Bounded state poll returning the last real observation: a hidden panel is a state, not a stuck App.
async function pollOverviewState(evaluate, predicate, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  let state = await evaluate(OVERVIEW_STATE)
  while (!predicate(state) && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 16))
    state = await evaluate(OVERVIEW_STATE)
  }
  return state
}

// Right-panel state: the pill's aria-pressed, plus whether the session tabpanel is visible and hit-testable
// (a hidden tabpanel has a zero rect, so DOM presence alone would pass a click that never landed).
const OVERVIEW_PANEL_TOGGLE = 'button.tb-action.panel-pill:not(.summary-pill)'
const OVERVIEW_STATE = `(() => {
  const toggle = document.querySelector('${OVERVIEW_PANEL_TOGGLE}')
  const panel = document.querySelector('#overview-session-panel')
  const rect = panel ? panel.getBoundingClientRect() : null
  const visible = Boolean(panel) && panel.hidden === false && rect.width > 0 && rect.height > 0
  const hit = visible ? document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + 8)) : null
  return { panelOpen: toggle?.getAttribute('aria-pressed') === 'true', hidden: panel ? panel.hidden : null,
    rect: rect ? [rect.x, rect.y, rect.width, rect.height] : null, visible,
    insideViewport: Boolean(hit && panel.contains(hit)) }
})()`

// Overview evidence: open the right panel through its real toolbar pill when closed, click the session tab,
// then require a visible hit-testable panel. Failures keep the receipt and panel geometry.
async function ensureOverviewVisible({ session, evaluate }) {
  const before = await evaluate(OVERVIEW_STATE)
  let toggle = null
  if (!before.panelOpen) {
    toggle = await clickWithNativePointer({ session, evaluate, selector: OVERVIEW_PANEL_TOGGLE })
    const panelToggle = { proven: toggle.proven, receipt: toggle.receipt ?? null }
    if (!toggle.proven) return { overview: 'unverified-panel-toggle', panelToggle, before }
    if (!(await pollOverviewState(evaluate, state => state.panelOpen, 3_000)).panelOpen) {
      return { overview: 'blocked-panel-not-opened', panelToggle, before }
    }
  }
  const tab = await clickWithNativePointer({ session, evaluate, selector: '#overview-session-tab' })
  const panelToggle = toggle ? { proven: toggle.proven, receipt: toggle.receipt ?? null } : { used: false, wasOpen: true }
  if (!tab.proven) return { overview: tab.dispatched ? 'unverified-tab-receipt' : 'blocked-tab-not-ready',
    panelToggle, tabReceipt: tab.receipt ?? null, ...(tab.error ? { error: tab.error } : {}), before }
  const after = await pollOverviewState(evaluate, state => state.visible && state.insideViewport, 3_000)
  return { overview: after.visible && after.insideViewport ? 'visible'
      : after.visible ? 'blocked-panel-outside-viewport' : 'blocked-panel-hidden',
    panelToggle, tabReceipt: tab.receipt ?? null, before, after }
}

export async function performHistorySwitches({ session, evaluate, wait, targets, preparation, startedRows,
  expectedStarted }) {
  // Dispatch requires three proven preconditions: the seeded catalog is ready for every switch target, every
  // task of the batch has been admitted (start reply recorded for its cwd and its new session row rendered),
  // and each of those observations is measured. Admission matters beyond the switch targets: a history click changes the authorized cwd, and a
  // start still in flight would then be rejected by the real trust/cwd gate. Nothing is filtered down to the
  // ready subset, so one unadmitted task forbids all clicks; no click is retried and the switches stay
  // incomplete instead.
  const ready = preparation.length === targets.length && preparation.every(entry => entry.state === 'seeded-ready')
    && Number.isInteger(expectedStarted) && startedRows.length === expectedStarted
    && startedRows.every(entry => entry.status === 'measured')
    && targets.every(target => startedRows.some(entry => entry.sessionId === target.sessionId))
  if (!ready) return []
  const switches = []
  for (const { sessionId, latestIndex } of targets) {
    const startedAt = performance.now()
    const click = await clickWithNativePointer({ session, evaluate, selector: 'button.sb-sess', text: sessionId })
    const attempt = { sessionId, latestIndex,
      receiptTrusted: click.receipt?.trusted === true, receiptTargetMatched: click.receipt?.targetMatched === true,
      receipt: click.receipt ?? null, ...(click.error ? { pointerError: click.error } : {}) }
    if (!click.proven) {
      switches.push({ ...attempt, mode: click.dispatched ? 'click-unverified-receipt' : 'blocked-pointer-not-ready',
        readiness: 'not-waited-unproven-click', overview: 'not-attempted-unproven-history-click',
        switchMs: performance.now() - startedAt })
      continue
    }
    let mode = 'native-click'
    let readiness = 'latest-turn-visible'
    try {
      await wait(historyReadinessScript({ sessionId, latestIndex }))
    } catch (error) {
      mode = 'blocked-transcript-not-ready'
      readiness = String(error && error.message).slice(0, 800)
    }
    const overview = mode === 'native-click' ? await ensureOverviewVisible({ session, evaluate })
      : { overview: 'not-attempted-transcript-not-ready' }
    switches.push({ ...attempt, mode, readiness, switchMs: performance.now() - startedAt, ...overview })
  }
  return switches
}
