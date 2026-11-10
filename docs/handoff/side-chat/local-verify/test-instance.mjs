#!/usr/bin/env node
/**
 * Isolated Scry test instance for the side-chat hand-off verification.
 *
 * Starts the dev build in `out/` with its own temporary HOME, userData and workspace, the
 * built-in fixture Providers (no real Provider, no account, no cost) and a CDP port, so an
 * agent can drive it and take screenshots without touching the user's running App or
 * their real `.scry`, transcripts or database.
 *
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs start
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs shot <name>       # PNG into evidence/
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs eval '<js expression>'
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs click '<css selector>'
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs type '<text>'
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs key Enter
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs restart           # same userData, new process
 *   node docs/handoff/side-chat/local-verify/test-instance.mjs stop
 *
 * Fixture Provider prompts (see src/main/providers/smoke.ts):
 *   `side chat reply <text>`  completes with "<provider> side chat reply: <text>"
 *   `side chat hold <token>`  keeps running until it is stopped
 *   `side chat write <name>`  writes side-chat-<name>.txt into the workspace
 *
 * This is verification tooling, not product code. It never uses --no-sandbox and never
 * kills a process it did not start: `stop` re-checks the recorded pid's command line.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const pointer = join(tmpdir(), 'scry-local-verify-current.json')
const evidenceDir = process.env.SCRY_VERIFY_EVIDENCE ?? join(here, 'evidence')
const fail = message => { console.error(`[test-instance] ${message}`); process.exit(1) }
const sleep = ms => new Promise(done => setTimeout(done, ms))

function electronExecutable() {
  return process.platform === 'darwin'
    ? join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
    : join(root, 'node_modules/electron/dist/electron')
}

function readState() {
  if (!existsSync(pointer)) fail('no running test instance; run `start` first')
  return JSON.parse(readFileSync(pointer, 'utf8'))
}

function commandOf(pid) {
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() } catch { return '' }
}

/** Launches Electron against an existing state; returns the pid and debugging port. */
async function launch(state) {
  const port = state.port
  const log = openSync(join(state.dir, 'app.log'), 'a')
  const child = spawn(electronExecutable(), [root, `--remote-debugging-port=${port}`, `--user-data-dir=${state.userData}`], {
    cwd: root, detached: true, stdio: ['ignore', log, log],
    env: {
      ...process.env,
      HOME: state.home,
      // The fixture Provider gate needs all three: the flag, logging and a debugging port.
      SCRY_ELECTRON_SMOKE_PROVIDER: '1', ELECTRON_ENABLE_LOGGING: '1', SCRY_ELECTRON_SMOKE_SIDE_CHAT: '1',
      SCRY_ELECTRON_SMOKE_IDENTITY: 'default', SCRY_DISABLED_PROVIDERS: '', SCRY_REMOTE_HOST: '0'
    }
  })
  child.unref()
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (targets.some(target => target.type === 'page' && target.url.startsWith('file:'))) return child.pid
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  fail(`the instance did not open a page within 60s; see ${join(state.dir, 'app.log')}`)
}

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((done, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)) })
    server.on('error', reject)
  })
}

async function start() {
  if (existsSync(pointer)) {
    const previous = JSON.parse(readFileSync(pointer, 'utf8'))
    if (commandOf(previous.pid).includes(previous.userData)) fail(`an instance is already running (pid ${previous.pid}); run \`stop\` first`)
  }
  if (!existsSync(join(root, 'out/main/index.js'))) fail('out/ is missing; run `npm run build` first')
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-local-verify-')))
  const state = { dir, home: join(dir, 'home'), userData: join(dir, 'userData'), workspace: join(dir, 'workspace'), port: await freePort() }
  for (const path of [state.home, state.userData, state.workspace]) mkdirSync(path, { recursive: true })
  writeFileSync(join(state.workspace, 'README.md'), '# side-chat verification workspace\n')
  // One known Provider session makes the temporary workspace a project in the sidebar
  // without the native folder picker.
  writeFileSync(join(state.userData, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'verify-seed', runId: 'verify-seed', providerId: 'codex', runtimeProvider: 'codex_cli',
    cwd: state.workspace, preview: 'seed session', ts: Date.now()
  }]))
  writeFileSync(join(state.userData, 'recent-folders.json'), JSON.stringify([state.workspace]))
  state.pid = await launch(state)
  writeFileSync(pointer, JSON.stringify(state, null, 2))
  console.log(JSON.stringify(state, null, 2))
}

