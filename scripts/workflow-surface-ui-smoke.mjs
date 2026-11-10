import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { exerciseWorkflowDetail, exerciseWorkflowSurface } from './workflow-surface-ui-checks.mjs'

// Workflow surface in a sandboxed Electron renderer at a wide and a narrow pane width.
// SCRY_WORKFLOW_UI_SCREENSHOT=<dir> also writes one PNG per mode/width for review.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-workflow-ui-'))
const shots = process.env.SCRY_WORKFLOW_UI_SCREENSHOT ?? ''
// Linux needs the display socket; macOS ignores these. Nothing else is inherited.
const display = Object.fromEntries(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR']
  .flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/workflow-surface-smoke.tsx'), formats: ['iife'], name: 'WorkflowFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ enableLargerThanScreen: true, show: false, width: 1180, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const results = []
      try {
        for (const [width, height] of [[1180, 900], [460, 900]]) {
          win.setContentSize(width, height)
          for (const mode of ['complete', 'running', 'unknown', 'unavailable', 'empty']) {
            await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { mode } })
            const result = await win.webContents.executeJavaScript('(' + ${JSON.stringify(exerciseWorkflowSurface.toString())} + ')(' + JSON.stringify(mode) + ')')
            if (result.click) {
              // A real pointer press/release at the chip centre, not element.click().
              for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: result.click.x, y: result.click.y, button: 'left', clickCount: 1 })
              if (${JSON.stringify(shots)}) {
                await win.webContents.executeJavaScript('new Promise((resolve) => { const wait = () => document.querySelector(".workflow-agent-detail") ? requestAnimationFrame(() => requestAnimationFrame(resolve)) : requestAnimationFrame(wait); wait() })')
                require('node:fs').writeFileSync(require('node:path').join(${JSON.stringify(shots)}, mode + '-' + width + '.png'), (await win.webContents.capturePage()).toPNG())
              }
              result.detail = await win.webContents.executeJavaScript('(' + ${JSON.stringify(exerciseWorkflowDetail.toString())} + ')(' + JSON.stringify(mode) + ')')
            }
            results.push({ width, ...result })
          }
        }
        console.log('SCRY_WORKFLOW_UI_RESULT=' + JSON.stringify(results))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], { env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), ...display }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_WORKFLOW_UI_RESULT=(.+)$/m)?.[1]
      if (code === 0 && result) { console.log(result); resolve() }
      else reject(new Error(`Workflow UI smoke failed (${code}): ${output}`))
    })
  })
} finally { await rm(temp, { recursive: true, force: true }) }
