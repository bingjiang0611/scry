import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

// Run after `npm run build`. Uses the real main/preload/renderer with isolated data.
// Proves (1) the crashing Chromium a11y feature is disabled in the renderer process itself,
// (2) a crashed renderer is reloaded instead of leaving a blank window, and
// (3) a second crash inside the cooldown asks the user instead of reload-looping.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'out/main/index.js')
await access(entry)
const temp = await mkdtemp(join(tmpdir(), 'scry-renderer-crash-'))

async function exercise(window, dialog) {
  const assert = require('node:assert/strict')
  const { app } = require('electron')
  const contents = window.webContents
  const rendererUrl = contents.getURL()
  const withTimeout = (promise, label) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000) })
    ]).finally(() => clearTimeout(timer))
  }
  // The browser process forwards feature overrides to children on their command line;
  // reading the live renderer argv proves the switch reached the process that crashed.
  const rendererArgs = require('node:child_process').execFileSync(
    'ps', ['-o', 'command=', '-p', String(contents.getOSProcessId())], { encoding: 'utf8' })
  const disabled = rendererArgs.match(/--disable-features=(\S+)/)?.[1]?.split(',') ?? []
  assert.ok(disabled.includes('AccessibilityBlockFlowIterator'),
    `Renderer must run without AccessibilityBlockFlowIterator: ${rendererArgs}`)
  assert.ok(app.commandLine.getSwitchValue('disable-features').split(',').includes('AccessibilityBlockFlowIterator'))

  const prompts = []
  dialog.showMessageBox = async (...args) => {
    prompts.push(args.at(-1).message)
    return { response: 0, checkboxChecked: false }
  }
  const crashAndAwaitReload = async (label) => {
    const before = contents.getOSProcessId()
    const gone = new Promise(resolve => contents.once('render-process-gone', (_event, details) => resolve(details)))
    const loaded = new Promise(resolve => contents.once('did-finish-load', resolve))
    contents.forcefullyCrashRenderer()
    const details = await withTimeout(gone, `${label} crash`)
    await withTimeout(loaded, `${label} reload`)
    assert.notEqual(contents.getOSProcessId(), before, `${label}: renderer process was not replaced`)
    assert.equal(contents.isCrashed(), false)
    assert.equal(contents.getURL(), rendererUrl)
    // A live React root, not just the window background colour.
    const rootChildren = await withTimeout(contents.executeJavaScript(`new Promise(resolve => {
      const check = () => document.getElementById('root')?.childElementCount
        ? resolve(document.getElementById('root').childElementCount)
        : requestAnimationFrame(check)
      check()
    })`), `${label} React mount`)
    assert.ok(rootChildren > 0)
    return details
  }

  const first = await crashAndAwaitReload('first')
  assert.notEqual(first.reason, 'clean-exit')
  assert.deepEqual(prompts, [], 'First crash must reload without prompting')

  await crashAndAwaitReload('second')
  assert.deepEqual(prompts, ['界面进程反复崩溃'], 'Crash within cooldown must ask before reloading')
  console.log('SCRY_RENDERER_CRASH_RECOVERY_SMOKE=passed')
}

try {
  await mkdir(join(temp, 'home'))
  await writeFile(join(temp, 'main.cjs'), `
    const { app, dialog } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', async () => {
        try {
          await (${exercise.toString()})(window, dialog)
          app.exit(0)
        } catch (error) { console.error(error); app.exit(1) }
      })
    })
    import(${JSON.stringify(pathToFileURL(entry).href)}).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home'), SCRY_TEST_APP: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let cleanup
    const timer = setTimeout(() => {
      cleanup = stopOwnedApp(child).then(
        () => reject(new Error(`Renderer crash fixture timed out; retained at ${temp}:\n${output.slice(-8000)}`)),
        error => reject(new Error(`Renderer crash fixture cleanup unknown; retained at ${temp}`, { cause: error }))
      )
    }, 60_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (cleanup) return
      if (code !== 0 || !output.includes('SCRY_RENDERER_CRASH_RECOVERY_SMOKE=passed')) {
        reject(new Error(`Renderer crash fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      } else {
        console.log('Renderer crash recovery: AccessibilityBlockFlowIterator disabled in renderer; first crash reloads; repeat crash prompts before reload')
        resolve()
      }
    })
  })
} catch (error) {
  console.error(`Renderer crash fixture retained: ${temp}`)
  throw error
}
await rm(temp, { recursive: true, force: true })
