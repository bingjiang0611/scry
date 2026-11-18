import { renameSync, writeFileSync } from 'node:fs'
import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'
import { lateHistoryPath } from './smoke-app-entries.mjs'

/**
 * Side-chat layout step 7: snapshot and Provider text is untrusted, so it renders as
 * text, never as markup.
 *
 * A real composer send in the child, then a real wheel scroll of its windowed transcript
 * (aimed at the transcript gutter); the rendered body must hold the markup verbatim and no
 * `img`/`script` node.
 *
 * The fixture first withholds the recorded history body: a terminal receipt can arrive
 * before the body is projected, so the recorded event is delivered only after the renderer
 * has committed the no-active-run/missing-body state.
 */
export async function exerciseSideChatUntrustedText({ cdp, evaluate, check, childId, click, wait, capture, conversation, ipcCountsPath }) {
  await click(CHILD_COMPOSER)
  const prompt = 'side chat reply <img src=x onerror=alert(1)>'
  const marker = lateHistoryPath(ipcCountsPath)
  const setArchiveVisibility = release => {
    writeFileSync(marker + '.writing', JSON.stringify({ conversationId: childId, prompt, release }))
    renameSync(marker + '.writing', marker)
  }
  setArchiveVisibility(false)
  await cdp.send('Input.insertText', { text: prompt })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value.includes('img src') === true`)
  const turnsBeforeInjection = (await conversation(childId)).turns.length
  await click(`${CHILD_PANEL} .send`)
  // `wait` evaluates its expression synchronously, so a read Promise (always truthy) made
  // it return at once and the step raced the run. The record is polled here instead.
  const injectedDeadline = Date.now() + 40000
  let injectedTurn
  while (!injectedTurn && Date.now() < injectedDeadline) {
    const page = await conversation(childId)
    if (page.turns.length === turnsBeforeInjection + 1 && page.turns.at(-1)?.delivery.outcome === 'completed') injectedTurn = page.turns.at(-1)
    else await new Promise(resolve => setTimeout(resolve, 100))
  }
  check(injectedTurn != null, `the untrusted-text turn never completed: ${json((await conversation(childId)).turns.slice(-2).map(turn => turn.delivery))}`)
  await wait(`document.querySelector('${CHILD_PANEL} .conversation-history-notice')?.textContent.includes('fixture: archive pending') === true`)
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  setArchiveVisibility(true)
  const recorded = await conversation(childId)
  check(recorded.summary.activeRunId == null && recorded.turns.at(-1)?.history?.userText === prompt,
    'late-record fixture did not expose the completed authoritative body')
  // The child transcript is windowed, so the newest turn is reached by a real scroll.
  for (let wheel = 0; wheel < 8; wheel += 1) {
    // Target the transcript gutter itself. The padded wrapper's center can hit
    // a nested scrollable tool result, which consumes the wheel instead.
    const bodyPoint = await evaluate(`(() => {
      const scroller = document.querySelector('${CHILD_PANEL} .chat-body .chat-transcript');
      const rect = scroller.getBoundingClientRect();
      const point = { x: rect.left + 4, y: rect.top + rect.height / 2 };
      if (document.elementFromPoint(point.x, point.y) !== scroller) throw new Error('Transcript scroll gutter is obscured');
      return point;
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...bodyPoint, deltaX: 0, deltaY: 1200 })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body')?.textContent.includes('onerror=alert(1)') === true`, 15000)
    .catch(() => undefined)
  const injected = await evaluate(`(() => {
    const body = document.querySelector('${CHILD_PANEL} .chat-body')
    const text = body.textContent ?? ''
    const start = text.indexOf('side chat reply')
    const scroller = body.querySelector('.chat-transcript');
    return { img: body.querySelectorAll('img').length, script: body.querySelectorAll('script').length,
      text: text.includes('<img src=x onerror=alert(1)>'), context: start < 0 ? text.slice(-200) : text.slice(start, start + 160),
      childId: body.closest('[data-side-chat-id]')?.dataset.sideChatId, expectedChildId: ${json(childId)},
      scroll: { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight },
      renderedRuns: [...body.querySelectorAll('[data-run-id]')].slice(-5).map(node => node.dataset.runId),
      olderPage: [...document.querySelector('${CHILD_PANEL}').querySelectorAll('.unified-pagination button')].some(node => node.textContent === '最近记录' && !node.disabled) }
  })()`)
  check(injected.img === 0 && injected.script === 0, `Provider text was rendered as markup: ${json(injected)}`)
  check(injected.text, `Provider text was not shown verbatim: ${json(injected)}`)
  await capture('layout-untrusted-text')
  return { injected, lateRecordedRunId: recorded.turns.at(-1).runId }
}
