import { renameSync, writeFileSync } from 'node:fs'
import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'
import { lateHistoryPath } from './smoke-app-entries.mjs'

/** Native composition and untrusted Provider text acceptance for the selected child. */
export async function exerciseSideChatInput({ cdp, evaluate, check, childId, controls, showChild, ipcCountsPath }) {
  const { capture, click, clearDraft, keyStroke, wait, conversation, inputs } = controls
  // 6. Real IME composition must not send, and committing it must not lose the text.
  // End activates the last tab, which need not be the conversation under test.
  await showChild()
  await click(CHILD_COMPOSER)
  const beforeComposition = inputs().length
  const turnsBefore = (await conversation(childId)).turns.length
  await cdp.send('Input.imeSetComposition', { text: '侧边会话', selectionStart: 4, selectionEnd: 4 })
  await new Promise(resolve => setTimeout(resolve, 200))
  await keyStroke({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await new Promise(resolve => setTimeout(resolve, 400))
  const composing = await evaluate(`(() => ({ value: document.querySelector('${CHILD_COMPOSER}')?.value ?? null,
    composing: document.querySelector('${CHILD_COMPOSER}')?.matches(':focus') ?? false }))()`)
  check(composing.value === '侧边会话', `an IME composition was not kept in the composer: ${json(composing)}`)
  const imeDispatched = inputs().length !== beforeComposition
  check(!imeDispatched, 'Enter during IME composition dispatched a Provider run')
  check((await conversation(childId)).turns.length === turnsBefore, 'Enter during IME composition created a turn')
  await cdp.send('Input.insertText', { text: '侧边会话' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value === '侧边会话'`)
  await clearDraft(CHILD_COMPOSER)
  await capture('layout-ime')

  // 7. Snapshot and Provider text is untrusted: it renders as text, never as markup.
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
  await wait(`window.scry.conversations.read(${json(childId)}).then(page => page.turns.length === ${turnsBeforeInjection + 1}
    && page.turns.at(-1)?.delivery.outcome === 'completed')`, 40000)
  // A terminal receipt can arrive before the history body is projected. Deliver its
  // recorded event after the renderer has committed the no-active-run/missing-body state.
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

  return { ime: { value: composing.value, dispatchedDuringComposition: imeDispatched },
    lateRecordedRunId: recorded.turns.at(-1).runId, untrustedText: injected }
}
