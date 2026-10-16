import assert from 'node:assert/strict'

// Fixed cohorts, not retries: retain every observation, including the first.
export const composerModes = Array.from({ length: 3 }, () => ['stop-immediate', 'complete', 'stop-visible', 'stop-immediate']).flat()

// Runs inside the real renderer. Observe only: never invoke start/stop or fabricate DOM output.
export function observeComposer(prompt, mode) {
  const state = { prompt, mode, inputTrusted: false, sendTrusted: false, stopTrusted: false, errors: [], visibleFrames: 0, settledFrames: 0 }
  window.__composerProbe = state
  const waiters = new Set()
  window.__waitForComposer = field => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); waiters.delete(check)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (state.errors.length) finish(new Error(state.errors.join('; ')))
      else if (state[field]) finish()
    }
    const timer = setTimeout(() => finish(new Error(`Composer condition timed out: ${field}; ${JSON.stringify(state)}`)), 15000)
    waiters.add(check); check()
  })
  const click = event => {
    if (event.target.closest('button.send')) { state.sendAt = performance.now(); state.sendTrusted = event.isTrusted }
    if (event.target.closest('button.run-status-stop')) { state.stopAt = performance.now(); state.stopTrusted = event.isTrusted }
  }
  const input = event => {
    if (event.target.matches('textarea') && event.target.value === prompt) state.inputTrusted = event.isTrusted
  }
  document.addEventListener('click', click, true)
  document.addEventListener('input', input, true)
  const offTrace = window.scry.onTrace(events => {
    if (state.sendAt === undefined) return
    for (const event of events) {
      state.runId ??= event.runId
      if (event.runId === state.runId && event.kind === 'harness' && event.stage === 'init' && event.text === `Awaiting native turn: ${prompt}`) state.nativeTurnPending = true
      if (event.runId === state.runId && event.kind === 'model' && ['text', 'text_delta'].includes(event.stage)) state.firstOutputReceiptAt ??= performance.now()
    }
  })
  const offDone = window.scry.onTurnDone(event => {
    if (state.sendAt === undefined) return
    if (state.runId && state.runId !== event.runId) { state.errors.push('terminal identity mismatch'); return }
    state.runId = event.runId
    state.done = event
    state.terminalAt = performance.now()
  })
  const offError = window.scry.onError(event => state.errors.push(event.message))
  let frame
  const inspect = () => {
    const turn = [...document.querySelectorAll('.transcript-turn')].find(element => element.dataset.runId === state.runId)
    const expected = `Visible reply: ${prompt}`
    let visible = false
    if (turn) for (const element of turn.querySelectorAll('.model-text')) {
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let node
      while ((node = walker.nextNode())) {
        const index = node.textContent.indexOf(expected)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index); range.setEnd(node, index + expected.length)
        for (const rect of range.getClientRects()) {
          const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right)
          const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom)
          if (right > left && bottom > top && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2))) visible = true
        }
      }
    }
    state.visibleFrames = visible ? state.visibleFrames + 1 : 0
    if (visible) state.firstVisibleAt ??= performance.now()
    if (state.visibleFrames >= 2) state.visibleReadyAt ??= performance.now()
    const stop = document.querySelector('button.run-status-stop')
    if (stop && !stop.disabled && (mode === 'stop-visible' ? state.visibleReadyAt : state.nativeTurnPending)) state.stopReadyAt ??= performance.now()
    const settled = state.done && !document.querySelector('button.run-status-stop') && !document.querySelector('textarea').disabled
    state.settledFrames = settled ? state.settledFrames + 1 : 0
    if (state.settledFrames >= 2) state.settledVisibleAt ??= performance.now()
    for (const check of waiters) check()
    frame = requestAnimationFrame(inspect)
  }
  frame = requestAnimationFrame(inspect)
  window.__disposeComposerProbe = () => {
    cancelAnimationFrame(frame); offTrace(); offDone(); offError()
    document.removeEventListener('click', click, true); document.removeEventListener('input', input, true)
  }
}

export async function probeNativeComposer({ evaluate, wait, click, send }) {
  const samples = []
  for (const [index, mode] of composerModes.entries()) {
    const prompt = `native composer ${mode} ${index}`
    await evaluate(`(${observeComposer.toString()})(${JSON.stringify(prompt)}, ${JSON.stringify(mode)})`)
    // The observer already requires two frames. The history driver's wait() adds
    // two more frames per call, so do not use it between readiness and Stop.
    const ready = field => evaluate(`window.__waitForComposer(${JSON.stringify(field)})`)
    try {
      await click(`document.querySelector('textarea')`)
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' })
      await send('Input.insertText', { text: prompt })
      assert.equal(await evaluate(`document.querySelector('textarea').value`), prompt)
      await wait(`document.querySelector('button.send[aria-label="发送"]:not(:disabled)')`)
      await click(`document.querySelector('button.send[aria-label="发送"]')`)
      if (mode !== 'complete') {
        await ready('stopReadyAt')
        await click(`document.querySelector('button.run-status-stop')`)
      }
      await ready('settledVisibleAt')
      if (mode !== 'stop-immediate') await ready('visibleReadyAt')
      const state = await evaluate('window.__composerProbe')
      assert.equal(state.inputTrusted, true)
      assert.equal(state.sendTrusted, true)
      assert.equal(Boolean(state.done.stopped), mode !== 'complete')
      if (mode !== 'complete') assert.equal(state.stopTrusted, true)
      if (mode === 'stop-immediate') assert.equal(state.firstOutputReceiptAt, undefined)
      assert.equal(await evaluate(`window.scry.activeRuns().then(runs => runs.some(run => run.runId === ${JSON.stringify(state.runId)}))`), false)
      samples.push({ mode, prompt, runId: state.runId, inputTrusted: state.inputTrusted, sendTrusted: state.sendTrusted, stopTrusted: state.stopTrusted,
        terminalConfirmed: true, stopped: Boolean(state.done.stopped), sendToTerminalMs: state.terminalAt - state.sendAt,
        sendToSettledVisibleMs: state.settledVisibleAt - state.sendAt,
        ...(mode !== 'stop-immediate' ? { sendToOutputReceiptMs: state.firstOutputReceiptAt - state.sendAt, sendToFirstVisibleMs: state.firstVisibleAt - state.sendAt, sendToVisibleReadyMs: state.visibleReadyAt - state.sendAt } : {}),
        ...(mode !== 'complete' ? { driverStopDispatchMs: state.stopAt - state.stopReadyAt, stopToTerminalMs: state.terminalAt - state.stopAt, stopToSettledVisibleMs: state.settledVisibleAt - state.stopAt } : {}) })
    } finally { await evaluate('window.__disposeComposerProbe()') }
  }
  return samples
}
