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
  const panel = document.querySelector('.background-work-panel')
  // The approved design uses two-row cards rather than the old single-line list.
  for (const card of panel.querySelectorAll('.background-work-task')) {
    const height = card.getBoundingClientRect().height
    check(height <= (innerWidth > 600 ? 80 : 110), `Two-row task card is not compact: ${height}px`)
  }
  check(!panel.innerText.includes('启动回执') && !panel.innerText.includes('清单'), 'Technical evidence is visible by default')
  const details = panel.querySelector('details')
  details.querySelector('summary').click()
  await wait(() => details.open)
  check(details.querySelectorAll('dt').length === 2 && details.innerText.includes('回执时间'), 'Expanded details must contain only task ID and receipt time')
  details.querySelector('summary').click()
  await wait(() => !details.open)
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
  const unsupported = document.querySelector('.background-work-panel')
  check(!unsupported.innerText.includes('未验证'), 'Unavailable-control explanation is still permanently visible')
  unsupported.querySelector('summary').click()
  await wait(() => unsupported.querySelector('details').open)
  check(unsupported.querySelector('details').querySelectorAll('dt').length === 2, 'Task details contain more than ID and receipt time')
  unsupported.querySelector('summary').click()
  await wait(() => !unsupported.querySelector('details').open)
  click('#pi-wait')
  await wait(() => status() === '等待子 Agent')
  check(document.querySelector('.background-work-name').textContent === 'worker', 'Pi child identity missing')
  check(!document.querySelector('[aria-label="停止任务 child"]'), 'Pi exposes unsupported child stop')
  check(!document.querySelector('.skeleton'), 'Pi waiting looks like model generation')
  document.querySelector('.background-work-details summary').click()
  await wait(() => document.querySelector('.background-work-details').open)
  check(!document.querySelector('.background-work-panel').innerText.includes('不可单独停止'), 'Pi still shows the removed capability explanation')
  click('#resume')
  await wait(() => status() === '运行中')
  click('#done')
  await wait(() => !document.querySelector('.run-status') && !document.querySelector('.background-work-panel'))
  return { compactDisclosure: true, viewport: [innerWidth, innerHeight], waitingWithoutSkeleton: true, stopAcknowledgmentNotTerminal: true, targetedStop: true, quietNotFailure: true, resumeAndArchive: true, unknownVersion: true, piWaitAndResume: true }
}

async function exerciseCompactCard(win) {
  const evaluate = (fn) => win.webContents.executeJavaScript(`(${fn.toString()})()`)
  const settle = () => evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const click = async (selector) => {
    const point = await win.webContents.executeJavaScript(`(async () => {
      const target = document.querySelector(${JSON.stringify(selector)})
      if (!target) throw new Error('Missing native input target')
      target.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const rect = target.getBoundingClientRect()
      const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2)
      if (!target.contains(document.elementFromPoint(x, y))) throw new Error('Native input target is obscured')
      return { x, y }
    })()`)
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await settle()
  }
  const check = (ok, message) => { if (!ok) throw new Error(`Compact task card: ${message}`) }
  await click('#new-run')
  const longName = await evaluate(() => {
    const name = document.querySelector('.background-work-name')
    return { truncated: name.scrollWidth > name.clientWidth, overflow: getComputedStyle(name).textOverflow }
  })
  check(longName.truncated && longName.overflow === 'ellipsis', 'Long task name does not truncate safely')
  const stopSnapshot = () => evaluate(() => ({
    calls: Number(document.querySelector('#fixture').dataset.stops),
    disabled: document.querySelector('[aria-label="停止任务 a"]').disabled,
    status: document.querySelector('.background-work-state').textContent
  }))
  const stopsBefore = (await stopSnapshot()).calls
  await click('[aria-label="停止任务 a"]')
  const stopped = await stopSnapshot()
  check(stopped.calls === stopsBefore + 1 && stopped.disabled && stopped.status === '已请求停止', 'Native targeted stop lost its acknowledgment boundary')
  await click('#new-run')
  await click('#stop-rejected')
  await click('[aria-label="停止任务 a"]')
  const rejected = await stopSnapshot()
  check(!rejected.disabled && rejected.status === '停止请求被拒绝', 'An explicit rejection incorrectly locked out a new stop request')
  await click('[aria-label="停止任务 a"]')
  check((await stopSnapshot()).calls === rejected.calls + 1, 'Explicit rejection did not allow a subsequent user request')
  await click('#new-run')
  await click('#stop-throws')
  await click('[aria-label="停止任务 a"]')
  const unknown = await stopSnapshot()
  check(unknown.disabled && unknown.status === '停止待确认', 'Rejected transport promise did not preserve the unknown stop boundary')
  await click('[aria-label="停止任务 a"]')
  check((await stopSnapshot()).calls === unknown.calls, 'Unknown stop result permitted a repeated write')
  await click('#pi-wait')
  const compact = await evaluate(() => {
    const panel = document.querySelector('.background-work-panel')
    return {
      text: panel.innerText,
      status: panel.querySelector('.background-work-state').textContent,
      provider: panel.querySelector('.background-work-provider').textContent,
      age: panel.querySelector('.background-work-age')?.textContent,
      detailsClosed: !panel.querySelector('details').open,
      unsupportedButton: !!panel.querySelector('button')
    }
  })
  check(compact.status === '等待结果' && compact.provider === 'Pi' && compact.detailsClosed && !compact.unsupportedButton, 'Pi identity, state or supported controls are incorrect')
  check(compact.age === '已观测 <1m', 'Freshly received task did not show its observation age immediately')
  for (const removed of ['不可单独停止', '计时依据', '状态依据', '停止限制', '观测范围']) {
    check(!compact.text.includes(removed), `Removed copy is still visible: ${removed}`)
  }
  await click('.background-work-details summary')
  const opened = await evaluate(() => ({
    open: document.querySelector('.background-work-details').open,
    fields: [...document.querySelectorAll('.background-work-evidence dt')].map(node => node.textContent),
    id: document.querySelector('.background-work-evidence code').textContent
  }))
  check(opened.open && JSON.stringify(opened.fields) === JSON.stringify(['任务 ID', '回执时间']) && opened.id === 'child', 'Native disclosure did not expose exactly the requested evidence')
  check(await evaluate(() => document.activeElement === document.querySelector('.background-work-details summary')), 'Native disclosure click did not focus its summary')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await settle()
  check(await evaluate(() => !document.querySelector('.background-work-details').open), 'Keyboard Enter did not collapse the focused disclosure')
  const colors = []
  for (const theme of ['light', 'dark']) {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    win.setSize(640, 700)
    await settle()
    const layout = await evaluate(() => {
      const card = document.querySelector('.background-work-task')
      const header = card.querySelector('.background-work-head')
      return {
        background: getComputedStyle(card).backgroundColor,
        overflow: card.scrollWidth > card.clientWidth || header.scrollWidth > header.clientWidth,
        focus: document.activeElement === card.querySelector('summary')
      }
    })
    check(!layout.overflow && layout.focus, `${theme} narrow card overflows or lost keyboard focus`)
    colors.push(layout.background)
  }
  check(colors[0] !== colors[1], 'Light and dark themes did not use distinct project surfaces')
  win.setSize(960, 800)
  await settle()
  return { nativeDisclosure: true, keyboardCollapse: true, nativeTargetedStop: true, rejectionAllowsUserRetry: true, transportUnknownLocked: true, piUnavailableControlHidden: true, onlyIdAndReceipt: true, longNameEllipsis: true, narrowThemes: ['light', 'dark'] }
}

