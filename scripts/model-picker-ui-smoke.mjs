import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-model-picker-'))

async function exercise(contents, screenshot) {
  const read = (expression) => contents.executeJavaScript(expression)
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Model picker timed out: ${expression}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const check = async (expression, message) => {
    if (!await read(expression)) throw new Error(message)
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
      node.scrollIntoView({ block: 'nearest' });
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`)
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    await wait(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${point.x}, ${point.y}))`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const key = (keyCode) => {
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    if (keyCode === 'Return') contents.sendInputEvent({ type: 'char', keyCode: '\r' })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const openModels = async () => {
    await click('.model-effort-trigger')
    await wait(`document.querySelector('.model-effort-current') != null`)
    await click('.model-effort-current')
    await wait(`document.activeElement === document.querySelector('.model-effort-search')`)
  }
  const search = async (query) => {
    await wait(`document.activeElement === document.querySelector('.model-effort-search')`)
    contents.selectAll()
    await wait(`(() => { const input = document.querySelector('.model-effort-search'); return input.selectionStart === 0 && input.selectionEnd === input.value.length })()`)
    await contents.insertText(query)
    await wait(`document.querySelector('.model-effort-search').value === ${JSON.stringify(query)}`)
  }
  const options = `document.querySelectorAll('.model-effort-list [role="option"]')`
  const groups = `document.querySelectorAll('.model-effort-list [role="group"]')`
  contents.focus()
  await wait(`document.querySelector('.sb-proj-new') != null`)
  await check(`window.matchMedia('(prefers-reduced-motion: reduce)').matches === false`,
    'The popover motion cannot be measured with reduced motion forced on')
  const installAnimateProbe = `(() => {
    window.__popoverMorphs = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (this.classList?.contains('model-effort-popover')) window.__popoverMorphs.push({ from: keyframes[0]?.width, to: keyframes[1]?.width, duration: options?.duration });
      return original.call(this, keyframes, options);
    };
    window.__restoreAnimate = () => { Element.prototype.animate = original };
  })()`
  await read(installAnimateProbe)
  await click('.sb-proj-new')
  await wait(`document.querySelector('.model-effort-trigger')?.disabled === false`)
  await click('.model-effort-trigger')
  await wait(`document.querySelector('.model-effort-current') != null`)
  // Opening the picker is not a hand-over: the summary must not slide in as if the
  // user came back from the model list.
  await check(`getComputedStyle(document.querySelector('.model-effort-view')).animationName === 'none'`,
    'The summary slid in on the first mount of the picker')
  await click('.model-effort-current')
  await wait(`document.activeElement === document.querySelector('.model-effort-search')`)
  await wait(`${options}.length === 6 && ${groups}.length === 2`)
  // The popover must hand over between its two layers, not swap them: the box morphs
  // from the summary size to the list size, growing from the trigger corner.
  await wait(`(() => {
    const popover = document.querySelector('.model-effort-popover');
    return popover != null && popover.getAnimations().every(animation => animation.playState !== 'running');
  })()`)
  const morphology = await read(`(() => {
    const morphs = window.__popoverMorphs ?? [];
    const last = morphs.at(-1);
    const popover = document.querySelector('.model-effort-popover');
    const rect = popover.getBoundingClientRect();
    return {
      count: morphs.length,
      from: last?.from, to: last?.to, duration: last?.duration,
      width: rect.width, height: rect.height,
      state: popover.dataset.state,
      origin: getComputedStyle(popover).transformOrigin
    };
  })()`)
  if (morphology.count !== 1) throw new Error('Drill-in did not morph the popover box: ' + JSON.stringify(morphology))
  const [fromWidth, toWidth] = [parseFloat(morphology.from), parseFloat(morphology.to)]
  if (!(toWidth > fromWidth) || Math.abs(toWidth - morphology.width) > 1) throw new Error('Morph did not grow to the list width: ' + JSON.stringify(morphology))
  if (morphology.duration !== 200) throw new Error('Popover morph duration drifted: ' + JSON.stringify(morphology))
  if (morphology.state !== 'enter') throw new Error('Open popover is missing its entry state: ' + JSON.stringify(morphology))
  const [originX, originY] = morphology.origin.split(' ').map(parseFloat)
  if (Math.abs(originX - morphology.width) > 1 || Math.abs(originY - morphology.height) > 1) throw new Error('Popover does not grow from the trigger corner: ' + JSON.stringify(morphology))
  await read('window.__restoreAnimate()')
  // Synthetic composing events check the guard; native OS IME candidate UI is not simulated.
  await check(`(() => {
    const input = document.querySelector('.model-effort-search');
    for (const key of ['ArrowDown', 'Escape']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
      if (!input.dispatchEvent(event) || document.activeElement !== input) return false;
    }
    return true;
  })()`, 'IME navigation/dismissal was intercepted by the model picker')
  await check(`document.querySelector('[role="group"][aria-label="provider-a"]').querySelectorAll('[role="option"]').length === 2`, 'Provider group lost an option')
  await check(`document.querySelector('[role="group"][aria-label="provider-b"] [role="option"]').textContent === 'Shared Model'`, 'Cross-provider duplicates gained a redundant ID suffix')
  await search('  SHARED-ID  ')
  await wait(`${options}.length === 2 && ${groups}.length === 2`)
  await search('INTERNAL-42')
  await wait(`${options}.length === 1 && document.querySelector('.model-effort-list [role="option"]').textContent === 'Friendly Name'`)
  await search('nothing-matches')
  await wait(`${options}.length === 0 && document.querySelector('.model-effort-search-status').textContent === '没有匹配的模型'`)
  await click('.model-effort-clear')
  await wait(`${options}.length === 6 && document.activeElement === document.querySelector('.model-effort-search')`)
  await search('PROVIDER-B shared')
  await wait(`${options}.length === 1 && ${groups}.length === 1`)
  key('Down')
  await wait(`document.activeElement?.getAttribute('role') === 'option'`)
  await read(installAnimateProbe)
  key('Return')
  await wait(`getComputedStyle(document.querySelector('.model-effort-view')).animationName === 'popover-view-back'`)
  await wait(`document.querySelector('.model-effort-model').textContent === 'provider-b / Shared Model' && document.querySelector('.model-effort-current') != null`)
  // The hand-over back to the summary arrives from the other side, and the animation
  // only lives for the swap itself.
  await wait(`getComputedStyle(document.querySelector('.model-effort-view')).animationName === 'none'`)
  // A second hand-over in a row must measure the settled box, not the previous
  // morph's animating width; otherwise it animates the list box onto itself and the
  // summary snaps back at the end.
  const shrinking = await read(`(async () => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (window.__popoverMorphs ?? []).length === 0) await new Promise(resolve => requestAnimationFrame(resolve));
    const morph = (window.__popoverMorphs ?? []).at(-1);
    const popover = document.querySelector('.model-effort-popover');
    while (Date.now() < deadline && popover.getAnimations().some(animation => animation.playState === 'running')) await new Promise(resolve => requestAnimationFrame(resolve));
    window.__restoreAnimate();
    return { from: morph?.from, to: morph?.to, width: popover.offsetWidth };
  })()`)
  if (!shrinking.from) throw new Error('Returning to the summary did not morph the box: ' + JSON.stringify(shrinking))
  if (!(parseFloat(shrinking.from) > parseFloat(shrinking.to) + 50)) throw new Error('The return hand-over did not start from the list width: ' + JSON.stringify(shrinking))
  if (Math.abs(parseFloat(shrinking.to) - shrinking.width) > 1) throw new Error('The return hand-over measured a mid-flight box: ' + JSON.stringify(shrinking))
  await click('.model-effort-trigger')
  await openModels()
  await wait(`document.querySelector('.model-effort-search').value === '' && ${options}.length === 6`)
  await search('shared-id')
  await wait(`document.querySelector('.model-effort-list [aria-selected="true"]')?.getAttribute('aria-label') === 'provider-b / Shared Model'`)
  // Escape retires input immediately but keeps the decorative exit frame.
  await read(`(() => {
    const popover = document.querySelector('.model-effort-popover');
    window.__popoverExit = null;
    window.__closingPopover = popover;
    popover.addEventListener('animationstart', event => {
      if (event.target === popover) window.__popoverExit = { state: popover.dataset.state, inert: popover.inert, animation: event.animationName };
    });
  })()`)
  key('Escape')
  await wait(`window.__popoverExit != null && !window.__closingPopover.isConnected`)
  const exit = await read('window.__popoverExit')
  if (exit.state !== 'exit' || !exit.inert || exit.animation !== 'overlay-menu-out') throw new Error('Popover exit is not the shared overlay exit: ' + JSON.stringify(exit))
  await wait(`document.querySelector('.model-effort-popover') == null && document.activeElement === document.querySelector('.model-effort-trigger')`)
  await click('textarea[aria-label="描述任务"]')
  await wait(`document.activeElement === document.querySelector('textarea[aria-label="描述任务"]')`)
  await contents.insertText('Use the provider-b model')
  await wait(`!document.querySelector('.send').disabled`)
  await click('.send')
  const requests = `JSON.parse(document.querySelector('#model-state').textContent).requests`
  await wait(`${requests}.length === 1`)
  await check(`${requests}[0].model.id === 'shared-id' && ${requests}[0].model.providerId === 'provider-b'`, 'Actual App request lost the selected provider')
  await openModels()
  await search('shared-id')
  if (screenshot) for (const theme of ['dark', 'light']) {
    await read(`(document.documentElement.dataset.theme = '${theme}', new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`)
    const bounds = await read(`(() => {
      const {x,y,width,height} = document.querySelector('.model-effort-popover').getBoundingClientRect();
      return {x:Math.floor(x),y:Math.floor(y),width:Math.ceil(width),height:Math.ceil(height)};
    })()`)
    require('node:fs').writeFileSync(screenshot + '-' + theme + '.png', (await contents.capturePage(bounds, { stayHidden: true, stayAwake: true })).toPNG())
  }
  // Two hand-overs inside one animation window: drilling in and picking a model
  // immediately must start the second morph from the settled list box. Measuring
  // while the previous morph still applies its animated width would animate the
  // list box onto itself and snap the summary back at the end.
  await read(`(() => {
    const popover = document.querySelector('.model-effort-popover')
    if (popover) document.querySelector('.model-effort-trigger').click()
    return true
  })()`)
  await wait(`document.querySelector('.model-effort-popover') == null`)
  await read(installAnimateProbe)
  await click('.model-effort-trigger')
  await wait(`document.querySelector('.model-effort-current') != null`)
  await click('.model-effort-current')
  await wait(`document.querySelector('.model-effort-list [role="option"]') != null`)
  const beforePick = await read(`({ cls: document.querySelector('.model-effort-popover').className, count: document.querySelectorAll('.model-effort-popover').length, width: document.querySelector('.model-effort-popover').offsetWidth })`)
  await click('.model-effort-list [role="option"]')
  // Sample the box while the interrupted hand-over would still be running: with the
  // old order the drill-in animation kept growing the box to the list width after the
  // view had already switched back, then snapped. Whatever the timing, the box must
  // never end up wider than the layer that is showing.
  const interrupted = await read(`(async () => {
    const popover = document.querySelector('.model-effort-popover');
    const samples = [];
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      samples.push(Math.round(popover.offsetWidth));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    window.__restoreAnimate();
    return { samples, settled: Math.round(popover.offsetWidth), summaryVisible: popover.querySelector('.model-effort-current') != null };
  })()`)
  if (!interrupted.summaryVisible) throw new Error('Picking a model during the drill-in did not return to the summary: ' + JSON.stringify(interrupted))
  const widest = Math.max(...interrupted.samples)
  // The second hand-over legitimately starts from whatever width the box has when the
  // click lands, so bound by the width already painted at click time, not by the summary.
  const allowed = Math.max(Number(beforePick.width), interrupted.settled) + 4
  if (widest > allowed) throw new Error('An interrupted hand-over kept growing the box after the view switched back: ' + JSON.stringify({ ...interrupted, beforePick }))
  // A hand-over retired before its view animation ends must not leave the one-shot
  // flag behind: the next open is a first mount again, without a slide.
  await click('.model-effort-current')
  await read(`(() => { document.querySelector('.model-effort-trigger').click(); return true })()`)
  await wait(`document.querySelector('.model-effort-popover') == null`)
  await click('.model-effort-trigger')
  await wait(`document.querySelector('.model-effort-current') != null`)
  await check(`getComputedStyle(document.querySelector('.model-effort-view')).animationName === 'none'`,
    'A stale hand-over animation survived the popover closing mid-morph')
  key('Escape')
  await wait(`document.querySelector('.model-effort-popover') == null`)
  return { providerGroups: true, searchNameIdProvider: true, emptyAndClear: true, keyboard: true, syntheticImeGuard: true, queryReset: true, qualifiedSummary: true, correctProviderInAppRequest: true, interruptedHandover: true, retiredMidMorph: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    worker: { format: 'es' },
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/session-model-smoke.tsx'), formats: ['iife'], name: 'ScryModelPicker', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; worker-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ enableLargerThanScreen: true, show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { 'provider-models': '1' } })
        // This fixture measures the hand-over motion itself, so it pins the media feature
        // instead of inheriting the host setting: CI runners report reduce, where the
        // product deliberately skips these animations. The reduced path is covered by
        // the motion-tokens campaign and by the pane-motion unit test.
        win.webContents.debugger.attach('1.3')
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
        const result = await (${exercise.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_MODEL_PICKER_SCREENSHOT ?? '')})
        console.log('SCRY_UI_SMOKE_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Model picker UI failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
