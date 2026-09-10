import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-background-ui-'))

// Production components in sandboxed Electron; synthetic events, no live Provider or user data.
async function exercise() {
  const check = (ok, message) => { if (!ok) throw new Error(message) }
  const wait = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Timed out: ${predicate}`)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }
  const click = (selector) => document.querySelector(selector).click()
  const status = () => document.querySelector('.run-status b')?.textContent
  await wait(() => document.querySelector('#new-run'))
  click('#new-run')
  await wait(() => status() === '等待后台任务')
  check(!document.querySelector('.skeleton'), 'Background wait still shows generation skeleton')
  check(!document.querySelector('.model-text.streaming'), 'Background wait still shows streaming cursor')
  check(document.querySelectorAll('.background-work-task').length === 2, 'Missing observed tasks')
  const input = document.querySelector('textarea')
  const taskStop = document.querySelector('[aria-label="停止任务 a"]')
  taskStop.scrollIntoView({ block: 'center' })
  const box = taskStop.getBoundingClientRect()
  check(box.left >= 0 && box.right <= innerWidth + 1, 'Long task description pushed stop control out of viewport')
  const countBefore = Number(document.querySelector('#fixture').dataset.stops)
  taskStop.click()
  await wait(() => taskStop.disabled)
  await wait(() => Number(document.querySelector('#fixture').dataset.stops) === countBefore + 1)
  taskStop.click()
  check(Number(document.querySelector('#fixture').dataset.stops) === countBefore + 1, 'Stop request replayed')
  check(document.querySelectorAll('.background-work-task').length === 2, 'Acknowledgment incorrectly removed task')
  check(!document.querySelector('[aria-label="停止任务 b"]').disabled, 'Stopping task a disabled unrelated task b')
  click('#quiet')
  await wait(() => status() === '后台状态待确认')
  check(document.querySelector('.background-work-panel').textContent.includes('不代表失败') || document.querySelector('.run-status-hint').textContent.includes('不代表失败'), 'Silence shown as failure')
  check(document.querySelector('textarea') === input, 'Status change remounted input')
  click('#terminal-a')
  await wait(() => document.querySelectorAll('.background-work-task').length === 1)
  check(document.querySelector('[aria-label="停止任务 b"]'), 'Wrong task removed')
  click('#resume')
  await wait(() => status() === '运行中' && document.querySelector('.skeleton'))
  const wholeBefore = Number(document.querySelector('#fixture').dataset.wholeStops)
  click('.run-status-stop')
  await wait(() => Number(document.querySelector('#fixture').dataset.wholeStops) === wholeBefore + 1)
  check(document.querySelector('.run-status-stop').textContent.includes('停止本轮'), 'Whole-run stop scope is ambiguous')
  click('#done')
  await wait(() => !document.querySelector('.run-status'))
  check(!document.querySelector('.background-work-panel'), 'Archived turn still exposes live task controls')
  click('#new-run')
  await wait(() => document.querySelector('[aria-label="停止任务 a"]'))
  check(!document.querySelector('[aria-label="停止任务 a"]').disabled, 'New run inherited stale stop state')
  click('#unsupported')
  await wait(() => !document.querySelector('[aria-label="停止任务 a"]'))
  check(document.querySelector('.background-work-panel').textContent.includes('单任务停止未验证'), 'Unknown version advertised unsupported control')
  return { viewport: [innerWidth, innerHeight], waitingWithoutSkeleton: true, stopAcknowledgmentNotTerminal: true, targetedStop: true, quietNotFailure: true, resumeAndArchive: true, unknownVersion: true }
}

async function exerciseRecovery(scenario) {
  const check = (ok, message) => { if (!ok) throw new Error(`${scenario}: ${message}`) }
  const tick = () => new Promise((resolve) => requestAnimationFrame(resolve))
  const state = () => document.querySelector('#recovery')?.dataset
  const wait = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`${scenario}: timed out: ${predicate}`)
      await tick()
    }
  }
  const click = (selector) => document.querySelector(selector).click()
  await wait(() => state()?.restoring === 'false' && state().run === 'recovery')
  if (scenario.startsWith('sidebar-')) {
    click('#sidebar-event')
    await wait(() => state().sidebarPhase === 'working')
    if (scenario !== 'sidebar-delta') {
      click(scenario === 'sidebar-done' ? '#finish-done' : '#finish-error')
      await wait(() => state().sidebarPhase === 'none')
    }
    click('#sidebar-hydrate')
    click('#sidebar-old')
    await tick()
    check(state().sidebarPhase === (scenario === 'sidebar-delta' ? 'working' : 'none'), 'Stale hydration/event overwrote live state')
    click('#sidebar-inactive')
    await wait(() => state().sidebarPhase === 'none')
    click('#sidebar-old')
    click('#sidebar-event')
    await tick()
    check(state().sidebarPhase === 'none', 'Late snapshot reopened inactive/terminal state')
  } else {
    click('#begin-recovery')
    if (scenario === 'done' || scenario === 'error') {
      click(scenario === 'done' ? '#finish-done' : '#finish-error')
      await wait(() => state().done === 'true')
      click('#resolve-first')
      await wait(() => state().acks === '1')
      check(state().done === 'true' && state().busy === 'false', 'Snapshot reopened completed turn/composer')
      if (scenario === 'error') check(state().error === 'transport lost', 'Snapshot erased terminal error')
    } else if (scenario === 'reverse') {
      click('#server-new')
      click('#begin-recovery')
      click('#resolve-last')
      await wait(() => state().phase === 'working' && state().acks === '1')
      click('#resolve-first')
      await tick()
      check(state().phase === 'working' && state().acks === '1', 'Older recovery overwrote or acknowledged newer state')
    } else {
      click('#switch-focus')
      await wait(() => state().run === 'other')
      click('#resolve-first')
      await tick()
      check(state().run === 'other' && !state().acks, 'Previous focus recovery was applied/acknowledged')
    }
  }
  return { scenario, passed: true }
}

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
      const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const wide = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        win.setSize(640, 700)
        const narrow = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        const recovery = []
        for (const scenario of ['done', 'error', 'reverse', 'focus', 'sidebar-done', 'sidebar-error', 'sidebar-delta']) {
          await win.loadFile(${JSON.stringify(join(temp, 'index.html'))}, { query: { mode: 'recovery' } })
          recovery.push(await win.webContents.executeJavaScript('(' + ${JSON.stringify(exerciseRecovery.toString())} + ')(' + JSON.stringify(scenario) + ')'))
        }
        console.log('SCRY_BACKGROUND_UI_RESULT=' + JSON.stringify({ wide, narrow, recovery }))
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
