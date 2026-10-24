export async function exerciseStructureApp(cdp, evaluate) {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const captures = mkdtempSync(join(tmpdir(), 'scry-structure-app-'))
  const check = (condition, message) => { if (!condition) throw new Error(`Structure App: ${message}`) }
  const wait = expression => evaluate(`(async () => { const deadline = Date.now() + 15000; while (!(${expression})) { if (Date.now() > deadline) throw new Error('Structure App state: ' + ${JSON.stringify(expression)}); await new Promise(resolve => setTimeout(resolve, 25)); } })()`)
  const pointFor = async selector => {
    await wait(`document.querySelector(${JSON.stringify(selector)}) != null`)
    let point
    try {
      point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; const hit = document.elementFromPoint(p.x, p.y); if (!node.contains(hit)) throw new Error('Occluded structure target: ' + JSON.stringify({ selector: ${JSON.stringify(selector)}, rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 700), viewport: [innerWidth, innerHeight], main: document.getElementById('main-pane').getBoundingClientRect().toJSON(), page: document.querySelector('.main-content').getBoundingClientRect().toJSON(), activeTransition: document.documentElement.dataset.vt, animations: document.getAnimations().map(a => ({ id: a.id, pseudo: a.effect?.pseudoElement })), pointer: getComputedStyle(node).pointerEvents, visibility: getComputedStyle(node).visibility, inert: node.closest('[inert]')?.outerHTML.slice(0, 100) })); return p; })()`)
    } catch (error) {
      await capture('occluded-target')
      console.error('Structure App diagnostic capture:', captures)
      throw error
    }
    return point
  }
  const click = async selector => {
    const point = await pointFor(selector)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const key = async (key, code = key) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key === 'Enter' ? 13 : 27 })
  }
  const capture = async name => {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(captures, `${name}.png`), Buffer.from(result.data, 'base64'))
  }
  const settleEntrance = async selector => {
    // A real hidden App needs a compositor paint to start composited CSS animations.
    // Do not seek/finish animations or change production timing for screenshots.
    await cdp.send('Page.captureScreenshot', { format: 'png' })
    await wait(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node && [...node.getAnimations(), ...node.closest('.modal-overlay').getAnimations()].every(a => a.playState === 'finished'); })()`)
  }
  const closeModal = async (selector, trigger) => {
    await evaluate(`{
      const node = document.querySelector(${JSON.stringify(selector)}).closest('.modal-overlay');
      window.structureCloseStart = null; window.structureCloseEnd = null; window.structureCloseNativeEnd = false;
      node.addEventListener('animationend', event => { if (event.target === node) window.structureCloseNativeEnd = true });
      document.addEventListener('keydown', () => { window.structureCloseStart = performance.now() }, { once: true, capture: true });
      const observer = new MutationObserver(() => { if (!node.isConnected) { window.structureCloseEnd = performance.now(); observer.disconnect() } });
      observer.observe(document.body, { childList: true, subtree: true });
    }`)
    await key('Escape')
    check(await evaluate(`document.querySelector(${JSON.stringify(selector)})?.closest('.modal-overlay').dataset.state === 'exit' && document.activeElement === document.querySelector(${JSON.stringify(trigger)})`), 'Exit did not immediately restore its trigger focus')
    await cdp.send('Page.captureScreenshot', { format: 'png' })
    await wait(`document.querySelector(${JSON.stringify(selector)}) == null && window.structureCloseEnd != null`)
    const ms = await evaluate('window.structureCloseEnd - window.structureCloseStart')
    check(ms <= 250, `Modal DOM exit exceeded the Step03 limit: ${ms}ms`)
    return { ms, nativeAnimationEnd: await evaluate('window.structureCloseNativeEnd') }
  }
  const panes = `document.getAnimations().filter(a => a.id === 'scry-pane')`
  const page = `document.getAnimations().find(a => a.id === 'scry-structure')`
  const idle = () => wait(`!${page} && ${panes}.length === 0`)
  await wait(`document.querySelector('button.sb-sess') != null`)
  check(await evaluate(`!${page}`), 'Startup theme animated')
  await evaluate(`window.nativeCaptureCalls = 0; document.startViewTransition = () => { window.nativeCaptureCalls++; throw new Error('Native capture forbidden') }`)
  await click('button.sb-sess')
  await click('.sb-new')
  await idle()
  await click('.runtime-composer textarea')
  await cdp.send('Input.insertText', { text: 'structure App acceptance' })
  await wait(`document.querySelector('.send')?.disabled === false`)
  await click('.send')
  await wait(`document.querySelector('.tool-group-row') != null && document.querySelector('.stop') == null`)
  await click('.runtime-composer textarea')
  await cdp.send('Input.insertText', { text: 'structure unsent draft' })
  const closeTimes = []
  for (const theme of ['light', 'dark']) {
    await click('.sb-settings')
    await click(`.theme-option:nth-child(${theme === 'dark' ? 1 : 2})`)
    await wait(`document.documentElement.dataset.theme === '${theme}'`)
    check(await evaluate(`!${page} && window.nativeCaptureCalls === 0`), 'Theme was not immediate live DOM')
    await settleEntrance('.settings-modal')
    await capture(`${theme}-settings`)
    closeTimes.push({ theme, modal: 'settings', ...await closeModal('.settings-modal', '.sb-settings') })
    for (const [title, selector, name] of [
      ['Skills', '.capabilities-modal--skills', 'skills'],
      ['MCP', '.capabilities-modal--mcp', 'mcp'],
      ['LLM 性能', '.llm-perf-modal', 'llm-performance']
    ]) {
      const trigger = `.sb-navitem[title="${title}"]`
      await click(trigger)
      await wait(`document.querySelector('${selector}') != null`)
      check(await evaluate(`document.querySelector('${selector}').getAnimations().some(a => a.effect.getTiming().duration === 260)`), 'Modal entrance timing differs in the production App')
      await settleEntrance(selector)
      await capture(`${theme}-${name}`)
      closeTimes.push({ theme, modal: name, ...await closeModal(selector, trigger) })
    }

    if (await evaluate(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') !== 'true'`)) {
      await click('.panel-pill:not(.summary-pill)')
      await wait(`document.querySelector('.panel-pill:not(.summary-pill)').getAttribute('aria-pressed') === 'true'`)
      await idle()
    }
    await click('.panel-pill:not(.summary-pill)')
    await wait(`document.querySelector('.app.right-panel-hidden') != null && ${panes}.length > 0`)
    check(await evaluate(`document.querySelector('#right-surface-pane[data-pane-leaving]')?.inert === true && getComputedStyle(document.querySelector('#right-surface-pane')).pointerEvents === 'none'`), 'Outgoing pane retained interaction authority')
    check(await evaluate(`(async () => { const widths = []; for (let i = 0; i < 4; i++) { await new Promise(requestAnimationFrame); widths.push(document.getElementById('main-pane').getBoundingClientRect().width); } return widths.every(width => width === widths[0]); })()`), 'F interpolated transcript width')
    await click('.panel-pill:not(.summary-pill)')
    await wait(`document.querySelector('.app.right-panel-hidden') == null`)
    await idle()
    await click('#right-surface-pane [data-session-surface-current="true"] [aria-label="最大化右侧工作区"]')
    await idle()
    check(await evaluate(`document.querySelector('.app.right-panel-maximized') != null && getComputedStyle(document.getElementById('main-pane')).display === 'none'`), 'Panel maximize failed')
    await capture(`${theme}-maximized`)
    await click('#right-surface-pane [data-session-surface-current="true"] [aria-label="恢复右侧工作区"]')
    await idle()

    await evaluate(`document.querySelector('.sidebar-resizer').focus()`)
    await key('Enter')
    await wait(`document.querySelector('.app.sidebar-collapsed') != null`)
    check(await evaluate(`document.getElementById('main-pane').getBoundingClientRect().left < 10`), 'Leaving sidebar displaced the live grid')
    await key('Enter')
    await wait(`document.querySelector('.app.sidebar-collapsed') == null`)
    await idle()
    await click('#right-surface-pane [data-session-surface-current="true"] [aria-label="添加 Surface"]')
    await wait(`document.querySelector('.surface-menu[data-state="enter"]') != null`)
    check(await evaluate(`document.querySelector('.surface-menu').getAnimations().some(a => a.effect.getTiming().duration === 160)`), 'Surface menu entrance is not 160ms')
    await cdp.send('Page.captureScreenshot', { format: 'png' })
    await wait(`document.querySelector('.surface-menu').getAnimations().every(a => a.playState === 'finished')`)
    await capture(`${theme}-surface-menu`)
    await key('Escape')
    check(await evaluate(`document.querySelector('.surface-menu')?.dataset.state === 'exit' && document.querySelector('.surface-menu').getAnimations().some(a => a.effect.getTiming().duration === 100)`), 'Surface menu exit is not 100ms')
    await wait(`document.querySelector('.surface-menu') == null`)
    const hoverPoint = await pointFor('button.sb-sess')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...hoverPoint })
    await wait(`document.querySelector('.session-hover-card') != null`)
    check(await evaluate(`document.querySelector('.session-hover-card').getAnimations().some(a => a.effect.getTiming().duration === 160)`), 'Hover card entrance is not 160ms')
    await cdp.send('Page.captureScreenshot', { format: 'png' })
    await wait(`document.querySelector('.session-hover-card').getAnimations().every(a => a.playState === 'finished')`)
    await capture(`${theme}-hover-card`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await pointFor('.sb-settings') })
    await wait(`document.querySelector('.session-hover-card') == null`)
    await capture(`${theme}-chat`)
    await click('.sb-nav .sb-navitem:first-child')
    await wait(`${page}?.effect.getTiming().duration === 240`)
    await idle()
    await capture(`${theme}-analytics`)
    await click('.sb-nav .sb-navitem:last-child')
    await wait(`document.querySelector('.meta-prompts-view') != null`)
    await idle()
    await capture(`${theme}-meta-prompts`)
    await click('button.sb-sess')
    await wait(`document.querySelector('.runtime-composer textarea')?.value === 'structure unsent draft'`)
    await idle()
    await click('.sb-new')
    await wait(`${page}?.effect.getTiming().duration === 180`)
    await wait(`document.querySelector('.tool-group-row') == null`)
    await idle()
    await click('button.sb-sess')
    await wait(`document.querySelector('.runtime-composer textarea')?.value === 'structure unsent draft'`)
    await idle()
  }
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    await click('.panel-pill:not(.summary-pill)')
    await wait(`${panes}.length > 0`)
    check(await evaluate(`${panes}.every(a => a.effect.getTiming().duration === 120 && a.effect.getKeyframes().every(frame => !frame.transform || frame.transform === 'none'))`), 'Reduced F pane retained spatial animation')
    await idle()
    await click('.panel-pill:not(.summary-pill)')
    await idle()
  } finally { await cdp.send('Emulation.setEmulatedMedia', { features: [] }) }
  return { test: 'structure production App', themes: ['light', 'dark'], page240: true, newConversation180: true,
    metaPrompts: true, paneFallbackF: true, transcriptWidthCommittedOnce: true, interruptedPane: true, maximizeRestore: true,
    sidebarKeyboardFoldRestore: true, reducedPane120OpacityOnly: true, themeImmediate: true, nativeCaptureCalls: 0, modalCloseTimes: closeTimes,
    nativeSend: true, unsentDraftRetained: true, overlays: { settingsSkillsMcpLlm: true, surfaceMenu160And100: true, hoverCard160: true, focusRestoredBeforeUnmount: true }, captures }
}
