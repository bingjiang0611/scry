import { CHILD_COMPOSER, CHILD_PANEL, json } from './side-chat-driving.mjs'

/**
 * Side-chat layout step 7: snapshot and Provider text is untrusted, so it renders as
 * text, never as markup.
 *
 * A real composer send in the child, then a real wheel scroll of its windowed transcript;
 * the rendered body must hold the markup verbatim and no `img`/`script` node.
 */
export async function exerciseSideChatUntrustedText({ cdp, evaluate, check, childId, driver, click, wait, capture, conversation }) {
  await click(CHILD_COMPOSER)
  await cdp.send('Input.insertText', { text: 'side chat reply <img src=x onerror=alert(1)>' })
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
  return injected
}
