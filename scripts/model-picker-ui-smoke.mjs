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
  await click('.sb-proj-new')
  await wait(`document.querySelector('.model-effort-trigger')?.disabled === false`)
  await openModels()
  await wait(`${options}.length === 6 && ${groups}.length === 2`)
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
  key('Return')
  await wait(`document.querySelector('.model-effort-model').textContent === 'provider-b / Shared Model' && document.querySelector('.model-effort-current') != null`)
  await click('.model-effort-trigger')
  await openModels()
  await wait(`document.querySelector('.model-effort-search').value === '' && ${options}.length === 6`)
  await search('shared-id')
  await wait(`document.querySelector('.model-effort-list [aria-selected="true"]')?.getAttribute('aria-label') === 'provider-b / Shared Model'`)
  key('Escape')
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
  return { providerGroups: true, searchNameIdProvider: true, emptyAndClear: true, keyboard: true, syntheticImeGuard: true, queryReset: true, qualifiedSummary: true, correctProviderInAppRequest: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/session-model-smoke.tsx'), formats: ['iife'], name: 'ScryModelPicker', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { 'provider-models': '1' } })
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
