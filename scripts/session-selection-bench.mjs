import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { measureNativeSessionOpen } from './session-open-timing.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-session-selection-bench-'))
const warmups = 2
const iterations = 7
const pendingFrames = 8

try {
  await Promise.all(['userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await build({
    configFile: false,
    root: temp,
    envDir: temp,
    logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      lib: {
        entry: join(root, 'scripts/fixtures/session-selection-smoke.tsx'),
        formats: ['iife'],
        name: 'ScrySessionSelectionBench',
        fileName: () => 'session-selection.js',
        cssFileName: 'session-selection'
      }
    }
  })
  await writeFile(join(temp, 'session-selection.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:"><link rel="stylesheet" href="session-selection.css"><div id="root"></div><script src="session-selection.js"></script>`)
  await writeFile(join(temp, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
const measureNativeSessionOpen = ${measureNativeSessionOpen.toString()}
const warmups = ${warmups}
const iterations = ${iterations}
const pendingFrames = ${pendingFrames}
const percentile = (values, quantile) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * quantile) - 1]
app.whenReady().then(async () => {
  app.dock?.hide()
  const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const read = expression => win.webContents.executeJavaScript(expression)
  const wait = async expression => {
    const deadline = Date.now() + 10000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + expression + '\\n' + await read('document.body.innerText'))
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async selector => {
    const point = await read(\`(() => {
      const node = document.querySelector(\${JSON.stringify(selector)})
      if (!node) throw new Error('Missing click target')
      node.scrollIntoView({ block: 'center' })
      const rect = node.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2)
      if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Click target obscured')
      return { x, y }
    })()\`)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const samples = []
  for (let index = 0; index < warmups + iterations; index++) {
    await win.loadFile(${JSON.stringify(join(temp, 'session-selection.html'))}, { query: { scenario: 'same-provider' } })
    const state = \`JSON.parse(document.querySelector('#selection-state').textContent)\`
    await wait(\`\${state}.snapshots === 2\`)
    await click('#resolve-snapshots')
    await wait(\`document.querySelector('.sb-sess.running')?.getAttribute('aria-current') === 'true'\`)
    await read(\`(() => {
      const button = document.querySelector('.sb-sess[data-provider="pi"]:not(.running)')
      window.__selectionTiming = measureNativeSessionOpen(
        button,
        () => button.getAttribute('aria-current') === 'true' && document.querySelector('.chat-transcript')?.getAttribute('aria-busy') === 'false' && document.body.innerText.includes('History for new-session'),
        () => button.getAttribute('aria-current') === 'true' && !document.querySelector('.chat-transcript')?.textContent.includes('Old running conversation')
      )
    })()\`.replace('measureNativeSessionOpen', '(' + measureNativeSessionOpen.toString() + ')'))
    await click('.sb-sess[data-provider="pi"]:not(.running)')
    await wait(\`\${state}.historyReads === 1\`)
    await read(\`new Promise(resolve => { let frames = 0; const next = () => ++frames === pendingFrames ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next) })\`.replace('pendingFrames', String(pendingFrames)))
    const selectedBeforeHistory = await read(\`document.querySelector('.sb-sess[data-provider="pi"]')?.getAttribute('aria-current') === 'true' && !document.querySelector('.chat-transcript')?.textContent.includes('Old running conversation')\`)
    await click('#resolve-history')
    const timing = await read('window.__selectionTiming')
    if (index >= warmups) samples.push({ ...timing, selectedBeforeHistory })
  }
  const selection = samples.map(sample => sample.selectionMs)
  const ready = samples.map(sample => sample.nativeOpenMs)
  const result = {
    schema: 1,
    workload: { warmups, iterations, pendingFrames, scenario: 'same-provider-pending-history' },
    selectedBeforeHistory: samples.filter(sample => sample.selectedBeforeHistory).length,
    selectionMs: { p50: percentile(selection, 0.5), p95: percentile(selection, 0.95) },
    readyMs: { p50: percentile(ready, 0.5), p95: percentile(ready, 0.95) },
    samples
  }
  process.stdout.write('SCRY_SELECTION_BENCH=' + JSON.stringify(result) + '\\n', () => app.exit(0))
}).catch(error => { console.error(error); app.exit(1) })
`)

  const output = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs')], {
      cwd: root,
      env: { ...process.env, HOME: temp },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let text = ''
    child.stdout.on('data', chunk => { text += chunk })
    child.stderr.on('data', chunk => { text += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`Selection benchmark failed (${code}):\n${text.slice(-8000)}`)))
  })
  const encoded = output.match(/^SCRY_SELECTION_BENCH=(.+)$/m)?.[1]
  if (!encoded) throw new Error(`Selection benchmark result missing:\n${output.slice(-8000)}`)
  console.log(JSON.stringify(JSON.parse(encoded), null, 2))
} finally {
  await rm(temp, { recursive: true, force: true })
}
