import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { exerciseChatPreviewDom } from './chat-preview-ui-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await mkdtemp(join(tmpdir(), 'scry-image-ui-'))

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
  const replaceSource = async (text) => {
    await click(source)
    // sendInputEvent queues native focus/selection work. insertText requires the
    // textarea to actually own both before it can replace the current draft.
    await wait(`document.activeElement === document.querySelector('${source}')`)
    contents.selectAll()
    await wait(`document.querySelector('${source}').selectionStart === 0 && document.querySelector('${source}').selectionEnd === document.querySelector('${source}').value.length`)
    await contents.insertText(text)
  }
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
  await replaceSource('# Edited preview')
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
  await replaceSource('# Unsaved reload draft')
  await wait(`document.querySelector('#workspace-fixture').dataset.dirty === 'true'`)
  await check(`document.querySelector('${source}').value === '# Unsaved reload draft' && document.querySelector('#workspace-fixture h1')?.textContent === 'Unsaved reload draft'`, 'Native replacement did not update both the draft and preview')
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
  return { previewDefault: true, fullSize: true, borderlessPreview: true, compactLeftActions: true, themes: ['dark', 'light'], keyboardReloadFocus: true, reloadDiscardProtection: true, reloadDraftApplied: true, nativeToggleAndEdit: true, draftRetained: true, saveWhileCollapsed: true, fileReset: true, plainText: true, readOnly: true, paged: true }
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
        let result = await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseChatPreviewDom.toString()})()` )})
        result.nativeComposerEnter = await (${exerciseNativeComposerEnter.toString()})(win.webContents)
        result.workspace = await (${exerciseNativeWorkspace.toString()})(win.webContents, ${JSON.stringify(process.env.SCRY_WORKSPACE_UI_SCREENSHOT ?? '')})
        win.setSize(560, 480)
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        result = { wide: result, narrow: await win.webContents.executeJavaScript(${JSON.stringify(`(${exerciseChatPreviewDom.toString()})()` )}) }
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
