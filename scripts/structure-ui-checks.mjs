// Full production renderer; native input, controlled asynchronous history, real live-DOM animations.
export async function exerciseStructure(contents) {
  const read = expression => contents.executeJavaScript(expression)
  const check = (condition, message) => { if (!condition) throw new Error(`Structure: ${message}`) }
  const wait = async expression => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Structure condition timed out: ${expression}`)
      await new Promise(resolve => setTimeout(resolve, 16))
    }
  }
  const click = async expression => {
    const point = await read(`(() => { const node = ${expression}; if (!node) throw new Error('Missing native target'); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const p = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; if (!node.contains(document.elementFromPoint(p.x, p.y))) throw new Error('Occluded native target'); return p; })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const row = id => `Array.from(document.querySelectorAll('button.sb-sess')).find(node => node.textContent.includes('${id}'))`
  const control = id => click(`document.getElementById('${id}')`)
  const pending = id => wait(`JSON.parse(document.getElementById('cache-state').textContent).pending.includes('${id}')`)
  const body = id => `document.querySelector('.chat-transcript')?.textContent.includes('Authoritative ${id}')`
  const entries = `document.getAnimations().filter(a => a.id === 'scry-structure')`
  const entry = `${entries}[0]`
  await wait(`document.querySelectorAll('button.sb-sess').length === 2`)
  await read(`window.nativeCaptureCalls = 0; document.startViewTransition = () => { window.nativeCaptureCalls++; throw new Error('Native capture forbidden by approved live-DOM contract') }; window.structureEntries = []; const animate = Element.prototype.animate; Element.prototype.animate = function(...args) { const animation = animate.apply(this, args); if (this.matches('.main-content')) window.structureEntries.push(animation); return animation; }; undefined`)
  await click(row('cache-a'))
  await pending('cache-a')
  await control('resolve-a')
  await wait(`${entry}?.effect.getTiming().duration === 180`)
  await click(`document.querySelector('.runtime-composer textarea')`)
  await read(`new Promise(resolve => requestAnimationFrame(() => resolve(true)))`)
  await contents.insertText('live input during entrance')
  check(await read(`document.activeElement === document.querySelector('.runtime-composer textarea') && document.querySelector('.runtime-composer textarea').value === 'live input during entrance'`), 'First click or input was blocked during live entrance')
  await wait(`${entries}.length === 0`)
  check(await read(`(() => { const page = document.querySelector('.main-content'); return page.contains(document.querySelector('.runtime-composer')) && page.getBoundingClientRect().top >= document.querySelector('.topbar').getBoundingClientRect().bottom; })()`), 'Entry excludes composer or includes chrome')
  await click(`document.querySelector('.sb-nav .sb-navitem')`)
  await wait(`${entry}?.effect.getTiming().duration === 240`)
  check(await read(`${entry}.effect.getKeyframes().some(frame => frame.transform?.includes('6px'))`), 'Page entrance has no real 6px translation')
  await read(`window.structureFirstFrame = null; document.addEventListener('click', () => requestAnimationFrame(() => { window.structureFirstFrame = { selected: ${row('cache-b')}?.getAttribute('aria-current') === 'true', unresolved: !${body('cache-b')} }; }), { once: true })`)
  await click(row('cache-b'))
  await wait(`window.structureFirstFrame != null`)
  check(await read(`window.structureFirstFrame.selected && window.structureFirstFrame.unresolved`), 'Sidebar selection waited for history')
  await pending('cache-b')
  await control('resolve-b')
  await wait(`${entry}?.effect.getTiming().duration === 180`)
  check(await read(`${entry}.effect.getKeyframes().every(frame => !frame.transform || frame.transform === 'none')`), 'Session entry translated spatially')
  await wait(`${entries}.length === 0`)

  await click(row('cache-a'))
  await pending('cache-a')
  await read(`window.previousEntry = ${entry}`)
  await click(row('cache-b'))
  await pending('cache-b')
  check(await read(`window.previousEntry?.playState === 'idle'`), 'Rapid selection did not cancel the prior animation')
  await control('resolve-a')
  check(await read(body('cache-b')), 'Late A history overwrote selected B')
  await control('resolve-b')
  await wait(`${entries}.length === 0 && ${body('cache-b')}`)

  const entryCount = `window.structureEntries.filter(animation => animation.id === 'scry-structure').length`
  await control('update-a')
  await click(`document.querySelector('.sb-nav .sb-navitem')`)
  await wait(`document.querySelector('.usage-page') && ${entries}.length === 0`)
  await read(`window.structureEntries = []`)
  await click(row('cache-a'))
  await pending('cache-a')
  check(await read(`document.querySelector('.chat-transcript').textContent.includes('Authoritative cache-a v1') && ${entryCount} === 1`), 'Stale cached A did not enter exactly once')
  check(await read(`${entry}?.effect.target === document.querySelector('.main-content')`), 'Cached navigation entrance targets detached old page')
  await control('resolve-a')
  await wait(`document.querySelector('.chat-transcript').textContent.includes('Authoritative cache-a v2')`)
  check(await read(`${entryCount} === 1`), 'Stale cache refresh replayed the session entrance')
  await wait(`${entries}.length === 0`)
  await read(`window.structureEntries = []`)
  await click(row('cache-a'))
  await pending('cache-a')
  await control('resolve-a')
  await wait(`${body('cache-a')} && !JSON.parse(document.getElementById('cache-state').textContent).pending.length`)
  check(await read(`${entryCount} === 0`), 'Same-session refresh replayed entrance')
  await control('focus-live-b')
  await pending('cache-b')
  await control('resolve-b')
  await wait(`${entries}.length === 0`)
  await read(`window.structureEntries = []`)
  await control('focus-live-b')
  await pending('cache-b')
  await control('resolve-b')
  await wait(`!JSON.parse(document.getElementById('cache-state').textContent).pending.length`)
  check(await read(`${entryCount} === 0`), 'Focus on the presented session replayed entrance')
  await click(`document.querySelector('.sb-new')`)
  await wait(`${entries}.length === 0`)
  await read(`window.structureEntries = []`)
  await click(row('cache-b'))
  await pending('cache-b')
  await control('resolve-b')
  await wait(`${body('cache-b')} && ${entries}.length === 0`)
  check(await read(`${entryCount} === 1`), 'New conversation did not reset the presented session identity')

  contents.debugger.attach('1.3')
  try {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await click(`document.querySelector('.sb-nav .sb-navitem')`)
    await wait(`${entry}?.effect.getTiming().duration === 120`)
    check(await read(`${entry}.effect.getKeyframes().every(frame => (!frame.transform || frame.transform === 'none') && frame.width == null && frame.height == null)`), 'Reduced entry is not opacity-only')
    await wait(`${entries}.length === 0`)
    check(await read(`document.querySelector('.usage-page') != null && window.nativeCaptureCalls === 0`), 'Latest navigation failed or used native capture')
  } finally {
    await contents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    contents.debugger.detach()
  }
  return { page240: true, belowChromeIncludesComposer: true, firstClickAndInputDuringEntry: true,
    selectionFirstFrame: true, session180NoTranslation: true, rapidCancellation: true, staleHistoryRejected: true,
    cachedNavigationTargetsLivePage: true, staleCacheOnlyOneEntrance: true, sameSessionRefreshNoEntrance: true, sameSessionFocusNoEntrance: true,
    newConversationResetsIdentity: true, reduced120OpacityOnly: true, nativeCaptureCalls: 0 }
}
