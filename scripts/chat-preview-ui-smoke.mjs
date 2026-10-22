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
      await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === `${125 + i * 25}%`)
    }
    check(query('放大图片').disabled, 'Zoom upper bound missing')
    check(stage.scrollHeight > stage.clientHeight || stage.scrollWidth > stage.clientWidth, 'Zoom is clipped instead of scrollable')
    stage.scrollTo(stage.scrollWidth, stage.scrollHeight)
    check(stage.scrollTop > 0 || stage.scrollLeft > 0, 'Zoomed edges are unreachable')
    check(visible(close) && visible(query('缩小图片')), 'Zoom moved controls off screen')
    for (let i = 0; i < 6; i++) {
      query('缩小图片').click()
      await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === `${175 - i * 25}%`)
    }
    check(query('缩小图片').disabled, 'Zoom lower bound missing')
    dialog.querySelector('.image-lightbox-reset').click()
    await waitFor(() => dialog.querySelector('.image-lightbox-reset').textContent === '100%')
    check(!query('缩小图片').disabled, 'Reset zoom did not restore the zoom range')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Escape did not restore thumbnail focus')
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
    check(document.querySelector('.image-lightbox-reset').textContent === '100%', 'Reopen retained stale zoom')
    query('关闭图片预览').click()
    await waitFor(() => !document.querySelector('.image-lightbox'))
    thumb.click()
    await waitFor(() => document.querySelector('.image-lightbox'))
    document.querySelector('.modal-overlay').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await waitFor(() => !document.querySelector('.image-lightbox'))
    check(document.activeElement === thumb, 'Backdrop close did not restore focus')
  }
  // macOS 标题栏前 52px 是 -webkit-app-region 拖拽带：落在那里的原生点击会变成窗口拖动，
  // 按钮收不到 click。关闭按钮必须整块在拖拽带下方，覆盖层自己也要声明 no-drag。
  document.documentElement.dataset.platform = 'macos'
  thumbs[0].click()
  await waitFor(() => document.querySelector('.image-lightbox-stage img')?.style.visibility === 'visible')
  const platformDialog = document.querySelector('.image-lightbox')
  const platformClose = query('关闭图片预览')
  check(rect(platformClose).top >= 52, 'Preview close button sits inside the macOS titlebar drag strip')
  check(
    getComputedStyle(platformDialog.parentElement).getPropertyValue('-webkit-app-region') === 'no-drag',
    'Preview overlay does not claim no-drag over the titlebar drag strip'
  )
  delete document.documentElement.dataset.platform
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitFor(() => !document.querySelector('.image-lightbox'))
  const piTurns = document.querySelectorAll('#pi-feedback-fixture .turn-assistant')
  check(piTurns.length === 2, 'Pi live/history feedback fixtures did not mount')
  for (const turn of piTurns) {
    check(!turn.textContent.includes('TPS 25.7'), 'Pi info notification leaked into conversation')
    check(turn.textContent.includes('已完成代码检查。'), 'Pi reply was hidden with notification')
    check(turn.querySelector('[aria-label="Pi 扩展通知"]')?.textContent.includes('扩展警告内容'), 'Pi warning was hidden or mislabeled')
    const commands = turn.querySelectorAll('[aria-label="Pi 命令反馈"]')
    check(commands.length === 1 && commands[0].textContent.includes('/test-command 已执行'), 'Pi command feedback was hidden or mixed with notifications')
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
  check(input.dataset.sends == null && input.value === draft, 'IME confirmation submitted or changed the draft')
  // Both keydowns run in this same task: no timing sleep may hide a swallowed key.
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  check(enter().defaultPrevented, 'Send Enter leaked a default newline')
  check(input.dataset.sends === '1', 'A fresh Enter after IME confirmation was swallowed')
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
  input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '输入' }))
  input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
  enter()
  check(input.dataset.sends === '2', 'Enter after Space confirmed the IME candidate was swallowed')
  await waitFor(() => input.value === '')
  return { imeConfirmationProtected: true, immediateEnterSends: true, spaceConfirmationSends: true, viewport: [innerWidth, innerHeight], portraitAndLandscape: true, attachmentFlow: true, viewportOverlay: true, zoomScroll: true, closePaths: true, focusRestore: true, markdownDeferred: true, toolsDeferred: true, projectPickerLifecycle: true, promptHistoryNavigation: true, piFeedbackSeparated: true }
}

