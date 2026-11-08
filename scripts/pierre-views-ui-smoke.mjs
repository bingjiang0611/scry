import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import electron from 'electron'
import { Script } from 'node:vm'
import { exercise } from './pierre-views-ui-checks.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = await realpath(await mkdtemp(join(tmpdir(), 'scry-pierre-ui-')))
const negative = process.argv.includes('--negative-comment-control')
let passed = false
try {
  await Promise.all(['home', 'userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; object-src \'none\'">' +
    '<div id="root"></div><script type="module" src="./entry.tsx"></script>')
  await writeFile(join(temp, 'entry.tsx'), `import ${JSON.stringify(join(root, 'scripts/fixtures/pierre-views-smoke.tsx'))}`)
  await build({
    configFile: false, root: temp, base: './', envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } },
    worker: { format: 'es' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: negative ? [{ name: 'negative-truncated-comment-control', transform(code, id) {
      if (!id.endsWith('/PierrePatch.tsx')) return
      const guarded = '!diff.truncated && !limited'
      if (!code.includes(guarded)) throw new Error('Negative control lost its production binding')
      return code.replace(guarded, '!limited')
    } }] : [],
    build: { outDir: join(temp, 'dist'), emptyOutDir: true, minify: false }
  })
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app)
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, width: 1100, height: 800,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      setTimeout(() => { console.error('Pierre fixture exceeded its 30-second interaction deadline'); app.exit(1) }, 30000)
      const errors = [], blocked = []
      win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
      win.webContents.session.webRequest.onBeforeRequest((details, done) => {
        const cancel = !details.url.startsWith('file:')
        if (cancel) blocked.push(details.url)
        done({ cancel })
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'dist/index.html'))})
        const result = await (${exercise.toString()})(win.webContents)
        if (errors.length) throw new Error('Renderer errors: ' + JSON.stringify(errors))
        if (blocked.length) throw new Error('Unexpected network requests: ' + JSON.stringify(blocked))
        const workers = result.workerUrls
        if (workers.length < 2 || workers.some(url => !url.startsWith('file:'))) throw new Error('Local worker pool missing: ' + JSON.stringify(workers))
        console.log('SCRY_PIERRE_RESULT=' + JSON.stringify({ ...result, localWorkers: workers.length, rendererErrors: errors.length, networkRequests: blocked.length }))
        app.exit(0)
      } catch (error) {
        const state = await win.webContents.executeJavaScript('JSON.stringify({ text: document.body.innerText.slice(-2500), active: document.activeElement?.outerHTML.slice(0, 600), stacks: [...document.querySelectorAll(".pierre-code-view")].map(node => ({ top: node.scrollTop, height: node.clientHeight, fullHeight: node.scrollHeight })), shadows: [...document.querySelectorAll("diffs-container,file-tree-container")].map(host => ({ tag: host.tagName, text: host.shadowRoot?.textContent.slice(-1500) })) })')
        console.error('SCRY_PIERRE_FAILURE=' + String(error.stack || error) + '\\n' + state + '\\nerrors=' + JSON.stringify(errors) )
        app.exit(1)
      }
    })
  `)
  // Catch generated-main syntax errors before Electron can open a native error dialog.
  new Script(await readFile(join(temp, 'main.cjs'), 'utf8'), { filename: join(temp, 'main.cjs') })
  const child = spawn(electron, [join(temp, 'main.cjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: join(temp, 'home'), ELECTRON_ENABLE_LOGGING: '' } })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const code = await new Promise(resolve => child.on('exit', resolve))
  const result = stdout.split('\n').find(line => line.startsWith('SCRY_PIERRE_RESULT='))
  if (code !== 0 || !result) throw new Error(`fixture exited ${code}: ${stderr.slice(-7000)} ${stdout.slice(-2000)}\nfixture: ${temp}`)
  console.log(JSON.stringify({ test: 'Pierre production components / native hidden Electron', negative, ...JSON.parse(result.slice('SCRY_PIERRE_RESULT='.length)) }))
  passed = true
} finally {
  if (passed) await rm(temp, { recursive: true, force: true })
  else console.error(`Pierre fixture retained: ${temp}`)
}
