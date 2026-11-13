import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'vite'
import { expect, it, onTestFinished } from 'vitest'

const totalTimeoutMs = 30000

it('shows bounded session hover cards and renames via the real sidebar DOM with cancel, retry and pinned profiles', async () => {
  const deadline = Date.now() + totalTimeoutMs
  let ownedChild: ChildProcess | undefined
  let text = ''
  onTestFinished(() => {
    if (ownedChild?.pid && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      console.error('Interaction fixture unfinished at test end:', text)
      ownedChild.kill()
    }
  })
  const dir = await mkdtemp(join(tmpdir(), 'scry-rename-ui-'))
  try {
    await build({
      configFile: false, logLevel: 'silent',
      worker: { format: 'es' },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      resolve: { alias: { '@shared': resolve('src/shared') } },
      esbuild: { jsx: 'automatic', jsxDev: false },
      build: {
        outDir: join(dir, 'bundle'),
        lib: { entry: resolve('src/renderer/components/fixtures/session-rename.tsx'), name: 'RenameTest', formats: ['iife'], fileName: () => 'fixture.js', cssFileName: 'fixture' }
      }
    })
    await writeFile(join(dir, 'index.html'), `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="./bundle/fixture.css"><div id="root"></div><script src="./bundle/fixture.js"></script>`)
    const main = resolve('scripts/fixtures/session-rename-main.cjs')
    const executable = createRequire(import.meta.url)('electron') as string
    const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
    if (Date.now() >= deadline) throw new Error('Interaction fixture total budget exhausted before launch')
    const output = await new Promise<string>((resolveResult, reject) => {
      const child = spawn(executable, [main, join(dir, 'index.html'), join(dir, 'userData'), String(deadline), '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      ownedChild = child
      child.stdout.on('data', (chunk) => { text += chunk })
      child.stderr.on('data', (chunk) => { text += chunk })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolveResult(text) : reject(new Error(`Electron fixture exited ${code}: ${text}`)))
    })
    expect(output).toContain('SCRY_RENAME_TEST_OK')
  } finally { await rm(dir, { recursive: true, force: true }) }
}, totalTimeoutMs)