async function exerciseNativeComposerEnter(contents) {
  const read = (expression) => contents.executeJavaScript(expression)
  const point = await read(`(() => {
    const input = document.querySelector('#composer-project textarea');
    input.scrollIntoView({ block: 'center' });
    const rect = input.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    if (document.elementFromPoint(x, y) !== input) throw new Error('Composer textarea obscured');
    return { x, y };
  })()`)
  contents.focus()
  contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) throw new Error(`Native composer Enter timed out: ${expression}`)
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  await wait(`document.activeElement === document.querySelector('#composer-project textarea')`)
  const rendersBeforeTyping = await read(`document.querySelector('#composer-project').dataset.renders`)
  await contents.insertText('Native Enter regression')
  await wait(`document.querySelector('#composer-project textarea').value === 'Native Enter regression'`)
  const rendersAfterTyping = await read(`document.querySelector('#composer-project').dataset.renders`)
  if (rendersAfterTyping !== rendersBeforeTyping) throw new Error('Typing rerendered the conversation host')
  // Composition is simulated; the following key release and send are native Chromium input.
  await read(`(() => {
    const input = document.querySelector('#composer-project textarea');
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '消息' }));
  })()`)
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
  await wait(`document.querySelector('#composer-project textarea').dataset.sends === '3' && document.querySelector('#composer-project textarea').value === ''`)
  if (!await read(`document.querySelector('#composer-project textarea').dataset.submitted === 'Native Enter regression'`)) {
    throw new Error('Immediate Enter submitted a stale draft')
  }
  return { hostRendersWhileTyping: 0, latestDraftSubmitted: true }
}

