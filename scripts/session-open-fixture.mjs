import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export let startupProbe = { phase: 'not-started', attempts: 0 }

export async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const { port } = server.address()
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

export async function connect(port) {
  const deadline = Date.now() + 30_000
  let page
  while (!page && Date.now() < deadline) {
    startupProbe = { phase: 'http-request', attempts: startupProbe.attempts + 1, port }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      startupProbe.httpStatus = response.status
      const targets = await response.json()
      startupProbe.targets = targets.slice(0, 8).map(({ type, title, url }) => ({ type, title, url: url?.slice(0, 512) }))
      startupProbe.targetsTruncated = targets.length > 8
      page = targets.find(target => target.type === 'page' && target.title === 'Scry' && target.webSocketDebuggerUrl)
      startupProbe.phase = page ? 'page-found' : 'waiting-for-page'
    } catch (error) {
      startupProbe.phase = 'probe-failed'
      startupProbe.error = String(error)
      startupProbe.cause = error.cause ? String(error.cause) : undefined
    }
    if (!page) await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  assert.ok(page, 'App startup timed out')
  assert.match(page.url, /^file:/)
  startupProbe.phase = 'websocket-connect'
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let nextId = 1
  await new Promise((resolveReady, reject) => { socket.onopen = resolveReady; socket.onerror = reject })
  startupProbe.phase = 'debug-connected'
  socket.onmessage = message => {
    const payload = JSON.parse(String(message.data))
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  socket.onclose = () => {
    for (const request of pending.values()) request.reject(new Error('App debug connection closed'))
    pending.clear()
  }
  return {
    send(method, params = {}) {
      const id = nextId++
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() { socket.close() }
  }
}

export function writeSessionFixture(root, temp, turnCount, sections) {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const userData = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(home, 'workspace')
  for (const path of [userData, home, workspace]) mkdirSync(path, { recursive: true })
  const cwd = realpathSync(workspace)
  const sessions = ['open-bench-a', 'open-bench-b']
  const catalog = []
  for (const sessionId of sessions) {
    const turns = Array.from({ length: turnCount }, (_, index) => {
      const body = Array.from({ length: sections }, (_, line) =>
        `### Section ${line}\n\nA **measured** history paragraph with [a link](https://example.com).\n\n- item one\n- item two\n\n\`\`\`ts\nconst value${line} = ${line}\n\`\`\`\n`).join('\n')
      return {
        runId: `${sessionId}-turn-${index}`, userText: `${sessionId} prompt ${index}`, done: true,
        ts: 1_700_000_000_000 + index,
        items: [{ id: `${sessionId}-text-${index}`, runId: `${sessionId}-turn-${index}`,
          ts: '2023-11-14T22:13:20.000Z', kind: 'model', stage: 'text', text: `${body}\nEND ${sessionId} ${index}` }]
      }
    })
    const archiveDir = join(userData, 'trace-archives-v2', 'codex', `cwd-${hash(cwd)}`)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, `sid-${hash(sessionId)}.json`), JSON.stringify({
      version: 3, cwd, sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', turns
    }))
    catalog.push({ sessionId, externalSessionId: sessionId, runId: turns.at(-1).runId,
      providerId: 'codex', runtimeProvider: 'codex_cli', cwd, preview: sessionId, ts: turns.at(-1).ts })
  }
  writeFileSync(join(userData, 'app-sessions.json'), JSON.stringify(catalog))
  const bootstrap = join(temp, 'app')
  mkdirSync(bootstrap)
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  writeFileSync(join(bootstrap, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, main: 'main.cjs' }))
  writeFileSync(join(bootstrap, 'main.cjs'), `
    const { app } = require('electron');
    const mark = (phase, detail = {}) => process.stderr.write('[scry:native-startup] ' + JSON.stringify({ phase, pid: process.pid, atMs: performance.now(), ...detail }) + '\\n');
    mark('bootstrap', { ready: app.isReady() });
    app.once('ready', () => mark('app-ready'));
    app.on('browser-window-created', (_event, win) => {
      mark('window-created', { windowId: win.id });
      win.webContents.once('did-finish-load', () => mark('renderer-loaded', { windowId: win.id }));
      win.webContents.on('did-fail-load', (_event, code, description) => mark('renderer-load-failed', { code, description }));
    });
    app.setAppPath(${JSON.stringify(root)});
    require(${JSON.stringify(join(root, 'scripts/hidden-electron-windows.cjs'))})(app);
    require(${JSON.stringify(join(root, metadata.main))});
    mark('main-loaded');
  `)
  return { userData, home, cwd, sessions, bootstrap }
}
