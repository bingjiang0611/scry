import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-giant-turn-ui-'))

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
        entry: join(root, 'scripts/fixtures/giant-turn-smoke.tsx'),
        formats: ['iife'],
        name: 'ScryGiantTurnSmoke',
        fileName: () => 'giant-turn.js',
        cssFileName: 'giant-turn'
      }
    }
  })
  await writeFile(join(temp, 'giant-turn.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="giant-turn.css"><div id="root"></div><script src="giant-turn.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
const { app, BrowserWindow } = require('electron')
require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
app.whenReady().then(async () => {
  app.dock?.hide()
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
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
  await win.loadFile(${JSON.stringify(join(temp, 'giant-turn.html'))})
  await wait(\`document.body.innerText.includes('latest giant turn evidence')\`)
  const before = await read(\`({
    earliest: document.body.innerText.includes('earliest giant turn evidence'),
    button: document.querySelector('.turn-flow-reveal')?.textContent,
    rendered: document.querySelectorAll('.model-text.md').length
  })\`)
  const point = await read(\`(() => {
    const node = document.querySelector('.turn-flow-reveal')
    if (!node) throw new Error('Missing reveal button')
    node.scrollIntoView({ block: 'center' })
    const rect = node.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2)
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('Reveal button is not hit-testable')
    return { x, y }
  })()\`)
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await wait(\`document.body.innerText.includes('earliest giant turn evidence')\`)
  const after = await read(\`({
    earliest: document.body.innerText.includes('earliest giant turn evidence'),
    button: Boolean(document.querySelector('.turn-flow-reveal')),
    rendered: document.querySelectorAll('.model-text.md').length
  })\`)
  process.stdout.write('SCRY_GIANT_TURN_UI=' + JSON.stringify({ before, after }) + '\\n', () => app.exit(0))
}).catch(error => { console.error(error); app.exit(1) })
`)
  const output = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs')], { cwd: root, env: { ...process.env, HOME: temp }, stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', chunk => { text += chunk })
    child.stderr.on('data', chunk => { text += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(text) : reject(new Error(`Giant turn UI smoke failed (${code}):\n${text.slice(-8000)}`)))
  })
  const encoded = output.match(/^SCRY_GIANT_TURN_UI=(.+)$/m)?.[1]
  if (!encoded) throw new Error(`Giant turn UI result missing:\n${output.slice(-8000)}`)
  const result = JSON.parse(encoded)
  if (result.before.earliest || result.before.rendered !== 16 || result.after.button || !result.after.earliest || result.after.rendered !== 101) {
    throw new Error(`Unexpected giant turn UI state: ${JSON.stringify(result)}`)
  }
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(temp, { recursive: true, force: true })
}
