import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-image-ui-'))



// Production React/CSS in an isolated sandboxed Electron window, not an App acceptance test.
async function exercise() {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const waitFor = async (predicate) => {
    const deadline = performance.now() + 5000
    while (!predicate()) {
      if (performance.now() > deadline) throw new Error(`Timed out: ${predicate.toString()}`)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }
  const query = (label) => document.querySelector(`[aria-label="${label}"]`)
  const rect = (element) => element.getBoundingClientRect()
  const visible = (element) => {
    const box = rect(element)
    return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
  }
  await waitFor(() => document.querySelectorAll('.user-attachment').length === 2)
  const thumbs = [...document.querySelectorAll('.user-attachment')]
  const thumbnailRows = new Set(thumbs.map((thumb) => Math.round(rect(thumb).top)))
  if (innerWidth >= 900) check(thumbnailRows.size === 1, 'Image thumbnails wrapped before filling the row')
  else check(thumbnailRows.size === 2, 'Image thumbnails did not wrap in the narrow layout')
  for (const thumb of thumbs) {
    thumb.focus()
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
    const dialog = document.querySelector('.image-lightbox')
    const overlay = dialog.parentElement
    const stage = dialog.querySelector('.image-lightbox-stage')
    const image = stage.querySelector('img')
    const close = query('关闭图片预览')
    check(overlay.parentElement === document.body, 'Preview is still inside contained transcript')
    check(rect(overlay).width === document.documentElement.clientWidth && rect(overlay).height === document.documentElement.clientHeight, 'Overlay does not cover viewport')
    check(overlay.contains(document.elementFromPoint(document.documentElement.clientWidth - 5, 5)), 'Summary remains above overlay')
    check(visible(close) && visible(query('放大图片')), 'Preview controls escaped viewport')
    check(rect(image).width <= stage.clientWidth + 1 && rect(image).height <= stage.clientHeight + 1, 'Initial image does not fit')
    check(document.activeElement === close, 'Close did not receive initial focus')
    // Focus must stay in the dialog; image clicks must not dismiss it.
    thumbs[1].focus()
    // Hidden BrowserWindows do not emit native focusin; exercise the document guard.
    thumbs[1].dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    check(dialog.contains(document.activeElement), 'Focus escaped modal')
    image.click()
    check(document.querySelector('.image-lightbox') === dialog, 'Image click dismissed preview')
    for (let i = 0; i < 4; i++) {
      query('放大图片').click()
      await waitFor(() => dialog.querySelector('.image-lightbox-zoom span').textContent === `${125 + i * 25}%`)
    }
    check(query('放大图片').disabled, 'Zoom upper bound missing')
    check(stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth, 'Zoom is clipped instead of scrollable')
    stage.scrollTo(stage.scrollWidth, stage.scrollHeight)
    check(stage.scrollTop > 0 || stage.scrollLeft > 0, 'Zoomed edges are unreachable')
    check(visible(close) && visible(query('缩小图片')), 'Zoom moved controls off screen')
    for (let i = 0; i < 6; i++) {
      query('缩小图片').click()
      await waitFor(() => dialog.querySelector('.image-lightbox-zoom span').textContent === `${175 - i * 25}%`)
    }
    check(query('缩小图片').disabled, 'Zoom lower bound missing')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Escape did not restore thumbnail focus')
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
    check(document.querySelector('.image-lightbox-zoom span').textContent === '100%', 'Reopen retained stale zoom')
    query('关闭图片预览').click()
    await waitFor(() => !document.querySelector('.image-lightbox'))
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox'))
    document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Backdrop close did not restore focus')
  }
  const pausedGoal = document.querySelector('#goal-paused-fixture')
  pausedGoal.hidden = false
  const termination = pausedGoal.querySelector('[role="status"]')
  check(visible(termination), 'Tool termination explanation is not visible')
  check(termination.textContent.includes('including after resume'), 'Lost the actual Goal recovery restriction')
  check(termination.textContent.includes('执行结束不代表目标已验证完成'), 'Tool settlement claims Goal completion')
  check(!pausedGoal.querySelector('.errline'), 'Tool termination still renders as a Provider error')
  check(!pausedGoal.textContent.includes('继续当前会话重试'), 'Goal pause still advises blind retry')
  pausedGoal.hidden = true
  const performanceFixture = document.querySelector('#performance-fixture')
  const formatWhole = performanceFixture.querySelector('.md-format-whole')
  check(formatWhole != null, 'Long Markdown did not defer full formatting')
  check(!performanceFixture.querySelector('h2'), 'Unsafe long Markdown formatted before user request')
  formatWhole.click()
  await waitFor(() => performanceFixture.querySelector('h2') != null)
  const toolGroup = performanceFixture.querySelector('.tool-group-row')
  check(performanceFixture.querySelectorAll('[data-trace-event-id]').length === 0, 'Collapsed tools mounted eagerly')
  toolGroup.click()
  await waitFor(() => performanceFixture.querySelectorAll('[data-trace-event-id]').length === 100)
  toolGroup.click()
  await waitFor(() => performanceFixture.querySelectorAll('[data-trace-event-id]').length === 0)
  const projectPicker = () => document.querySelector('#composer-project .composer-context')
  check(projectPicker() != null, 'New draft lost project selection')
  const input = document.querySelector('#composer-project textarea')
  const draft = input.value
  const enter = (options = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options })
    input.dispatchEvent(event)
    return event
  }
  check(!enter({ shiftKey: true }).defaultPrevented, 'Shift+Enter no longer allows a newline')
  check(enter({ repeat: true }).defaultPrevented, 'Repeated Enter leaked a default newline')
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  check(enter({ isComposing: true }).defaultPrevented, 'IME Enter leaked a default newline')
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '消息' }))
  check(enter().defaultPrevented, 'Post-composition Enter leaked a default newline')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(projectPicker() != null && input.value === draft, 'IME confirmation submitted or changed the draft')
  const compositionEndedAt = performance.now()
  await waitFor(() => performance.now() - compositionEndedAt >= 120)
  check(enter().defaultPrevented, 'Send Enter leaked a default newline')
  await waitFor(() => projectPicker() == null)
  check(document.querySelector('#composer-project textarea') === input, 'Hiding project selection remounted composer input')
  await waitFor(() => input.value === '')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await waitFor(() => input.value === '测试消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await waitFor(() => input.value === '更早的消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await waitFor(() => input.value === '测试消息')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await waitFor(() => input.value === '')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '手动输入')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await waitFor(() => input.value === '手动输入')
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await new Promise((resolve) => requestAnimationFrame(resolve))
  check(input.value === '手动输入', 'History replaced a non-empty draft')
  document.querySelector('#new-draft').click()
  await waitFor(() => projectPicker() != null)
  return { viewport: [innerWidth, innerHeight], portraitAndLandscape: true, attachmentFlow: true, viewportOverlay: true, zoomScroll: true, closePaths: true, focusRestore: true, markdownDeferred: true, toolsDeferred: true, projectPickerLifecycle: true, promptHistoryNavigation: true }
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
      lib: {
        entry: join(root, 'scripts/fixtures/image-lightbox-smoke.tsx'),
        formats: ['iife'],
        name: 'ScryRegression',
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
      const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        let result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )})
        win.setSize(560, 480)
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        result = { wide: result, narrow: await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )}) }
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
    const timer = setTimeout(() => { child.kill('SIGTERM') }, 30_000)
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      const result = output.match(/^SCRY_UI_SMOKE_RESULT=(.+)$/m)?.[1]
      if (code !== 0 || !result) reject(new Error(`Hidden UI fixture failed (${code ?? signal}):\n${output.slice(-8000)}`))
      else { console.log(result); resolve() }
    })
  })
} finally {
  await rm(temp, { recursive: true, force: true })
}