async function exerciseNativeWorkspace(contents, screenshotPath) {
  const read = (expression) => contents.executeJavaScript(expression)
  const check = async (expression, message) => {
    if (!await read(expression)) throw new Error(message)
  }
  const wait = async (expression) => {
    const deadline = Date.now() + 5000
    while (!await read(expression)) {
      if (Date.now() > deadline) {
        const state = await read(`({ value: document.querySelector('#workspace-fixture textarea')?.value, heading: document.querySelector('#workspace-fixture h1')?.textContent, dirty: document.querySelector('#workspace-fixture').dataset.dirty, focused: document.activeElement?.outerHTML })`)
        throw new Error(`Workspace timed out: ${expression}; ${JSON.stringify(state)}`)
      }
      await read('new Promise(resolve => requestAnimationFrame(resolve))')
    }
  }
  const click = async (selector) => {
    const point = await read(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({ block: 'center' });
      const rect = element.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
      if (!element.contains(document.elementFromPoint(x, y))) throw new Error('Workspace control obscured: ' + ${JSON.stringify(selector)});
      return { x, y };
    })()`)
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  }
  const toggle = '#workspace-fixture [aria-expanded]'
  const source = '#workspace-fixture textarea'
  const save = '#workspace-fixture .workspace-editorbar .primary'
  await read(`document.querySelector('#workspace-fixture').hidden = false`)
  await wait(`document.querySelector('#workspace-fixture h1')?.textContent === 'Preview first'`)
  await check(`!document.querySelector('${source}') && !document.querySelector('${save}')`, 'Markdown must default to preview only')
  await check(`(() => {
    const body = document.querySelector('#workspace-fixture .workspace-editorbody').getBoundingClientRect();
    const preview = document.querySelector('#workspace-fixture .workspace-preview').getBoundingClientRect();
    return Math.abs(body.width - preview.width) < 1 && Math.abs(body.height - preview.height) < 1;
  })()`, 'Collapsed preview must fill both dimensions')
  for (const theme of ['dark', 'light']) {
    await read(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await read(`Promise.all(Array.from(document.querySelectorAll('#workspace-fixture .workspace-editorbar button')).flatMap(button => button.getAnimations()).map(animation => animation.finished)).then(() => true)`)
    await check(`(() => {
      const root = document.querySelector('#workspace-fixture');
      const rules = root.querySelectorAll('.workspace-head, .workspace-editorbar, .workspace-preview-content h1, .workspace-preview-content h2, .workspace-preview-content hr');
      const actions = root.querySelector('.workspace-editor-actions');
      const status = root.querySelector('.workspace-editorbar > span');
      const buttons = actions?.querySelectorAll('button');
      return rules.length === 6 && Array.from(rules).every(element => {
        const style = getComputedStyle(element);
        return parseFloat(style.borderTopWidth) === 0 && parseFloat(style.borderBottomWidth) === 0;
      }) && buttons?.length === 2 && Array.from(buttons).every(button => {
        const style = getComputedStyle(button);
        return button.getBoundingClientRect().height <= 32 && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }) && actions.getBoundingClientRect().left < status.getBoundingClientRect().left
        && root.scrollWidth <= root.clientWidth;
    })()`, 'Workspace rules or compact left-aligned action buttons regressed: ' + theme)
    const alignment = await read(`(() => {
      const root = document.querySelector('#workspace-fixture');
      const back = root.querySelector('.workspace-head > button').getBoundingClientRect();
      const action = root.querySelector('.workspace-editor-actions > button').getBoundingClientRect();
      const content = root.querySelector('.workspace-preview-content');
      return { backLeft: back.left, actionLeft: action.left,
        contentLeft: content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingLeft),
        backHeight: back.height, actionHeight: action.height };
    })()`)
    if (Math.abs(alignment.backLeft - alignment.actionLeft) > 1 || Math.abs(alignment.actionLeft - alignment.contentLeft) > 1 || Math.abs(alignment.backHeight - alignment.actionHeight) > 1) {
      throw new Error('Workspace left alignment ' + theme + ': ' + JSON.stringify(alignment))
    }
    if (screenshotPath) {
      const width = await read('innerWidth')
      require('node:fs').writeFileSync(screenshotPath + '-' + width + '-' + theme + '.png', (await contents.capturePage()).toPNG())
    }
  }
  await read(`document.documentElement.dataset.theme = 'dark'`)
  await click(toggle)
  await wait(`document.querySelector('${toggle}').getAttribute('aria-expanded') === 'true' && document.querySelector('${source}')`)
  contents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
  contents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
  await wait(`document.activeElement === document.querySelector('#workspace-fixture .workspace-reload')`)
  await click(source)
  await wait(`document.activeElement === document.querySelector('${source}')`)
  contents.selectAll()
  await wait(`document.querySelector('${source}').selectionStart === 0 && document.querySelector('${source}').selectionEnd === document.querySelector('${source}').value.length`)
  await contents.insertText('# Edited preview')
  await wait(`document.querySelector('#workspace-fixture h1')?.textContent === 'Edited preview' && document.querySelector('#workspace-fixture').dataset.dirty === 'true'`)
  await click(toggle)
  await wait(`!document.querySelector('${source}')`)
  await check(`!document.querySelector('${save}').disabled`, 'Hidden unsaved source lost its save action')
  await click(toggle)
  await wait(`document.querySelector('${source}')?.value === '# Edited preview'`)
  await click(toggle)
  await wait(`!document.querySelector('${source}')`)
  await read('window.__holdWorkspaceWrite()')
  await click(save)
  await wait('window.__workspaceWritePending()')
  await check(`document.querySelector('#workspace-fixture').dataset.dirty === 'true'`, 'Save completed before the native dirty state was observed')
  await read('window.__releaseWorkspaceWrite()')
  await wait(`document.querySelector('#workspace-fixture').dataset.dirty === 'false' && !document.querySelector('${save}')`)
  await click(toggle)
  await wait(`document.querySelector('${source}')`)
  await click(source)
  contents.selectAll()
  await contents.insertText('# Unsaved reload draft')
  await wait(`document.querySelector('#workspace-fixture').dataset.dirty === 'true'`)
  await read(`globalThis.workspaceOriginalConfirm = window.confirm; window.confirm = () => false; true`)
  await click('#workspace-fixture .workspace-reload')
  await check(`document.querySelector('${source}').value === '# Unsaved reload draft' && document.querySelector('#workspace-fixture').dataset.dirty === 'true'`, 'Cancelled reload discarded the draft')
  await read(`window.confirm = () => true; true`)
  await click('#workspace-fixture .workspace-reload')
  await wait(`document.querySelector('${source}').value === '# Edited preview' && document.querySelector('#workspace-fixture').dataset.dirty === 'false'`)
  await read(`window.confirm = globalThis.workspaceOriginalConfirm; delete globalThis.workspaceOriginalConfirm`)
  for (const file of ['second.MDX', 'preview.md']) {
    await click(`[data-file="${file}"]`)
    await wait(`document.querySelector('#workspace-fixture .workspace-title b')?.textContent === '${file}' && document.querySelector('#workspace-fixture h1')?.textContent === 'Edited preview'`)
    await check(`!document.querySelector('${source}')`, 'New Markdown file did not reset to preview')
  }
  await click('[data-file="notes.txt"]')
  await wait(`document.querySelector('${source}')?.value === 'Plain text'`)
  await check(`!document.querySelector('${toggle}') && !document.querySelector('${source}').readOnly`, 'Plain text editing regressed')
  await click('[data-file="readonly.md"]')
  await wait(`document.querySelector('#workspace-fixture h1')?.textContent === 'Preview first'`)
  await check(`!document.querySelector('${source}')`, 'Read-only Markdown must default to preview')
  await click(toggle)
  await wait(`document.querySelector('${source}')?.readOnly`)
  await check(`!document.querySelector('${save}')`, 'Read-only source exposed save')
  await click('[data-file="large.md"]')
  await wait(`document.querySelector('${source}')?.value === '# Paged source'`)
  await check(`document.querySelector('${source}').readOnly && !document.querySelector('${toggle}')`, 'Paged read-only view regressed')
  await read(`document.querySelector('#workspace-fixture').hidden = true`)
  return { previewDefault: true, fullSize: true, borderlessPreview: true, compactLeftActions: true, themes: ['dark', 'light'], keyboardReloadFocus: true, reloadDiscardProtection: true, nativeToggleAndEdit: true, draftRetained: true, saveWhileCollapsed: true, fileReset: true, plainText: true, readOnly: true, paged: true }
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
        result.nativeComposerEnter = await (${exerciseNativeComposerEnter.toString()})(win.webContents)
        result.workspace = await (${exerciseNativeWorkspace.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_WORKSPACE_UI_SCREENSHOT ?? '')})
        win.setSize(560, 480)
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        result = { wide: result, narrow: await win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()` )}) }
        result.narrow.nativeComposerEnter = await (${exerciseNativeComposerEnter.toString()})(win.webContents)
        result.narrow.workspace = await (${exerciseNativeWorkspace.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_WORKSPACE_UI_SCREENSHOT ?? '')})
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