async function restart() {
  const state = readState()
  await stop({ keepFiles: true })
  state.pid = await launch(state)
  writeFileSync(pointer, JSON.stringify(state, null, 2))
  console.log(JSON.stringify({ restarted: true, pid: state.pid }))
}

async function stop({ keepFiles = false } = {}) {
  const state = readState()
  // Only the process this tool started, identified by its own userData path.
  if (commandOf(state.pid).includes(state.userData)) {
    try { process.kill(-state.pid, 'SIGTERM') } catch { process.kill(state.pid, 'SIGTERM') }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && commandOf(state.pid)) await sleep(200)
    if (commandOf(state.pid).includes(state.userData)) {
      try { process.kill(-state.pid, 'SIGKILL') } catch { process.kill(state.pid, 'SIGKILL') }
    }
  }
  if (!keepFiles) {
    rmSync(pointer, { force: true })
    console.log(JSON.stringify({ stopped: true, kept: state.dir }))
  }
}

/** One CDP call against the instance's page. */
async function cdp(method, params = {}) {
  const state = readState()
  const targets = await (await fetch(`http://127.0.0.1:${state.port}/json`)).json()
  const page = targets.find(target => target.type === 'page' && target.url.startsWith('file:'))
  if (!page) fail('the instance has no page')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.addEventListener('open', done); socket.addEventListener('error', reject) })
  const send = (name, args) => new Promise((done, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 30_000)
    socket.addEventListener('message', function onMessage(event) {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      clearTimeout(timer)
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(message.error.message)); else done(message.result)
    })
    socket.send(JSON.stringify({ id, method: name, params: args }))
  })
  try { return await (typeof method === 'function' ? method(send) : send(method, params)) } finally { socket.close() }
}

async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) fail(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function shot(name) {
  if (!name || !/^[\w.-]+$/.test(name)) fail('shot needs a file-safe name, e.g. 01-sidebar-projects')
  mkdirSync(evidenceDir, { recursive: true })
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
  const path = join(evidenceDir, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  console.log(path)
}

/** A real pointer click at the element's centre, refused if something else covers it. */
async function click(selector) {
  const point = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (!node) throw new Error('missing: ' + ${JSON.stringify(selector)})
    node.scrollIntoView({ block: 'nearest' })
    const rect = node.getBoundingClientRect()
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2)
    if (!node.contains(document.elementFromPoint(x, y))) throw new Error('covered: ' + ${JSON.stringify(selector)})
    return { x, y }
  })()`)
  await cdp(async send => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  })
  console.log(JSON.stringify({ clicked: selector, ...point }))
}

const keys = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 }
async function key(name) {
  if (!keys[name]) fail(`key must be one of ${Object.keys(keys).join(', ')}`)
  await cdp(async send => {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name, windowsVirtualKeyCode: keys[name] })
    if (name === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', key: name, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: keys[name] })
  })
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'start': await start(); break
  case 'restart': await restart(); break
  case 'stop': await stop(); break
  case 'shot': await shot(args[0]); break
  case 'eval': console.log(JSON.stringify(await evaluate(args.join(' ')), null, 2)); break
  case 'click': await click(args.join(' ')); break
  case 'type': await cdp('Input.insertText', { text: args.join(' ') }); break
  case 'key': await key(args[0]); break
  case 'state': console.log(JSON.stringify(readState(), null, 2)); break
  default: fail('usage: start | restart | stop | state | shot <name> | eval <js> | click <selector> | type <text> | key <Enter|Escape|Tab|Backspace>')
}
