import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('keeps task text horizontal and routes file and browser links in real Chromium', async () => {
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
      if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
      app.on('browser-window-focus', () => { console.error('UI fixture stole native window focus'); app.exit(1) })
      app.setPath('userData', ${JSON.stringify(join(dir, 'userData'))})
      app.whenReady().then(() => {
        const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
        win.webContents.on('console-message', (event) => {
          const message = event.message || ''
          console.log(message)
          if (message.includes('SCRY_MARKDOWN_LAYOUT_TEST_FAILED')) app.exit(1)
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
