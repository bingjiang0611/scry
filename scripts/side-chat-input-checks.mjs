import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'

/** Native composition and untrusted Provider text acceptance for the selected child. */
export async function exerciseSideChatInput({ cdp, evaluate, check, childId, controls, showChild }) {
  const { driver, capture, click, clearDraft, keyStroke, wait, conversation, inputs } = controls
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
  await cdp.send('Input.insertText', { text: 'side chat reply <img src=x onerror=alert(1)>' })
  await wait(`document.querySelector('${CHILD_COMPOSER}')?.value.includes('img src') === true`)
  const turnsBeforeInjection = (await conversation(childId)).turns.length
  await click(`${CHILD_PANEL} .send`)
  await wait(`window.scry.conversations.read(${json(childId)}).then(page => page.turns.length === ${turnsBeforeInjection + 1}
    && page.turns.at(-1)?.delivery.outcome === 'completed')`, 40000)
  // The child transcript is windowed, so the newest turn is reached by a real scroll.
  const bodyPoint = await driver.pointerAt(`document.querySelector('${CHILD_PANEL} .chat-body')`)
  for (let wheel = 0; wheel < 8; wheel += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...bodyPoint, deltaX: 0, deltaY: 1200 })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  await wait(`document.querySelector('${CHILD_PANEL} .chat-body')?.textContent.includes('onerror=alert(1)') === true`, 15000)
    .catch(() => undefined)
  const injected = await evaluate(`(() => {
    const body = document.querySelector('${CHILD_PANEL} .chat-body')
    const text = body.textContent ?? ''
    const start = text.indexOf('side chat reply')
    return { img: body.querySelectorAll('img').length, script: body.querySelectorAll('script').length,
      text: text.includes('<img src=x onerror=alert(1)>'), context: start < 0 ? text.slice(-200) : text.slice(start, start + 160) }
  })()`)
  check(injected.img === 0 && injected.script === 0, `Provider text was rendered as markup: ${json(injected)}`)
  check(injected.text, `Provider text was not shown verbatim: ${json(injected)}`)
  await capture('layout-untrusted-text')

  return { ime: { value: composing.value, dispatchedDuringComposition: imeDispatched }, untrustedText: injected }
}
