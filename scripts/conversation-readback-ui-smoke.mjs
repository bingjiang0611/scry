import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'
import { build } from 'vite'
import { inspectOwnedApp, stopOwnedApp } from './owned-app-processes.mjs'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(join(tmpdir(), 'scry-conversation-readback-'))
const negative = process.argv.includes('--negative-generation')
const commands = process.argv.includes('--commands')
const fixture = commands ? 'conversation-command-smoke.tsx' : 'conversation-readback-smoke.tsx'
let child
let timer
let primaryError
let output = ''
let outputTruncated = false

async function exercise() {
  const check = (value, detail) => { if (!value) throw new Error(detail) }
  const driver = window.conversationReadbackFixture
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
  const wait = async condition => {
    const deadline = Date.now() + 5000
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error('readback fixture condition deadline')
      await frame()
    }
  }
  const revision = () => document.querySelector('#readback')?.getAttribute('data-revision')
  await wait(() => driver.snapshot().requests.length === 1)
  driver.emit('another-conversation')
  check(driver.snapshot().requests.length === 1, 'foreign event caused readback')
  driver.emit()
  await wait(() => driver.snapshot().requests.length === 2)
  driver.respond(1, 2)
  await wait(() => revision() === '2')
  driver.respond(0, 1)
  await frame()
  check(revision() === '2', 'stale read overwrote newer page')
  check(driver.snapshot().changed.length === 1, 'stale read published revision notification')
  check(driver.snapshot().selected.join(',') === 'pi-explicit', 'initial selection was missing or repeated')
  driver.paginate(2)
  await wait(() => driver.snapshot().requests.length === 3)
  check(driver.snapshot().requests[2].before === 2, 'pagination boundary lost')
  check(driver.snapshot().listeners === 1, 'pagination leaked event subscription')
  driver.respond(2, 3)
  await wait(() => revision() === '3')
  driver.callbacks()
  await frame()
  check(driver.snapshot().requests.length === 3, 'callback refresh created an extra read')
  driver.emit()
  await wait(() => driver.snapshot().requests.length === 4)
  driver.respond(3, 4)
  await wait(() => revision() === '4')
  check(driver.snapshot().changed.at(-1).version === 2, 'readback used stale callback')
  driver.emit()
  await wait(() => driver.snapshot().requests.length === 5)
  driver.reject(4)
  await wait(() => driver.snapshot().errors.length === 1)
  check(driver.snapshot().errors[0].version === 2, 'error used stale callback')
  check(driver.snapshot().errors[0].message === 'synthetic read failure', 'read error was hidden')
  driver.emit()
  await wait(() => driver.snapshot().requests.length === 6)
  const changed = driver.snapshot().changed.length
  driver.unmount()
  check(driver.snapshot().listeners === 0 && driver.snapshot().mounted === false, 'unmount left observer live')
  driver.respond(5, 5)
  await frame()
  check(driver.snapshot().changed.length === changed, 'late read notified after unmount')
  check(!document.querySelector('#readback'), 'late read remounted view')
  return { staleReadFenced: true, foreignEventIgnored: true, paginationPreserved: true,
    latestCallbacksUsed: true, errorsPreserved: true, unmountFenced: true,
    requests: driver.snapshot().requests.length, initialSelections: driver.snapshot().selected.length }
}

