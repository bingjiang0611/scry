import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('shows bounded session hover cards and renames via the real sidebar DOM with cancel, retry and pinned profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scry-rename-ui-'))
  try {
    await build({
      configFile: false, logLevel: 'silent',
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: { '@shared': resolve('src/shared') } },
      esbuild: { jsx: 'automatic', jsxDev: false },
      build: {
        outDir: join(dir, 'bundle'),
        lib: { entry: resolve('src/renderer/components/fixtures/session-rename.tsx'), name: 'RenameTest', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' }
      }
    })
    await writeFile(join(dir, 'index.html'), `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="./bundle/fixture.css"><div id="root"></div><script src="./bundle/fixture.js"></script>`)
    const main = join(dir, 'main.cjs')
    await writeFile(main, `
      const { app, BrowserWindow } = require('electron')
      if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
      app.on('browser-window-focus', () => { console.error('UI fixture stole native window focus'); app.exit(1) })
      app.setPath('userData', ${JSON.stringify(join(dir, 'userData'))})
      app.whenReady().then(() => {
        const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
        if (!win.webContents.isOffscreen()) { console.error('Offscreen rendering is required'); app.exit(1); return }
        win.webContents.on('did-finish-load', () => console.log('Interaction fixture loaded'))
        win.webContents.on('render-process-gone', (_event, details) => { console.error('Interaction renderer exited', details.reason); app.exit(2) })
        win.webContents.on('did-fail-load', (_event, code, description) => { console.error('Interaction load failed', code, description); app.exit(2) })
        win.webContents.on('console-message', (event) => {
          const message = event.message || ''
          console.log(message)
          if (message.includes('SCRY_RENAME_TEST')) {
            app.exit(message.includes('_OK') ? 0 : 1)
          }
        })
        win.webContents.on('render-process-gone', () => app.exit(2))
        win.loadFile(${JSON.stringify(join(dir, 'index.html'))})
      })
      setTimeout(() => { console.error('Interaction fixture timed out'); app.exit(3) }, 15000)
    `)
    const executable = createRequire(import.meta.url)('electron') as string
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
    const output = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(executable, [main, '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', (chunk) => { text += chunk })
      child.stderr.on('data', (chunk) => { text += chunk })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolveResult(text) : reject(new Error(`Electron fixture exited ${code}: ${text}`)))
    })
    expect(output).toContain('SCRY_RENAME_TEST_OK')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, 30000)
