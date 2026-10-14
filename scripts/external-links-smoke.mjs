import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

// Run after `npm run build`. Use the real main/preload/renderer with isolated data;
// intercept only OS browser launch/dialogs so this test never visits a live service.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'out/main/index.js')
await access(entry)
const temp = await mkdtemp(join(tmpdir(), 'scry-external-links-'))

async function exercise(window, shell, dialog) {
  const assert = require('node:assert/strict')
  const contents = window.webContents
  // Exercise the production ready and second-instance handlers, then outlive the
  // 2500 ms startup fallback. The guard rejects display calls before they reach
  // the OS, even if activationPolicy happens to suppress native visibility.
  contents.emit('ipc-message', {}, 'app:rendererReady')
  require('electron').app.emit('second-instance')
  await new Promise(resolve => setTimeout(resolve, 2600))
  assert.equal(window.isVisible(), false, 'Test app must remain hidden')
  assert.equal(window.isFocused(), false, 'Test app must not steal native focus')
  assert.equal(contents.getBackgroundThrottling(), false, 'Background test UI must keep rendering')
  let frameTimer
  try {
    await Promise.race([
      contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => resolve(true)))'),
      new Promise((_resolve, reject) => { frameTimer = setTimeout(() => reject(new Error('Background animation frame stalled')), 5000) })
    ])
  } finally { clearTimeout(frameTimer) }
  // Fresh-profile discovery is read-only: it must not initialize or unlock Keychain.
  assert.deepEqual(await contents.executeJavaScript('window.scry.desktopRemote.list()'), [])
  const rendererUrl = contents.getURL()
  const opened = []
  const prompts = []
  let onDispatch
  shell.openExternal = async (url) => { opened.push(url); onDispatch?.() }
  dialog.showMessageBox = async (...args) => {
    prompts.push(args.at(-1).message)
    onDispatch?.()
    return { response: 0, checkboxChecked: false }
  }
  const links = ['http://127.0.0.1:4610/', 'http://localhost:4610/', 'http://[::1]:4610/',
    'http://192.168.1.1/', 'https://10.0.0.1/', 'https://example.com/']
  for (const target of ['_self', '_blank']) {
    for (const url of links) {
      const point = await contents.executeJavaScript(`(() => {
        document.getElementById('external-link-fixture')?.remove()
        const link = document.createElement('a')
        link.id = 'external-link-fixture'
        link.href = ${JSON.stringify(url)}
        link.target = ${JSON.stringify(target)}
        link.textContent = 'Open link'
        link.style.cssText = 'position:fixed;left:400px;top:200px;z-index:2147483647;padding:20px;background:white;color:black'
        document.body.append(link)
        const rect = link.getBoundingClientRect()
        const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
        if (document.elementFromPoint(point.x, point.y) !== link) throw new Error('Link is not hit-testable')
        return point
      })()`)
      const before = opened.length
      let timer
      try {
        await new Promise((resolve, reject) => {
          onDispatch = resolve
          timer = setTimeout(() => reject(new Error(`No link dispatch: ${url} ${target}`)), 5000)
          contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
          contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
        })
      } finally {
        clearTimeout(timer)
        onDispatch = undefined
      }
      assert.deepEqual(prompts, [], `Link must not prompt: ${url}`)
      assert.deepEqual(opened.slice(before), [url])
      assert.equal(contents.getURL(), rendererUrl, 'External link replaced the privileged renderer')
    }
  }
  // Redirect and rejected-scheme branches use the production registered handlers.
  for (const eventName of ['will-navigate', 'will-redirect']) {
    for (const url of ['http://127.0.0.1:4610/', 'file:///etc/passwd', 'javascript:alert(1)',
      'data:text/html,hello']) {
      let prevented = false
      const before = opened.length
      contents.emit(eventName, { preventDefault() { prevented = true } }, url)
      assert.equal(prevented, true)
      assert.deepEqual(opened.slice(before), url.startsWith('http://127.') ? [url] : [])
    }
  }
  assert.deepEqual(prompts, [])
  assert.equal(require('electron').BrowserWindow.getAllWindows().length, 1, 'Popup was not denied')
  console.log('SCRY_EXTERNAL_LINKS_SMOKE=passed')
}

try {
  await mkdir(join(temp, 'home'))
  await writeFile(join(temp, 'main.cjs'), `
    const { app, shell, dialog, safeStorage } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    safeStorage.isEncryptionAvailable = () => { throw new Error('Fresh-profile startup unexpectedly accessed Keychain') }
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.on('browser-window-focus', () => { console.error('Test app stole native window focus'); app.exit(1) })
    app.once('browser-window-created', (_event, window) => {
      window.webContents.once('did-finish-load', async () => {
        try {
          await (${exercise.toString()})(window, shell, dialog)
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
        () => reject(new Error(`External links fixture timed out; retained at ${temp}:\n${output.slice(-8000)}`)),
        error => reject(new Error(`External links fixture cleanup unknown; retained at ${temp}`, { cause: error }))
      )
    }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (cleanup) return
      if (code !== 0 || !output.includes('SCRY_EXTERNAL_LINKS_SMOKE=passed')) {
        reject(new Error(`External links fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      } else { console.log('Background startup: no display or native focus (renderer ready, second instance, fallback); external links: native clicks open directly; unsafe URLs and renderer navigation remain blocked'); resolve() }
    })
  })
} catch (error) {
  console.error(`External links fixture retained: ${temp}`)
  throw error
}
await rm(temp, { recursive: true, force: true })