try {
  await Promise.all(['home', 'userData', 'sessionData'].map(name => mkdir(join(temp, name))))
  await build({
    configFile: false, root: temp, envDir: temp, logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': join(root, 'src/shared') } }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: negative ? [{ name: 'readback-generation-negative', transform(code, id) {
      if (id !== join(root, 'src/renderer/hooks/useConversationReadback.ts')) return
      const guard = 'generation !== refreshGeneration.current'
      if (code.split(guard).length !== 2) throw new Error('negative guard is not unique')
      return code.replace(guard, 'generation > refreshGeneration.current')
    } }] : [],
    build: { outDir: temp, emptyOutDir: false, copyPublicDir: false, minify: false,
      lib: { entry: join(root, 'scripts/fixtures', fixture), formats: ['iife'],
        name: 'ConversationReadbackFixture', fileName: () => 'fixture.js', cssFileName: 'fixture' } }
  })
  await writeFile(join(temp, 'index.html'), '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\' data:">' + (commands ? '<link rel="stylesheet" href="fixture.css">' : '') + '<div id="root"></div><script src="fixture.js"></script>')
  await writeFile(join(temp, 'main.cjs'), `
    const { app, BrowserWindow } = require('electron')
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    app.setPath('userData', ${JSON.stringify(join(temp, 'userData'))})
    app.setPath('sessionData', ${JSON.stringify(join(temp, 'sessionData'))})
    app.whenReady().then(async () => {
      app.dock?.hide()
      const win = new BrowserWindow({ width: 1280, height: 960, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }))
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      try {
        await win.loadFile(${JSON.stringify(join(temp, 'index.html'))})
        const result = ${commands ? `(await import(${JSON.stringify(new URL('./conversation-command-ui-checks.mjs', import.meta.url).href)})).checkConversationCommandUi(win, ${JSON.stringify(temp)})` : `win.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()`)})`}
        const observed = await result
        console.log('SCRY_CONVERSATION_READBACK_RESULT=' + JSON.stringify({ passed: true, result: observed }))
      } catch (error) {
        ${commands ? `const { writeFile } = require('node:fs/promises')
        await writeFile(${JSON.stringify(join(temp, 'ui-failure.json'))}, await win.webContents.executeJavaScript('JSON.stringify({draft:window.conversationCommandFixture?.draft(),calls:window.conversationCommandFixture?.calls,active:document.activeElement?.outerHTML?.slice(0,512),body:document.body.textContent.slice(0,4096)})'))
        await writeFile(${JSON.stringify(join(temp, 'ui-failure.png'))}, (await win.webContents.capturePage()).toPNG())` : ''}
        console.log('SCRY_CONVERSATION_READBACK_RESULT=' + JSON.stringify({ passed: false, error: String(error) }))
      }
    })
  `)
  await writeFile(join(temp, 'identity.json'), JSON.stringify({ negativeGeneration: negative, profile: commands ? 'commands' : 'readback',
    hookSha256: createHash('sha256').update(await readFile(join(root, 'src/renderer/hooks/useConversationReadback.ts'))).digest('hex'),
    fixtureSha256: createHash('sha256').update(await readFile(join(temp, 'fixture.js'))).digest('hex'),
    scope: commands ? 'Real ConversationView/React/Chromium input with scripted bridge; not production Main, native Provider or model execution' : 'Isolated React DOM readback fixture; not full App, real IPC, Provider or physical UI input' }, null, 2) + '\n')
  const result = await new Promise((resolveResult, reject) => {
    child = spawn(electron, [join(temp, 'main.cjs'), '--disable-gpu'], {
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(temp, 'home') }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    const receive = chunk => {
      if (settled) return
      const next = output + chunk.toString()
      if (Buffer.byteLength(next) > 65536) {
        outputTruncated = true
        fail(new Error('fixture output bound exceeded'))
        return
      }
      output = next
      const line = output.match(/^SCRY_CONVERSATION_READBACK_RESULT=(.+)$/m)?.[1]
      if (line) {
        settled = true
        resolveResult(JSON.parse(line))
      }
    }
    timer = setTimeout(() => fail(new Error('fixture exceeded original 30000ms deadline')), 30000)
    child.stdout.on('data', receive)
    child.stderr.on('data', receive)
    child.once('error', fail)
    child.once('exit', (code, signal) => fail(new Error(`fixture exited before result: ${code}/${signal}`)))
  })
  await writeFile(join(temp, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ ...result, retainedFixture: temp, negativeGeneration: negative }))
  if (!result.passed) throw new Error(result.error)
} catch (error) {
  primaryError = error
  await writeFile(join(temp, 'failure.json'), JSON.stringify({ error: String(error), processes: inspectOwnedApp(child) }, null, 2) + '\n')
  throw error
} finally {
  clearTimeout(timer)
  await writeFile(join(temp, 'child-output.log'), output)
  await writeFile(join(temp, 'output-coverage.json'), JSON.stringify({ outputTruncated,
    scope: 'Bounded child output until first result or failure, not full process output' }, null, 2) + '\n')
  if (child) {
    try {
      const closure = await stopOwnedApp(child)
      await writeFile(join(temp, 'closure.json'), JSON.stringify({ registeredResources: closure,
        scope: 'Registered/revalidated resources only; escaped descendants unverified' }, null, 2) + '\n')
    } catch (cleanupError) {
      await writeFile(join(temp, 'closure-error.json'), JSON.stringify({ error: String(cleanupError) }, null, 2) + '\n')
      if (primaryError) throw new AggregateError([primaryError, cleanupError], 'Fixture and registered cleanup failed', { cause: primaryError })
      throw cleanupError
    }
  }
  console.log(JSON.stringify({ retainedReadbackFixture: temp }))
}
