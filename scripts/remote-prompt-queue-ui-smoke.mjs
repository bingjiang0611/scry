import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { stopOwnedApp } from './owned-app-processes.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-remote-queue-ui-'))
const screenshot = process.env.SCRY_REMOTE_QUEUE_UI_SCREENSHOT ?? ''
let cleanupUnknown = false

// 远端队列编辑：真实 SessionChatView + 真实 RemotePromptQueueStore，在隐藏的沙箱 Electron
// fixture 里用原生坐标点击。没有 Scry main 进程、preload、主机连接或账号凭据。
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
  const clickRowButton = async (index, className) => click(`.queue-item:nth-child(${index + 1}) .${className}`)
  const rowTexts = `[...document.querySelectorAll('.queue-item .queue-text')].map(node => node.title)`
  const composerValue = `document.querySelector('textarea[aria-label="描述任务"]').value`

  contents.focus()
  await wait(`document.querySelectorAll('.queue-item').length === 3`)
  console.log('Remote queue UI: fixture loaded')
  check(await read('document.hasFocus()'), 'Fixture document did not receive focus')

  // 铅笔在远端队列里必须可用：这是本次补的能力，之前 RemoteChat 没传编辑回调。
  check(await read(`(() => { const button = document.querySelectorAll('.queue-item')[0].querySelector('.queue-edit'); return button != null && !button.disabled })()`), 'Remote queue pencil is missing or disabled')
  await clickRowButton(0, 'queue-edit')
  await wait(`document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`)
  check(await read(`document.querySelectorAll('.queue-item')[0].querySelector('.queue-text').title === ${JSON.stringify('远端第一条消息')} && ${composerValue} === ${JSON.stringify('远端第一条消息')}`), 'Editing did not load the remote entry text into the composer')
  check(await read(`document.querySelectorAll('.queue-item')[0].querySelector('.queue-edit-cancel') != null && document.querySelectorAll('.queue-item')[0].querySelector('.queue-steer') == null`), 'Editing did not replace the row actions')
  check(await read(`!document.querySelectorAll('.queue-item')[0].classList.contains('is-next') && document.querySelectorAll('.queue-item')[1].classList.contains('is-next')`), 'Editing row still claimed the next highlight')
  check(await read(`document.querySelector('.composer-edit-hint')?.textContent.includes('自动发送会先跳过这条')`), 'Edit hint did not explain the skip')

  // 出队必须跳过编辑中的那条：否则远端一空下来就发走改了一半的旧文本。
  await click('#drain')
  await wait(`document.querySelector('#fixture').dataset.claimed !== ''`)
  check(await read(`document.querySelector('#fixture').dataset.claimed === ${JSON.stringify('远端第二条消息')}`), 'Drain did not skip the row being edited')
  check(await read(`document.querySelectorAll('.queue-item').length === 3 && document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`), 'Drain removed the row being edited')

  // 取消编辑后行与原文本原样保留，输入框清空。
  await clickRowButton(0, 'queue-edit-cancel')
  await wait(`!document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`)
  check(await read(`(() => { const row = document.querySelectorAll('.queue-item')[0]; return row.querySelector('.queue-edit') != null && row.classList.contains('is-next') && ${composerValue} === '' })()`), 'Cancel did not restore the remote row')

  // 编辑后发送：原位置移除、排到队尾，数量不变。
  await clickRowButton(0, 'queue-edit')
  await wait(`document.querySelectorAll('.queue-item')[0].classList.contains('is-editing')`)
  await click('button[aria-label="加入队列"]')
  await wait(`document.querySelector('#fixture').dataset.sends === '1'`)
  const texts = await read(rowTexts)
  check(JSON.stringify(texts) === JSON.stringify(['远端第二条消息', '', '远端第一条消息']), `Edit did not move the entry to the tail: ${JSON.stringify(texts)}`)
  check(await read(`(() => { const rows = [...document.querySelectorAll('.queue-item')]; return rows.length === 3 && rows[2].querySelector('.queue-moved') != null && !rows.some(row => row.classList.contains('is-editing')) })()`), 'Moved entry is not marked at the tail')
  check(await read(`${composerValue} === ''`), 'Composer kept the edited text after sending')

  return { coordinateHit: true, pencilEnabled: true, editLoadsText: true, nextHighlightFollowsDrain: true, drainSkipsEditing: true, cancelRestores: true, editMovesToTail: true }
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
      lib: { entry: join(root, 'src/renderer/components/fixtures/remote-queue.tsx'), formats: ['iife'], name: 'RemoteQueueFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' }
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
            const bounds = await win.webContents.executeJavaScript(\`document.documentElement.setAttribute('data-theme', '\${theme}'); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { const r = document.querySelector('#root').getBoundingClientRect(); resolve({ x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) }) })))\`)
            require('node:fs').writeFileSync(${JSON.stringify(screenshot)} + '-' + theme + '.png', (await win.webContents.capturePage(bounds)).toPNG())
          }
        }
        console.log('SCRY_REMOTE_QUEUE_UI_RESULT=' + JSON.stringify(result))
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
      const failure = new Error(`Remote queue UI timed out (pid=${child.pid}, fixture=${temp}):\n${output.slice(-8000)}`)
      console.error(failure.message)
      timeoutCleanup = stopOwnedApp(child).then(() => reject(failure), (error) => {
        cleanupUnknown = true
        reject(new Error(`Remote queue UI cleanup unknown; fixture preserved: ${temp}`, { cause: error }))
      })
    }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (timeoutCleanup) return
      const result = output.match(/^SCRY_REMOTE_QUEUE_UI_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Remote queue UI smoke failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  if (!cleanupUnknown) await rm(temp, { recursive: true, force: true })
}
