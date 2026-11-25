import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

// 真实 Chromium 里的续读检查：只挂载真实 useHistoryAutoload 与真实滚动容器，
// 不连接 Provider 或 IPC。滚动容器与生产一致关闭浏览器锚定，因此视口位置只能由
// hook 的补偿维持；检查覆盖静止阅读与加载期间继续滚动两种情况。
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-history-autoload-'))
const PAGE = 40
const TOTAL = 200

async function exerciseHistoryAutoload(PAGE, TOTAL) {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const waitFor = async (expression, label) => {
    const deadline = Date.now() + 8000
    while (!expression()) {
      if (Date.now() > deadline) throw new Error('Timed out: ' + label)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const fixture = (id) => document.querySelector('#' + id)
  const scrollerOf = (id) => fixture(id).querySelector('.chat-transcript')
  const countOf = (id) => Number(fixture(id).dataset.count)
  const loadsOf = (id) => Number(fixture(id).dataset.loads)
  const firstVisible = (id) => {
    const scroller = scrollerOf(id)
    const top = scroller.getBoundingClientRect().top
    return Array.from(scroller.querySelectorAll('[data-run-id]')).find((node) => node.getBoundingClientRect().bottom > top + 1)
  }
  const run = async (id) => {
    const scroller = scrollerOf(id)
    // 初始只挂最近一页，滚动位置在底部（和真实会话打开一致）。
    if (countOf(id) !== PAGE) throw new Error(id + ': expected the latest page, got ' + countOf(id))
    await frame()
    scroller.scrollTop = scroller.scrollHeight
    await frame()
    // 进入预取距离：不改滚动位置也能触发，且只补一页。
    scroller.scrollTop = 200
    await frame()
    await waitFor(() => countOf(id) === PAGE * 2, id + ': one page after entering the prefetch distance')
    if (loadsOf(id) !== 1) throw new Error(id + ': expected exactly one load, got ' + loadsOf(id))
    await frame()

    // 锚点：进入预取距离的那一帧就记录第一个可见轮次；取页后它还应在原位（±1px）。
    scroller.scrollTop = 200
    await frame()
    const anchor = firstVisible(id)
    if (!anchor) throw new Error(id + ': no visible turn before loading')
    const anchorTop = anchor.getBoundingClientRect().top
    const heightBefore = scroller.scrollHeight
    const loadsBefore = loadsOf(id)
    await waitFor(() => loadsOf(id) === loadsBefore + 1, id + ': next page after reaching the prefetch distance')
    await frame()
    const inserted = scroller.scrollHeight - heightBefore
    const drift = anchor.getBoundingClientRect().top - anchorTop
    if (inserted <= 0) throw new Error(id + ': expected inserted content above the viewport, height delta ' + inserted)
    if (Math.abs(drift) > 1) throw new Error(id + ': visible turn moved by ' + drift + 'px after prepending ' + inserted + 'px')

    // 取页在途时末尾追加实时轮次：阅读位置不能动，随后到达的上一页也不能再补偿一次。
    scroller.scrollTop = 200
    await frame()
    const liveAnchor = firstVisible(id)
    const liveAnchorTop = liveAnchor.getBoundingClientRect().top
    const loadsBeforeLive = loadsOf(id)
    fixture(id).querySelector('.append-live').click()
    await frame()
    if (fixture(id).dataset.live !== '1') throw new Error(id + ': live turn was not appended')
    const appendDrift = liveAnchor.getBoundingClientRect().top - liveAnchorTop
    if (Math.abs(appendDrift) > 1) throw new Error(id + ': appending a live turn moved the view by ' + appendDrift + 'px')
    await waitFor(() => loadsOf(id) === loadsBeforeLive + 1, id + ': page arrives after the live append')
    await frame()
    const afterPageDrift = liveAnchor.getBoundingClientRect().top - liveAnchorTop
    if (Math.abs(afterPageDrift) > 1) throw new Error(id + ': prepend after a live append moved the view by ' + afterPageDrift + 'px')

    // 加载期间用户继续滚动：补偿加在当前可见内容上，不把视图拉回请求时的位置。
    scroller.scrollTop = 200
    await frame()
    scroller.scrollTop = 900
    await frame()
    const moving = firstVisible(id)
    const movingTop = moving.getBoundingClientRect().top
    const heightBeforeScroll = scroller.scrollHeight
    const loadsBeforeScroll = loadsOf(id)
    await waitFor(() => loadsOf(id) === loadsBeforeScroll + 1, id + ': page arrives while the user keeps scrolling')
    await frame()
    const insertedWhileScrolling = scroller.scrollHeight - heightBeforeScroll
    const movedDrift = moving.getBoundingClientRect().top - movingTop
    if (Math.abs(movedDrift) > 1) throw new Error(id + ': user-scrolled view moved by ' + movedDrift + 'px after prepending ' + insertedWhileScrolling + 'px')

    // 一路滚到最早一轮：继续请求直到没有更早轮次，然后确认不再请求。
    while (fixture(id).dataset.hasOlder === 'true') {
      const before = loadsOf(id)
      scroller.scrollTop = 0
      await waitFor(() => loadsOf(id) === before + 1 || fixture(id).dataset.hasOlder === 'false', id + ': page while exhausted check')
    }
    await frame()
    if (countOf(id) !== TOTAL) throw new Error(id + ': exhausted timeline must hold every turn, got ' + countOf(id))
    const settled = loadsOf(id)
    scroller.scrollTop = 0
    await frame()
    await new Promise((resolve) => setTimeout(resolve, 200))
    if (loadsOf(id) !== settled) throw new Error(id + ': kept loading after reaching the first turn')
    return { id, turns: countOf(id), loads: settled, insertedAbove: inserted, anchorDriftPx: Math.round(drift * 100) / 100, liveAppendDriftPx: Math.round(appendDrift * 100) / 100 }
  }

  const reading = await run('fixture-reading')
  // 持续失败时只允许一次自动补页；重试要靠用户自己滚动或点按钮。
  await new Promise((resolve) => setTimeout(resolve, 400))
  const attempts = Number(fixture('fixture-failing').dataset.attempts)
  if (attempts !== 1) throw new Error('fixture-failing: auto-retried a failed page ' + attempts + ' times')
  return { reading, failedPageAttempts: attempts }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map((name) => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error',
    worker: { format: 'es' },
    esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: {
        entry: join(root, 'scripts/fixtures/history-autoload-smoke.tsx'),
        formats: ['iife'],
        name: 'ScryHistoryAutoload',
        fileName: () => 'fixture.js',
        cssFileName: 'fixture'
      }
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
      const win = new BrowserWindow({ show: false, width: 1200, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseHistoryAutoload.toString()})(${PAGE}, ${TOTAL})`)})
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
    const timer = setTimeout(() => { child.kill('SIGTERM') }, 60_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`History autoload UI failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