async function exerciseClock() {
  const check = (ok, message) => { if (!ok) throw new Error(`Chat clock: ${message}`) }
  const wait = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Chat clock timed out: ${predicate}`)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }
  const elapsed = () => document.querySelector('.run-status-elapsed')?.textContent
  const clock = window.chatClock
  await wait(() => elapsed() === '00:00' && clock.timers === 1)
  const input = document.querySelector('textarea')
  input.focus()
  input.setSelectionRange(1, 3)
  const reads = clock.turnReads
  clock.advance(1000)
  await wait(() => elapsed() === '00:01')
  check(clock.turnReads === reads, `timer re-read transcript: ${reads} -> ${clock.turnReads}`)
  check(document.activeElement === input && input.selectionStart === 1 && input.selectionEnd === 3, 'tick changed composer focus/selection')
  clock.visibility('hidden')
  check(clock.timers === 0, 'hidden page kept a clock timer')
  clock.advance(60_000)
  check(elapsed() === '00:01', 'hidden clock still refreshed')
  clock.visibility('visible')
  await wait(() => elapsed() === '01:01')
  check(clock.timers === 1 && clock.turnReads === reads, 'visibility recovery restarted transcript work or duplicate timers')
  document.querySelector('#new-run').click()
  await wait(() => elapsed() === '00:00' && clock.timers === 1)
  clock.advance(2000)
  await wait(() => elapsed() === '00:02')
  document.querySelector('#unknown-start').click()
  await wait(() => !elapsed() && clock.timers === 0)
  check(document.querySelector('.run-status'), 'missing timestamp hid the running status')
  document.querySelector('#new-run').click()
  await wait(() => elapsed() === '00:00' && clock.timers === 1)
  document.querySelector('#done').click()
  await wait(() => !document.querySelector('.run-status') && clock.timers === 0)
  clock.visibility('hidden')
  clock.visibility('visible')
  check(clock.timers === 0, 'unmounted clock leaked a visibility listener')
  return { transcriptReadsPerTick: 0, focusPreserved: true, hiddenPaused: true, wallTimeRecovery: true, runSwitch: true, unknownTimestamp: true, terminalCleanup: true }
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
  if (scenario === 'batch') {
    click('#trace-batch')
    await wait(() => state().items === 'waiting,batch-a,batch-b')
    check(state().items === 'waiting,batch-a,batch-b', 'Trace batch lost FIFO order or an event')
  } else if (scenario.startsWith('sidebar-')) {
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
