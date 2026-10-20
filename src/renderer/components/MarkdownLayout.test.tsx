import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('keeps Markdown readable, selectable and file links operable in real Chromium', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scry-markdown-layout-'))
  try {
    await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: { '@shared': resolve('src/shared') } },
      esbuild: { jsx: 'automatic', jsxDev: false },
      build: {
        outDir: join(dir, 'bundle'),
        lib: {
          entry: resolve('src/renderer/components/fixtures/markdown-layout.tsx'),
          name: 'MarkdownLayoutTest',
          formats: ['iife'],
          fileName: () => 'fixture.js',
          cssFileName: 'fixture'
        }
      }
    })
    await writeFile(join(dir, 'index.html'), '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'"><link rel="stylesheet" href="./bundle/fixture.css"><div id="root"></div><script src="./bundle/fixture.js"></script>')
    const main = join(dir, 'main.cjs')
    await writeFile(main, `
      const { app, BrowserWindow } = require('electron')
      require(${JSON.stringify(resolve('scripts/hidden-electron-windows.cjs'))})(app)
      if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
      app.on('browser-window-focus', () => { console.error('UI fixture stole native window focus'); app.exit(1) })
      app.setPath('userData', ${JSON.stringify(join(dir, 'userData'))})
      app.whenReady().then(() => {
        const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
        if (!win.webContents.isOffscreen()) { console.error('Offscreen rendering is required'); app.exit(1); return }
        const contents = win.webContents
        const evaluate = (source) => contents.executeJavaScript(source)
        const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => resolve()))')
        const check = (ok, message) => { if (!ok) throw new Error(message) }
        const selectText = async (selector, start, end) => {
          const points = await evaluate(\`(() => {
            const node = document.querySelector('\${selector}').firstChild
            const point = offset => {
              const range = document.createRange()
              range.setStart(node, offset)
              range.setEnd(node, offset)
              const rect = range.getBoundingClientRect()
              return { x: Math.round(rect.x), y: Math.round(rect.y + rect.height / 2) }
            }
            return { start: point(\${start}), end: point(\${end}) }
          })()\`)
          contents.sendInputEvent({ type: 'mouseDown', ...points.start, button: 'left', clickCount: 1 })
          for (let step = 1; step <= 8; step++) {
            contents.sendInputEvent({ type: 'mouseMove', x: Math.round(points.start.x + (points.end.x - points.start.x) * step / 8), y: points.end.y, button: 'left', buttons: ['left'] })
          }
          contents.sendInputEvent({ type: 'mouseUp', ...points.end, button: 'left', clickCount: 1 })
          await settle()
          return evaluate('window.getSelection().toString()')
        }
        const testSelection = async () => {
          check(await selectText('td .md-file-ref code', 0, 10) === 'rate-aigc-', 'File name must support partial native drag selection')
          check(await evaluate('Number(document.body.dataset.opened ?? 0)') === 0, 'Selecting text must not open the file')
          contents.copy()
          await settle()
          check(await evaluate('document.body.dataset.copied') === 'rate-aigc-', 'Native copy command must receive selected file text')
          check(await selectText('tbody tr:nth-child(2) .md-file-ref code', 0, 19) === '/Users/example/myNo', 'Absolute path must support native drag selection')
          check(await evaluate('Number(document.body.dataset.opened ?? 0)') === 0, 'Selecting a path must not open the file')
          check(await selectText('tbody tr:nth-child(3) code', 0, 3) === 'IFD', 'Ordinary table code must remain selectable')
          const point = await evaluate(\`(() => {
            const rect = document.querySelector('td .md-file-ref code').getBoundingClientRect()
            return { x: Math.round(rect.x + 8), y: Math.round(rect.y + rect.height / 2) }
          })()\`)
          contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
          contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
          await settle()
          check(await evaluate('Number(document.body.dataset.opened ?? 0)') === 1, 'A simple click must still open the file')
          check(await selectText('td .md-file-ref code', 0, 10) === 'rate-aigc-', 'File text must remain selectable after opening')
          contents.focus()
          await evaluate("document.querySelector('td .md-file-ref').focus()")
          check(await evaluate("document.activeElement === document.querySelector('td .md-file-ref')"), 'File button must receive DOM focus')
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          contents.sendInputEvent({ type: 'char', keyCode: '\\r' })
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await settle()
          check(await evaluate('Number(document.body.dataset.opened ?? 0)') === 2, 'Keyboard activation must still open the file')
          await evaluate("document.body.dataset.selectionTest = 'done'")
        }
        contents.on('console-message', (event) => {
          const message = event.message || ''
          console.log(message)
          if (message.includes('SCRY_MARKDOWN_LAYOUT_TEST_FAILED')) app.exit(1)
          if (message.includes('SCRY_MARKDOWN_SELECTION_READY')) void testSelection().catch(error => { console.error(error); app.exit(1) })
        })
        win.webContents.setWindowOpenHandler(({ url }) => {
          const ok = url === 'http://localhost:8791/index.html'
          console.log(ok ? 'SCRY_MARKDOWN_LAYOUT_TEST_OK' : 'SCRY_MARKDOWN_LAYOUT_TEST_BAD_URL', url)
          app.exit(ok ? 0 : 4)
          return { action: 'deny' }
        })
        win.webContents.on('render-process-gone', () => app.exit(2))
        win.loadFile(${JSON.stringify(join(dir, 'index.html'))})
      })
      setTimeout(() => { console.error('Markdown layout fixture timed out'); app.exit(3) }, 15000)
    `)
    const executable = createRequire(import.meta.url)('electron') as string
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
    const output = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(executable, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk })
      child.stderr.on('data', (chunk) => { text += chunk })
      child.once('error', reject)
      child.once('exit', (code) => code === 0
        ? resolveResult(text)
        : reject(new Error(`Electron fixture exited ${code}: ${text}`)))
    })
    expect(output).toContain('SCRY_MARKDOWN_LAYOUT_TEST_OK')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 30000)
