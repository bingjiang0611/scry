import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-steer-ui-'))
const screenshot = process.env.SCRY_STEER_UI_SCREENSHOT ?? ''
let cleanupUnknown = false

// Production renderer components in a hidden, sandboxed Electron fixture. No Scry main
// process, preload, Provider discovery, account credentials, or native transport is used.
async function exercise(contents) {
  const read = (expression) => contents.executeJavaScript(expression)
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  }
  const pointFor = async (selector) => read(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) throw new Error('Missing control: ' + ${JSON.stringify(selector)})
    node.scrollIntoView({ block: 'center', inline: 'nearest' })
    const rect = node.getBoundingClientRect()
    const point = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    if (rect.width <= 0 || rect.height <= 0 || !node.contains(document.elementFromPoint(point.x, point.y))) {
      throw new Error('Control is not hit-testable: ' + ${JSON.stringify(selector)})
    }
    return point
  })()`)
  const click = async (selector) => {
    const point = await pointFor(selector)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const rowButton = async (index, className) => pointFor(`.queue-item:nth-child(${index + 1}) .${className}`)
  const clickRowButton = async (index, className) => {
    const point = await rowButton(index, className)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }

  contents.focus()
  await wait(`document.querySelector('.prompt-queue') != null && document.querySelectorAll('.queue-item').length === 4`)
  console.log('Steer UI: fixture loaded')
  check(await read('document.hasFocus()'), 'Fixture document did not receive focus')
  check(await read(`document.querySelector('.steer-evidence[data-steer-message-id="accepted-evidence"]')?.textContent.includes(${JSON.stringify('请先保留当前工作')})`), 'Accepted Steer evidence is missing')
  check(await read(`document.querySelector('.steer-evidence[data-steer-message-id="accepted-evidence"]')?.textContent.includes(${JSON.stringify('不能只显示成提示')})`), 'Accepted evidence lost the full user supplement')

  // Hit a non-head row with native coordinates. The first queue row must not change.
  await clickRowButton(1, 'queue-steer')
  await wait(`document.querySelectorAll('.queue-item')[1].classList.contains('is-steer-pending')`)
  check(await read(`document.querySelector('#fixture').dataset.lastSteer === 'target'`), 'Native Steer click selected the wrong message')
  check(await read(`!document.querySelectorAll('.queue-item')[0].classList.contains('is-steer-pending')`), 'Steer changed the queue head')
  check(await read(`document.querySelectorAll('.queue-item')[1].querySelector('.queue-steer').disabled && document.querySelectorAll('.queue-item')[1].querySelector('.queue-remove').disabled`), 'Pending Steer did not disable duplicate/removal actions')

  // Unknown outcomes are retained as a safety barrier and expose their reason.
  check(await read(`(() => { const row = document.querySelectorAll('.queue-item')[2]; return row.textContent.includes('Provider 回执未知（fixture）') && row.querySelector('.queue-steer').disabled && row.querySelector('.queue-remove').disabled })()`), 'Unknown Steer was not retained and disabled')

  // Long text plus an attachment must leave the action reachable by coordinates.
  const attachmentPoint = await rowButton(3, 'queue-steer')
  check(await read(`(() => { const row = document.querySelectorAll('.queue-item')[3]; const button = row.querySelector('.queue-steer'); const attachment = row.querySelector('.queue-attach'); return row.querySelector('.queue-text').title.length > 100 && attachment?.title.includes('diagram.png') && button.getBoundingClientRect().right <= innerWidth + 1 && document.elementFromPoint(${attachmentPoint.x}, ${attachmentPoint.y})?.closest('.queue-steer') === button })()`), 'Long attachment row Steer action was not reachable')
  await clickRowButton(3, 'queue-steer')
  await wait(`document.querySelectorAll('.queue-item')[3].classList.contains('is-steer-pending')`)
  check(await read(`document.querySelector('#fixture').dataset.lastSteer === 'attachment'`), 'Attachment row native action did not target its own message')

  await click('#set-unavailable')
  await wait(`document.querySelector('.queue-steer-capability')?.textContent.includes('fixture 明确不支持 Steer')`)
  check(await read(`(() => { const button = document.querySelectorAll('.queue-item')[0].querySelector('.queue-steer'); return button.disabled && button.title.includes('fixture 明确不支持 Steer') })()`), 'Unsupported Steer button has no reason')

  // Focus the real composer by coordinates and submit with a native Enter key sequence.
  const inputPoint = await pointFor('textarea[aria-label="描述任务"]')
  contents.sendInputEvent({ type: 'mouseDown', ...inputPoint, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', ...inputPoint, button: 'left', clickCount: 1 })
  await wait(`document.activeElement?.matches('textarea[aria-label="描述任务"]')`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(`document.querySelector('#fixture').dataset.sends === '1'`)

  // 编辑队列消息：行内动作让位给取消编辑，文本进到真实输入框，队列高亮跟真实发送顺序走。
  // 先断「正在提交的行不能编辑」——文本已经在 Provider 那一侧了。
  console.log('Steer UI: checking queue message editing')
  check(await read(`(() => { const button = document.querySelectorAll('.queue-item')[1].querySelector('.queue-edit'); return button.disabled && button.title.includes('Steer 正在提交') })()`), 'Pending Steer row allowed editing')
  await clickRowButton(0, 'queue-edit')
  await wait(`document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`)
  check(await read(`(() => { const row = document.querySelectorAll('.queue-item')[0]; return document.querySelector('textarea[aria-label="描述任务"]').value === row.querySelector('.queue-text').title && row.querySelector('.queue-edit-cancel') != null && row.querySelector('.queue-steer') == null })()`), 'Editing did not replace the row actions or load the text into the composer')
  check(await read(`!document.querySelectorAll('.queue-item')[0].classList.contains('is-next') && document.querySelectorAll('.queue-item')[1].classList.contains('is-next')`), 'Editing row still claimed the next highlight')
  check(await read(`document.querySelector('.composer-edit-hint')?.textContent.includes('自动发送会先跳过这条')`), 'Edit hint did not state that automatic sending skips this message')
  await clickRowButton(0, 'queue-edit-cancel')
  await wait(`!document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`)
  check(await read(`(() => { const row = document.querySelectorAll('.queue-item')[0]; return row.querySelector('.queue-edit') != null && row.classList.contains('is-next') && document.querySelector('textarea[aria-label="描述任务"]').value === '' })()`), 'Cancel did not restore row actions, highlight and an empty composer')

  // Explicit Stop clears ordinary messages, never the unresolved Steer payloads.
  console.log('Steer UI: native actions passed; checking Stop preservation')
  await click('.run-status-stop')
  await wait(`document.querySelectorAll('.queue-item').length === 3 && !document.querySelector('.run-status-stop')`)
  check(await read(`(() => { const rows = [...document.querySelectorAll('.queue-item')]; return rows[0].querySelector('.queue-text').title.includes('对当前任务补充') && rows[1].classList.contains('is-steer-unknown') && rows[2].querySelector('.queue-attach')?.title.includes('diagram.png') && rows.every(row => row.querySelector('.queue-remove').disabled) })()`), 'Stop discarded or unprotected unresolved Steer payloads')

  return { coordinateHit: true, selectedRowOnly: true, pendingActionsDisabled: true, fullAcceptedEvidence: true, unknownBarrier: true, unsupportedReason: true, attachmentReachable: true, nativeKeyboardEnter: true, queueEditing: true, manualStopKeepsUncertain: true }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'src/renderer/components/fixtures/steer.tsx'), formats: ['iife'], name: 'SteerFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' }
    }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Renderer:', event.message) })
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const result = await (${exercise.toString()})(win.webContents)
        if (${JSON.stringify(screenshot)}) {
          for (const theme of ['dark', 'light']) {
            const bounds = await win.webContents.executeJavaScript(\`document.documentElement.setAttribute('data-theme', '\${theme}'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const r = document.querySelector('#root').getBoundingClientRect(); resolve({ x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height), background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }) })))\`)
            if (theme === 'light' && bounds.background !== '#f7f7f5') throw new Error('Light theme variables were not applied: ' + bounds.background + '; attr=' + await win.webContents.executeJavaScript('document.documentElement.getAttribute("data-theme")'))
            require('node:fs').writeFileSync(${JSON.stringify(screenshot)} + '-' + theme + '.png', (await win.webContents.capturePage(bounds)).toPNG())
          }
        }
        console.log('SCRY_STEER_UI_RESULT=' + JSON.stringify(result))
        app.exit(0)
      } catch (error) { console.error(error); app.exit(1) }
    }).catch(error => { console.error(error); app.exit(1) })
  `)
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let timeoutCleanup
    const timer = setTimeout(() => {
      const failure = new Error(`Steer UI timed out (pid=${child.pid}, fixture=${temp}):\n${output.slice(-8000)}`)
      console.error(failure.message)
      timeoutCleanup = stopOwnedApp(child).then(() => reject(failure), (error) => {
        cleanupUnknown = true
        reject(new Error(`Steer UI cleanup unknown; fixture preserved: ${temp}`, { cause: error }))
      })
    }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timeoutCleanup) return
      const result = output.match(/^SCRY_STEER_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Steer UI smoke failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  if (!cleanupUnknown) await rm(temp, { recursive: true, force: true })
}
