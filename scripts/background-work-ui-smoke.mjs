import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { exercise, exerciseCompactCard, exerciseClock, exerciseRecovery } from './background-work-ui-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-background-ui-'))

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures/background-work-smoke.tsx'), formats: ['iife'], name: 'BackgroundFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ enableLargerThanScreen: true, show: false, width: 1100, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const wide = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        const compactCard = await (${exerciseCompactCard.toString()})(win)
        if (${JSON.stringify(process.env.SCRY_BACKGROUND_UI_SCREENSHOT ?? '')}) {
          const bounds = await win.webContents.executeJavaScript('JSON.stringify(document.querySelector(".background-work-panel").getBoundingClientRect().toJSON())')
          const rect = JSON.parse(bounds)
          const image = await win.webContents.capturePage({ x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) })
          require('node:fs').writeFileSync(${JSON.stringify(process.env.SCRY_BACKGROUND_UI_SCREENSHOT ?? '')}, image.toPNG())
        }
        win.setSize(640, 700)
        const narrow = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        const recovery = []
        for (const scenario of ['batch', 'done', 'error', 'reverse', 'focus', 'sidebar-done', 'sidebar-error', 'sidebar-delta']) {
          await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { mode: 'recovery' } })
          recovery.push(await win.webContents.executeJavaScript('(' + ${JSON.stringify(exerciseRecovery.toString())} + ')(' + JSON.stringify(scenario) + ')'))
        }
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { mode: 'clock' } })
        const clock = await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseClock.toString()})()`)})
        console.log('SCRY_BACKGROUND_UI_RESULT=' + JSON.stringify({ wide, narrow, compactCard, recovery, clock }))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], { env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('exit', (code) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_BACKGROUND_UI_RESULT=(.+)$/m)?.[1]
      if (code === 0 && result) { console.log(result); resolve() }
      else reject(new Error(`Background UI smoke failed (${code}): ${output}`))
    })
  })
} finally { await rm(temp, { recursive: true, force: true }) }
