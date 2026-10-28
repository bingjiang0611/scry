import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { nativeUiPointer } from './native-ui-pointer.mjs'
import { exerciseTranscriptDisplayLock } from './session-display-lock-checks.mjs'
import { exerciseSidebarPerformance } from './session-performance-sidebar-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-session-performance-'))

async function exercise(webContents, pointer) {
  const read = async (expression) => {
    const result = await webContents.executeJavaScript(`(async () => {
      try { return { value: await (${expression}) }; }
      catch (error) { return { error: String(error), stack: error.stack }; }
    })()`)
    if (result.error) throw new Error(`${result.error}\n${result.stack}\nExpression: ${expression}`)
    return result.value
  }
  const wait = (expression) => read(`(async () => {
    const deadline = performance.now() + 8000;
    while (!(${expression})) {
      if (performance.now() > deadline) throw new Error('Condition timed out: ' + ${JSON.stringify(expression)} + '\\n' + JSON.stringify({
        active: document.activeElement?.outerHTML.slice(0, 200), scrollTop: document.querySelector('.chat-transcript').scrollTop,
        selection: { collapsed: window.getSelection()?.isCollapsed, text: window.getSelection()?.toString().slice(0, 120) },
        retained: Array.from(document.querySelectorAll('.transcript-turn:not([data-virtualized])')).slice(0, 30).map(element => ({
          id: element.dataset.runId, top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height,
          expanded: element.querySelector('[aria-expanded="true"], details[open]')?.outerHTML.slice(0, 120)
        }))
      }));
      await new Promise(requestAnimationFrame);
    }
  })()`)
  const click = async (selector) => {
    const point = await read(`(${pointer.toString()})(${JSON.stringify(selector)}, { timeoutMs: 8000, scroll: false, captureReceipt: true })`)
    webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await wait(`window.__nativeUiPointerReceipt != null`)
    const receipt = await read('window.__nativeUiPointerReceipt')
    if (!receipt.trusted || !receipt.targetMatched) throw new Error(`Native pointer missed ${selector}: ${JSON.stringify(receipt)}`)
  }
  await wait(`document.hasFocus()`)
  await wait(`document.querySelectorAll('[data-run-id]').length === 40 && document.querySelectorAll('[data-virtualized]').length > 20`)
  const initialPageMounted = await read(`document.querySelectorAll('.transcript-turn:not([data-virtualized])').length`)
  const viewport = await read(`(() => { const element = document.querySelector('.chat-transcript'); return { width: element.clientWidth, height: element.clientHeight }; })()`)
  if (viewport.width < 600 || viewport.height < 500) throw new Error(`Invalid transcript viewport: ${JSON.stringify(viewport)}`)
  const shortHistoryDisplayUnlocked = await exerciseTranscriptDisplayLock({ read, wait, click })
  await click('#short-heavy')
  await wait(`document.querySelectorAll('[data-run-id]').length === 20 && document.querySelectorAll('[data-virtualized]').length > 10`)
  await read(`document.querySelector('.chat-transcript').scrollTop = 0`)
  await wait(`document.querySelector('[data-run-id="turn-100"] .model-text')?.textContent.includes('Answer 100')`)
  await read(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const shortHeavyMounted = await read(`document.querySelectorAll('.transcript-turn:not([data-virtualized])').length`)
  if (shortHeavyMounted < 1 || shortHeavyMounted > 10) throw new Error(`Invalid settled heavy-history window: ${shortHeavyMounted}`)
  await read(`(() => { const scroller = document.querySelector('.chat-transcript'); scroller.scrollTop = scroller.scrollHeight; })()`)
  await wait(`document.querySelector('[data-run-id="turn-119"] .model-text')?.textContent.includes('Answer 119')`)
  await read(`document.querySelector('.chat-transcript').scrollTop = 0`)
  await wait(`document.querySelector('[data-run-id="turn-100"] .model-text')?.textContent.includes('Answer 100')`)
  await click('#reset-history')
  await wait(`document.querySelectorAll('[data-run-id]').length === 40 && document.querySelectorAll('[data-virtualized]').length > 20`)
  const sidebar = await exerciseSidebarPerformance({ webContents, pointer, read, wait, click })
  await click('#load-older')
  await wait(`document.querySelectorAll('[data-run-id]').length === 80`)
  await click('#load-older')
  await wait(`document.querySelectorAll('[data-run-id]').length === 120 && document.querySelectorAll('[data-virtualized]').length > 60`)
  const mountedAtTop = await read(`document.querySelectorAll('.transcript-turn:not([data-virtualized])').length`)
  if (mountedAtTop >= 40) throw new Error(`Long history retained ${mountedAtTop} mounted turns`)
  await wait(`document.querySelector('[data-run-id="turn-69"]').dataset.virtualized === 'true'`)
  if (!await read(`(() => { const label = document.querySelector('[data-run-id="turn-69"]').getAttribute('aria-label'); return label.length < 120 && label.endsWith('…') })()`)) throw new Error('Hidden turn retained an unbounded prompt label')
  await read(`document.querySelector('[data-run-id="turn-69"]').scrollIntoView({ block: 'start' })`)
  await wait(`document.querySelector('[data-run-id="turn-69"] .bubble-user')?.textContent.includes('long prompt '.repeat(160).trim())`)
  // Materializing variable-height overscan above the viewport must not move its anchor.
  const anchorOffset = await read(`(() => {
    const target = document.querySelector('[data-run-id="turn-60"]');
    target.scrollIntoView({ block: 'start' });
    return target.getBoundingClientRect().top - document.querySelector('.chat-transcript').getBoundingClientRect().top;
  })()`)
  await wait(`document.querySelector('[data-run-id="turn-60"]:not([data-virtualized]) .turn-assistant') != null && Math.abs(document.querySelector('[data-run-id="turn-60"]').getBoundingClientRect().top - document.querySelector('.chat-transcript').getBoundingClientRect().top - ${anchorOffset}) < 2`)
  await click('[data-run-id="turn-60"] .tool-group-row')
  await wait(`document.querySelector('[data-run-id="turn-60"] .tool-group-row').getAttribute('aria-expanded') === 'true'`)
  // Production navigation must take ownership from bottom-follow, materialize
  // virtual neighbors, and keep the user's prompt (not a mid-answer row) aligned.
  await click('#follow')
  await click('#jump')
  const promptAligned = `Math.abs(document.querySelector('[data-run-id="turn-10"] .turn-user').getBoundingClientRect().top - document.querySelector('.chat-transcript').getBoundingClientRect().top - 16) < 2`
  await wait(`document.querySelector('[data-run-id="turn-10"]:not([data-virtualized]) .turn-assistant') != null`)
  await wait(promptAligned)
  await read(`document.querySelector('.chat-transcript').scrollTop += 100`)
  await click('#jump')
  await wait(promptAligned)
  // A late size change above the destination must not invalidate the endpoint.
  await read(`document.querySelector('[data-run-id="turn-9"]').style.minHeight = '1800px'`)
  await wait(promptAligned)
  await wait(`!document.querySelector('.turn-jump-target')`)
  await wait(promptAligned)
  await click('#jump-event')
  await wait(`(() => { const target = document.querySelector('[data-trace-event-id="tool-10"]'); if (!target) return false; const rect = target.getBoundingClientRect(); const chat = document.querySelector('.chat-transcript').getBoundingClientRect(); return Math.abs(rect.top - chat.top - Math.max(0, (chat.height - rect.height) / 2)) < 2; })()`)
  if (await read(`document.querySelector('[data-run-id="turn-10"] .tool-group-row')?.getAttribute('aria-expanded') === 'true'`)) {
    await click('[data-run-id="turn-10"] .tool-group-row')
  }
  await click('#jump')
  await wait(promptAligned)
  await click('#follow')
  await wait(`!document.querySelector('.turn-jump-target') && document.querySelector('.chat-transcript').scrollHeight - document.querySelector('.chat-transcript').scrollTop - document.querySelector('.chat-transcript').clientHeight < 2`)
  await click('#jump')
  await wait(promptAligned)
  const measuredHeight = await read(`document.querySelector('[data-run-id="turn-10"]').getBoundingClientRect().height`)
  // Native reader input releases the temporary navigation anchor. Selection
  // must still retain the evidence when ordinary scrolling moves to the tail.
  const navigationWheel = await read(`(() => { const r = document.querySelector('.chat-transcript').getBoundingClientRect(); return { x: Math.round(r.right - 30), y: Math.round(r.top + 200) }; })()`)
  webContents.sendInputEvent({ type: 'mouseWheel', deltaY: -100, deltaX: 0, ...navigationWheel })
  await wait(`!document.querySelector('.turn-jump-target')`)
  await read(`document.querySelector('[data-run-id="turn-119"]').scrollIntoView({ block: 'end' })`)
  await wait(`document.querySelector('[data-run-id="turn-119"]:not([data-virtualized]) .turn-assistant') != null`)
  if (!await read(`document.querySelector('[data-run-id="turn-10"]').dataset.virtualized !== 'true'`)) {
    throw new Error('Selected evidence was evicted')
  }
  await click('#clear-selection')
  // Re-observe via native wheel movement; no fixed sleeps or simulated .click().
  const box = await read(`(() => { const r = document.querySelector('.chat-transcript').getBoundingClientRect(); return { x: Math.round(r.right - 30), y: Math.round(r.top + 200) }; })()`)
  webContents.sendInputEvent({ type: 'mouseWheel', deltaY: -100, deltaX: 0, ...box })
  await wait(`document.querySelector('[data-run-id="turn-10"]').dataset.virtualized === 'true'`)
  const retainedHeight = await read(`document.querySelector('[data-run-id="turn-10"]').getBoundingClientRect().height`)
  if (Math.abs(retainedHeight - measuredHeight) > 1) throw new Error(`Eviction changed shell height: ${measuredHeight} -> ${retainedHeight}`)
  // A focus/blur pair can arrive before React commits materialization. The DOM
  // marker must not let a queued focus update strand offscreen content.
  await wait(`document.querySelector('[data-run-id="turn-0"]').dataset.virtualized === 'true'`)
  await read(`(async () => {
    document.querySelector('[data-run-id="turn-0"]').focus({ preventScroll: true });
    document.querySelector('#stream').focus({ preventScroll: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`)
  await wait(`document.querySelector('[data-run-id="turn-0"]').dataset.virtualized === 'true'`)
  // Keyboard focus on a retained shell makes its full interactive content available.
  await read(`document.querySelector('[data-run-id="turn-0"]').focus()`)
  await wait(`document.querySelector('[data-run-id="turn-0"]:not([data-virtualized]) .turn-assistant') != null`)
  await read(`document.querySelector('[data-run-id="turn-119"]').scrollIntoView({ block: 'end' })`)
  await wait(`document.querySelector('[data-run-id="turn-119"]:not([data-virtualized]) .turn-assistant') != null`)
  if (!await read(`document.querySelector('[data-run-id="turn-0"]').dataset.virtualized !== 'true'`)) throw new Error('Focused content was evicted')
  await click('#stream')
  await wait(`document.querySelector('[data-run-id="turn-0"]').dataset.virtualized === 'true'`)
  if (!await read(`document.querySelector('[data-run-id="turn-60"] .tool-group-row')?.getAttribute('aria-expanded') === 'true'`)) throw new Error('Expanded tool state was lost')
  await read(`document.querySelector('[data-run-id="turn-2"]').scrollIntoView({ block: 'start' })`)
  await wait(`document.querySelector('[data-run-id="turn-2"]:not([data-virtualized]) .model-text') != null`)
  const selectedText = await read(`(() => { const selection = window.getSelection(); selection.selectAllChildren(document.querySelector('[data-run-id="turn-2"] .model-text')); return selection.toString(); })()`)
  await read(`document.querySelector('[data-run-id="turn-119"]').scrollIntoView({ block: 'end' })`)
  await wait(`document.querySelector('[data-run-id="turn-119"]:not([data-virtualized]) .turn-assistant') != null`)
  if (await read(`window.getSelection().toString()`) !== selectedText) throw new Error('Native text selection was discarded')
  await read(`window.getSelection().removeAllRanges()`)
  await wait(`document.querySelector('[data-run-id="turn-2"]').dataset.virtualized === 'true'`)
  await read(`document.querySelector('[data-run-id="turn-2"]').scrollIntoView({ block: 'start' })`)
  await wait(`document.querySelector('[data-run-id="turn-2"] .user-attachment') != null`)
  await click('[data-run-id="turn-2"] .user-attachment')
  await wait(`document.querySelector('.image-lightbox') != null`)
  await read(`document.querySelector('[data-run-id="turn-119"]').scrollIntoView({ block: 'end' })`)
  await wait(`document.querySelector('[data-run-id="turn-119"]:not([data-virtualized]) .turn-assistant') != null`)
  if (!await read(`document.querySelector('.image-lightbox') != null && document.querySelector('[data-run-id="turn-2"] .user-attachment')?.getAttribute('aria-expanded') === 'true'`)) throw new Error('Portaled image preview was evicted')
  await click('.image-lightbox-close')
  await wait(`document.querySelector('.image-lightbox') == null`)
  await read(`document.querySelector('[data-run-id="turn-119"]').scrollIntoView({ block: 'end' })`)
  await click('#stream')
  await wait(`document.querySelector('[data-run-id="turn-2"]').dataset.virtualized === 'true'`)
  const mountedAtEnd = await read(`document.querySelectorAll('.transcript-turn:not([data-virtualized])').length`)
  if (mountedAtEnd >= 40) throw new Error(`Scroll/focus retained ${mountedAtEnd} mounted turns`)
  return { ...sidebar,
    viewport, initialPageMounted, shortHistoryDisplayUnlocked, shortHeavyMounted, shortHeavyHistoryRecovered: true,
    historyPages: 3, loadedTurns: 120, mountedAtTop, mountedAtEnd,
    viewportAnchorPreserved: true, selectedEvidenceRetained: true, promptNavigationAligned: true, repeatedTurnNavigation: true, eventNavigationCentered: true, explicitBottomFollowCancelsNavigation: true, shellHeightPreserved: true,
    keyboardFocusRestoresContent: true, blurredContentReleased: true, batchedFocusReleased: true, nativeSelectionPreserved: true, expandedToolStatePreserved: true, imagePreviewPreserved: true, boundedPlaceholderLabel: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    plugins: [{ name: 'count-session-row-executions', enforce: 'pre', transform(code, id) {
      if (process.argv.includes('--negative-navigation-control') && id === join(root, 'src/renderer/hooks/useChatNavigation.ts')) {
        // Recreate the old one-shot/same-ID behavior without changing source.
        return code.replace('setRequest({ runId, eventId })', 'setRequest(current => current?.runId === runId ? current : { runId, eventId })')
          .replace('new ResizeObserver(schedule)', 'new ResizeObserver(() => {})')
          .replace('new MutationObserver(schedule)', 'new MutationObserver(() => {})')
      }
      if (id !== join(root, 'src/renderer/components/SidebarSessionRow.tsx')) return
      const marker = '  const pinned = Boolean(session.pinnedAt)'
      if (code.split(marker).length !== 2) throw new Error('SessionRow instrumentation anchor changed')
      return code.replace(marker, `  document.body.dataset.sessionRowRenders = String(Number(document.body.dataset.sessionRowRenders ?? 0) + 1)\n${marker}`)
    } }],
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/session-performance-smoke.tsx'), formats: ['iife'],
        name: 'ScrySessionPerformance', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron');
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited');
    app.on('browser-window-focus', () => { console.error('Performance fixture stole native window focus'); app.exit(1); });
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))});
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ title: 'Scry performance regression', show: false, width: 1100, height: 750,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('console-message', event => console.error(event.message));
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))});
        win.webContents.focus();
        const exerciseTranscriptDisplayLock = ${exerciseTranscriptDisplayLock.toString()};
        const exerciseSidebarPerformance = ${exerciseSidebarPerformance.toString()};
        const result = await (${exercise.toString()})(win.webContents, ${nativeUiPointer.toString()});
        console.log('SCRY_SESSION_PERFORMANCE=' + JSON.stringify(result));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 45_000)
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_SESSION_PERFORMANCE=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Session performance fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally { await rm(temp, { recursive: true, force: true }) }
