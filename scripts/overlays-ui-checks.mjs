// Full production App + production overlays; native input is never held until exit ends.
export async function exerciseOverlays(contents) {
  const read = expression => contents.executeJavaScript(expression)
  const check = (condition, message) => { if (!condition) throw new Error(`Overlays: ${message}`) }
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Overlays condition timed out: ${expression}`)
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const click = async expression => {
    const point = await read(`(() => { const node = ${expression}; if (!node) throw new Error('Missing overlay target'); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const point = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; if (!node.contains(document.elementFromPoint(point.x, point.y))) throw new Error('Occluded overlay target: ' + JSON.stringify({ node: node.outerHTML.slice(0, 200), rect: r.toJSON(), hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 500), viewport: [innerWidth, innerHeight], inert: node.closest('[inert]')?.outerHTML.slice(0, 150) })); return point; })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const css = selector => `document.querySelector(${JSON.stringify(selector)})`
  const key = keyCode => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const modalIn = selector => `${css(selector)}?.getAnimations().find(animation => animation.animationName === 'modal-dialog-in')`
  const framesOnlyOpacity = expression => `(${expression}).every(animation => animation.effect.getKeyframes().every(frame => (!frame.transform || frame.transform === 'none') && frame.width == null && frame.height == null))`
  const closeTimes = []
  const close = async (selector, trigger, path = 'button') => {
    const nativeEvent = path === 'escape' ? 'keydown' : path === 'backdrop' ? 'mousedown' : 'click'
    await read(`window.exitingOverlay = ${css(selector)}.parentElement; window.overlayCloseStart = null; window.overlayRemovedAt = null; window.overlayExitEndAt = null; window.addEventListener('${nativeEvent}', () => { window.overlayCloseStart = performance.now() }, { once: true, capture: true }); window.exitingOverlay.addEventListener('animationend', event => { if (event.target === window.exitingOverlay) window.overlayExitEndAt = performance.now() }); { const removal = new MutationObserver(() => { if (!window.exitingOverlay.isConnected) { window.overlayRemovedAt = performance.now(); removal.disconnect() } }); removal.observe(document.body, { childList: true, subtree: true }) }`)
    if (path === 'escape') key('Escape')
    else if (path === 'backdrop') {
      const point = await read(`(() => { const r = window.exitingOverlay.getBoundingClientRect(); const p = { x: r.left + 8, y: r.bottom - 8 }; if (document.elementFromPoint(p.x, p.y) !== window.exitingOverlay) throw new Error('Backdrop point is not the overlay'); return p; })()`)
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    } else await click(css(`${selector} .modal-x`))
    await wait(`window.exitingOverlay.dataset.state === 'exit'`)
    check(await read(`window.exitingOverlay.isConnected && window.exitingOverlay.inert && document.activeElement === ${css(trigger)}`), `${path} did not restore focus at exit start`)
    check(await read(`window.exitingOverlay.getAnimations().some(animation => animation.effect.getTiming().duration === 160) && window.exitingOverlay.querySelector('.modal').getAnimations().some(animation => animation.effect.getTiming().duration === 150)`), 'Wrong backdrop/dialog exit duration')
    await wait(`!window.exitingOverlay.isConnected`)
    const clock = await read('({ start: window.overlayCloseStart, end: window.overlayRemovedAt })')
    check(Number.isFinite(clock.start) && Number.isFinite(clock.end) && clock.end >= clock.start, 'Missing native close/removal clock')
    const ms = clock.end - clock.start
    check(ms <= 250, `${path} retained the modal for ${ms}ms`)
    closeTimes.push({ selector, path, ms, nativeAnimationEnd: await read('window.overlayExitEndAt != null') })
  }
  await wait(`document.querySelectorAll('button.sb-sess').length === 2 && window.overlayFixture != null`)
  for (const theme of ['light', 'dark']) {
    await click(css('.sb-settings'))
    await wait(`${modalIn('.settings-modal')}?.effect.getTiming().duration === 260`)
    check(await read(`${modalIn('.settings-modal')}.effect.getKeyframes().some(frame => frame.transform?.includes('0.97') && frame.transform.includes('6px'))`), 'Missing real modal scale/translation entrance')
    await click(css(`.theme-option:nth-child(${theme === 'dark' ? 1 : 2})`))
    await wait(`document.documentElement.dataset.theme === '${theme}'`)
    await close('.settings-modal', '.sb-settings')
    for (const [title, selector] of [['Skills', '.capabilities-modal--skills'], ['MCP', '.capabilities-modal--mcp'], ['LLM 性能', '.llm-perf-modal']]) {
      const trigger = `.sb-nav [title="${title}"]`
      await click(css(trigger))
      await wait(`${modalIn(selector)}?.effect.getTiming().duration === 260`)
      await close(selector, trigger)
    }
  }
  check(closeTimes.some(result => result.nativeAnimationEnd), 'Modal animationend was not exercised by real compositor frames')
  for (const path of ['escape', 'backdrop']) {
    await click(css('.sb-settings'))
    await wait(`${css('.settings-modal')} != null`)
    await close('.settings-modal', '.sb-settings', path)
  }

  // Same boolean-owned modal must actually remount, not retain its closed hook.
  await click(css('.sb-settings'))
  await wait(`${css('.settings-modal')} != null`)
  await read(`window.oldSettings = ${css('.settings-modal')}.parentElement`)
  await click(css('.settings-modal .modal-x'))
  await wait(`window.oldSettings.dataset.state === 'exit'`)
  await click(css('.sb-settings'))
  await wait(`${css('.settings-modal')}?.parentElement.dataset.state === 'enter'`)
  check(await read(`!window.oldSettings.isConnected && ${css('.settings-modal')}.parentElement !== window.oldSettings`), 'Reopening settings retained the old exiting instance')
  await wait(`${css('.settings-modal')}.getAnimations().every(animation => animation.playState === 'finished')`)
  check(await read(`${css('.settings-modal')}.contains(document.activeElement)`), 'Old cleanup stole replacement focus')
  await close('.settings-modal', '.sb-settings')

  await click(css('.sb-settings'))
  await wait(`${css('.settings-modal')} != null`)
  await read(`window.oldSettings = ${css('.settings-modal')}.parentElement`)
  await click(css('.settings-modal .modal-x'))
  await wait(`window.oldSettings.dataset.state === 'exit'`)
  await click(css('.sb-nav [title="Skills"]'))
  await wait(`${css('.capabilities-modal--skills')} != null`)
  check(await read(`!window.oldSettings.isConnected && ${css('.capabilities-modal--skills')}.contains(document.activeElement)`), 'A new modal waited for or lost focus to its old exit')
  await close('.capabilities-modal--skills', '.sb-nav [title="Skills"]')

  await click(css('.sb-settings'))
  await wait(`${css('.settings-modal')} != null`)
  await read(`window.oldSettings = ${css('.settings-modal')}.parentElement`)
  await click(css('.settings-modal .modal-x'))
  await wait(`window.oldSettings.dataset.state === 'exit'`)
  // Window capture runs before the presence document capture flushes the old DOM.
  await read(`window.exitPointerProof = null; window.addEventListener('pointerdown', event => { window.exitPointerProof = { connected: window.oldSettings.isConnected, exiting: window.oldSettings.dataset.state === 'exit', row: Boolean(event.target.closest('button.sb-sess')) }; }, { once: true, capture: true })`)
  await click(`Array.from(document.querySelectorAll('button.sb-sess')).find(node => node.textContent.includes('cache-b'))`)
  await wait(`Array.from(document.querySelectorAll('button.sb-sess')).some(node => node.textContent.includes('cache-b') && node.getAttribute('aria-current') === 'true')`)
  check(await read(`window.exitPointerProof.connected && window.exitPointerProof.exiting && window.exitPointerProof.row`), 'First native row click did not pass through still-mounted exit DOM')

  await click(css('.sb-new'))
  await wait(`${css('.runtime-composer textarea')} != null`)
  if (await read(`document.querySelector('.app').classList.contains('right-panel-hidden') || !document.getElementById('right-surface-pane')`)) await click(css('.panel-pill:not(.summary-pill)'))
  const plus = '[data-session-surface-current="true"] .surface-add-wrap > button'
  await wait(`${css(plus)} != null && !document.getAnimations().some(animation => animation.id === 'scry-pane')`)
  await click(css(plus))
  await wait(`${css('.surface-menu')}?.getAnimations().some(animation => animation.effect.getTiming().duration === 160)`)
  check(await read(`getComputedStyle(${css('.surface-menu')}).transformOrigin.includes('0px')`), 'Surface menu has no top-edge origin')
  key('Escape')
  await wait(`${css('.surface-menu')}?.dataset.state === 'exit'`)
  check(await read(`${css('.surface-menu')}.getAnimations().some(animation => animation.effect.getTiming().duration === 100)`), 'Surface menu exit is not 100ms')
  await wait(`${css('.surface-menu')} == null`)
  const surfaceFocus = await read(`(() => {
    const target = ${css(plus)}, active = document.activeElement
    if (active === target) return { restored: true }
    const describe = node => node ? { tag: node.tagName, id: node.id, class: node.getAttribute('class')?.slice(0, 160) } : null
    return { restored: false, target: describe(target), active: describe(active), focused: document.hasFocus(),
      inert: describe(target?.closest('[inert]')), surfaces: document.querySelectorAll('[data-session-surface-current="true"]').length }
  })()`)
  check(surfaceFocus.restored, 'Surface menu did not restore its trigger; snapshot=' + JSON.stringify(surfaceFocus))

  // Static baseline, then open the SAME production components beneath a real
  // page transform. Read layout offsets so their own 6px entrance isn't a false failure.
  await wait(`!document.getAnimations().some(animation => animation.id === 'scry-structure')`)
  await click(css('#probe-both'))
  await wait(`${css('.probe-modal')} != null && ${css('.sb-session-menu')} != null`)
  const layout = `(() => { const dialog = ${css('.probe-modal')}; const overlay = dialog.parentElement.getBoundingClientRect(); const menu = ${css('.sb-session-menu')}.getBoundingClientRect(); return { dialog: [dialog.offsetLeft, dialog.offsetTop, dialog.offsetWidth, dialog.offsetHeight], overlay: [overlay.x, overlay.y, overlay.width, overlay.height], menu: [menu.left, menu.top] }; })()`
  const baseline = await read(layout)
  key('Escape')
  await wait(`${css('.probe-modal')} == null && ${css('.sb-session-menu')} == null`)
  await click(css('.sb-nav .sb-navitem'))
  await wait(`document.getAnimations().some(animation => animation.id === 'scry-structure' && animation.currentTime < 100) && ${css('#probe-both')}?.closest('.main-content') != null`)
  await click(css('#probe-both'))
  await wait(`${css('.probe-modal')} != null && ${css('.sb-session-menu')} != null`)
  const openedAt = await read(`Number(document.getElementById('overlay-probe-host').dataset.openTime)`)
  check(openedAt >= 0 && openedAt <= 100, `Placement probes opened ${openedAt}ms into the page entrance`)
  check(await read(`getComputedStyle(document.querySelector('.main-content')).transform !== 'none'`), 'Placement check waited out the page transform')
  const animated = await read(layout)
  for (const field of ['dialog', 'overlay', 'menu']) check(animated[field].every((value, index) => Math.abs(value - baseline[field][index]) <= 1), `${field} moved under the page transform: ${JSON.stringify({ baseline, animated })}`)
  key('Escape')
  await wait(`${css('.probe-modal')} == null && ${css('.sb-session-menu')} == null`)

  await click(css('#probe-modal'))
  await wait(`${css('.probe-modal')} != null`)
  await click(css('#probe-nested'))
  await wait(`document.activeElement === ${css('.probe-nested-modal input')}`)
  await read(`window.overlayFixture.setBusy(true)`)
  await wait(`window.overlayFixture.busy === true`)
  check(await read(`document.activeElement === ${css('.probe-nested-modal input')}`), 'Changing parent pending guard stole nested focus')
  await contents.insertText('nested first input')
  check(await read(`${css('.probe-nested-modal input')}.value === 'nested first input'`), 'Nested modal lost native input')
  key('Escape')
  await wait(`${css('.probe-nested-modal')} == null`)
  check(await read(`${css('.probe-modal')}.parentElement.dataset.state === 'enter' && document.activeElement === ${css('#probe-nested')}`), 'Nested close dismissed or failed to refocus its parent')
  key('Escape')
  await read(`new Promise(resolve => requestAnimationFrame(resolve))`)
  check(await read(`${css('.probe-modal')}.parentElement.dataset.state === 'enter'`), 'Pending guard started an invisible/inert exit')
  await read(`window.overlayFixture.setBusy(false)`)
  await wait(`window.overlayFixture.busy === false`)
  key('Escape')
  await wait(`${css('.probe-modal')} == null`)
  await click(css('#probe-modal'))
  await wait(`${css('.probe-modal')} != null`)
  await read(`window.directHideNode = ${css('.probe-modal')}.parentElement; window.overlayFixture.hide()`)
  await wait(`!window.directHideNode.isConnected`)
  check(await read(`window.directHideNode.dataset.state === 'enter'`), 'Parent-driven removal was forced through exit')

  await click(css('#probe-both'))
  for (const selector of ['.probe-modal', '.sb-session-menu']) {
    await wait(`${css(selector)} != null && ${css(selector)}.getAnimations().every(animation => animation.playState === 'finished')`)
    const settled = await read(`(() => { const node = ${css(selector)}; return { transform: getComputedStyle(node).transform, finishedEntrances: node.getAnimations().filter(animation => animation.playState === 'finished' && ['modal-dialog-in', 'overlay-menu-in'].includes(animation.animationName)).length }; })()`)
    check(settled.transform === 'none' && settled.finishedEntrances === 0,
      `Entrance retained transform or finished animation on ${selector}: ${JSON.stringify(settled)}`)
  }
  key('Escape')
  await wait(`${css('.probe-modal')} == null && ${css('.sb-session-menu')} == null`)

  contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click(css('.sb-settings'))
    await wait(`${modalIn('.settings-modal')}?.effect.getTiming().duration === 120`)
    check(await read(framesOnlyOpacity(`${css('.settings-modal')}.getAnimations()`)), 'Reduced modal entrance includes spatial motion')
    key('Escape')
    await wait(`${css('.settings-modal')}?.parentElement.dataset.state === 'exit'`)
    check(await read(framesOnlyOpacity(`[...${css('.settings-modal')}.getAnimations(), ...${css('.settings-modal')}.parentElement.getAnimations()]`)), 'Reduced modal exit includes spatial motion')
    await wait(`${css('.settings-modal')} == null`)
    await click(css('.sb-new'))
    await wait(`${css(plus)} != null && !document.getAnimations().some(animation => animation.id === 'scry-pane')`)
    await click(css(plus))
    await wait(`${css('.surface-menu')}?.getAnimations().some(animation => animation.effect.getTiming().duration === 120)`)
    check(await read(framesOnlyOpacity(`${css('.surface-menu')}.getAnimations()`)), 'Reduced menu entrance includes spatial motion')
    key('Escape')
    await wait(`${css('.surface-menu')}?.dataset.state === 'exit'`)
    check(await read(framesOnlyOpacity(`${css('.surface-menu')}.getAnimations()`)), 'Reduced menu exit includes spatial motion')
    await wait(`${css('.surface-menu')} == null`)
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    contents.debugger.detach()
  }
  return { themes: ['light', 'dark'], dialogEntrance260: true, closeTimes, focusRestoredAtExitStart: true,
    threeClosePaths: true, firstNativeRowClickDuringExit: true, sameModalReopened: true, replacementImmediate: true,
    menuEnter160Exit100: true, placementDuringPageTransformAtMs: openedAt, placementMatchesStatic: true,
    pendingAndNestedFocusPreserved: true, parentRemovalImmediate: true, reducedOpacityOnly: true,
    settledEntrancesReleaseTransformAndAnimations: true }
}
