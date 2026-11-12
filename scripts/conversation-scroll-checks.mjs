import assert from 'node:assert/strict'

export const CONVERSATION_AT_LATEST = `(() => { const el=document.querySelector('.conversation-chat .chat'); return el && el.scrollHeight-el.clientHeight-el.scrollTop < 2 })()`

// Production bottom-follow and deliberate reader scrolling, with native wheel
// input. Waiting for the pin must never perform it on the product's behalf.
export async function exerciseConversationScroll({ cdp, evaluate, ready, wait, conversationId }) {
  const target = `document.querySelector('.unified-conversation')?.dataset.conversationId === ${JSON.stringify(conversationId)}`
  const body = `document.querySelectorAll('.conversation-chat .turn').length === 2 && ${CONVERSATION_AT_LATEST}`
  await ready({ body, target })
  // The policy allows 32px of slack. Prove real overflow before claiming bottom-follow.
  const geometry = () => evaluate(`(() => { const el=document.querySelector('.conversation-chat .chat'); return {
    atLatest: ${CONVERSATION_AT_LATEST}, scrollHeight: el?.scrollHeight ?? null,
    clientHeight: el?.clientHeight ?? null, scrollTop: el?.scrollTop ?? null,
    viewportWidth: innerWidth, viewportHeight: innerHeight, deviceScaleFactor: devicePixelRatio,
    conversationId: document.querySelector('.unified-conversation')?.dataset.conversationId ?? null,
    turns: document.querySelectorAll('.conversation-chat .turn').length
  } })()`)
  const overflowing = state => state.scrollHeight - state.clientHeight > 32
  let initialScrollState
  try {
    // Shrink only while the transcript cannot scroll. A lost pin on an already
    // scrollable viewport must fail, not advance to a more convenient viewport.
    for (const height of [700, 640, 560]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height, deviceScaleFactor: 1, mobile: false })
      initialScrollState = await geometry()
      // ResizeObserver schedules pinning in another frame. Await the real state,
      // not a fixed frame count, without scrolling or increasing the deadline.
      await ready({ body, target })
      initialScrollState = await geometry()
      if (overflowing(initialScrollState)) break
    }
    assert.ok(overflowing(initialScrollState), `the transcript must overflow to test bottom following: ${JSON.stringify(initialScrollState)}`)
    assert.ok(initialScrollState.atLatest, `scrollable transcript follows the bottom: ${JSON.stringify(initialScrollState)}`)
    const wheelPoint = await evaluate(`(() => {const rect=document.querySelector('.conversation-chat .chat').getBoundingClientRect();return {x:rect.left+10,y:rect.top+30}})()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -10000 })
    await wait(() => evaluate(`document.querySelector('.conversation-chat .chat').scrollTop === 0 && !${CONVERSATION_AT_LATEST}`), 'user scroll leaves bottom following')
    for (const height of [760, 640]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height, deviceScaleFactor: 1, mobile: false })
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
      const position = await evaluate(`(() => { const el=document.querySelector('.conversation-chat .chat'); return { top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight } })()`)
      assert.equal(position.top, 0, `layout changes must preserve the user reading older output: ${JSON.stringify(position)}`)
    }
  } catch (error) {
    const [current] = await Promise.allSettled([geometry()])
    console.error('[scry] transcript scroll geometry', { expectedConversationId: conversationId, initial: initialScrollState, current })
    throw error
  } finally { await cdp.send('Emulation.clearDeviceMetricsOverride') }
}
