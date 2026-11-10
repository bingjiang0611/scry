import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const root = '/tmp/scry-verify-c0e009e/wt'
export const evidenceRoot = '/tmp/scry-verify-c0e009e/evidence'
const electron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export async function freePort() {
  const { createServer } = await import('node:net')
  const server = createServer()
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise(r => server.close(r))
  return port
}
export function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map(); let nextId = 1
  const ready = new Promise((res, rej) => { socket.onopen = res; socket.onerror = () => rej(new Error('cdp failed')) })
  socket.onmessage = (m) => { const p = JSON.parse(String(m.data)); const req = pending.get(p.id); if (!req) return; pending.delete(p.id); p.error ? req.reject(new Error(p.error.message)) : req.resolve(p.result) }
  return {
    async send(method, params = {}) { await ready; const id = nextId++; const r = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })); socket.send(JSON.stringify({ id, method, params })); return r },
    close() { socket.close() }
  }
}
export async function waitForTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json())
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && t.title === 'Scry')
      if (page) return page
    } catch {}
    await sleep(150)
  }
  throw new Error('no renderer target')
}

export async function launch({ mode, label, extraEnv = {}, show = true }) {
  const temp = mkdtempSync(`/tmp/scry-verify-c0e009e/${label}-`)
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(home, 'workspace')
  mkdirSync(userDataDir, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# fixture\n')
  writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify([{ cwd: workspace, lastOpenedAt: 1 }]))
  const receipts = { badge: join(temp, 'badge.json'), sends: join(temp, 'sends.jsonl'), views: join(temp, 'views.jsonl') }
  const mainEntry = join(temp, 'instrumented-main.mjs')
  writeFileSync(mainEntry, `
    import { app, BrowserWindow, ipcMain } from 'electron'
    import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
    const badgePath = ${JSON.stringify(receipts.badge)}
    const sendsPath = ${JSON.stringify(receipts.sends)}
    const viewsPath = ${JSON.stringify(receipts.views)}
    const requests = []
    // The instrumented entry is a file (not the app directory), so Electron's own app
    // path points at the temp dir. The App resolves its daemon entry and recorder CLI
    // from it; point it at the real checkout this run was built from.
    app.getAppPath = () => ${JSON.stringify(root)}
    app.whenReady().then(async () => {
      const setBadgeCount = app.setBadgeCount.bind(app)
      app.setBadgeCount = (count) => {
        const ok = setBadgeCount(count)
        requests.push({ at: Date.now(), count, ok, nativeCount: app.getBadgeCount(), dockBadge: app.dock?.getBadge?.() ?? null })
        writeFileSync(badgePath, JSON.stringify(requests))
        return ok
      }
      // Fixture-only window focus control: this isolated App must be able to take and
      // lose OS focus deterministically without Accessibility scripting of the host.
      const controlPath = ${JSON.stringify(join(temp, 'focus.ctl'))}
      const controlSeen = ${JSON.stringify(join(temp, 'focus.seen'))}
      let controlMtime = 0
      // This host cannot give an Electron window real OS focus (the Aqua front app is
      // loginwindow), so the isolated App drives the same window focus signal the
      // product reads: BrowserWindow.isFocused() and its focus/blur events.
      let fixtureFocus = false
      const realIsFocused = BrowserWindow.prototype.isFocused
      BrowserWindow.prototype.isFocused = function () { return fixtureFocus || realIsFocused.call(this) }
      setInterval(() => {
        try {
          const stat = statSync(controlPath)
          if (stat.mtimeMs === controlMtime) return
          controlMtime = stat.mtimeMs
          const command = readFileSync(controlPath, 'utf8').trim()
          const win = BrowserWindow.getAllWindows()[0]
          if (command === 'focus') { fixtureFocus = true; win?.emit('focus') }
          if (command === 'blur') { fixtureFocus = false; win?.emit('blur') }
          writeFileSync(controlSeen, JSON.stringify({ command, isFocused: win ? win.isFocused() : null, at: Date.now() }))
        } catch {}
      }, 80)
      app.on('web-contents-created', (_event, contents) => {
        const send = contents.send.bind(contents)
        contents.send = (channel, ...args) => {
          appendFileSync(sendsPath, JSON.stringify({ at: Date.now(), channel, runId: args[0]?.runId ?? null, stopped: args[0]?.stopped ?? null, payload: channel === 'agent:stopState' ? args[0] : undefined }) + '\\n')
          return send(channel, ...args)
        }
      })
      const handle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
        if (channel === 'agent:viewSessions' || channel === 'agent:newSession' || channel === 'agent:unreadSessions') {
          const startedAt = Date.now()
          try {
            const value = await listener(...args)
            appendFileSync(viewsPath, JSON.stringify({ at: startedAt, channel, args: args.slice(1), ok: true, value }) + '\\n')
            return value
          } catch (error) {
            appendFileSync(viewsPath, JSON.stringify({ at: startedAt, channel, args: args.slice(1), ok: false, error: String(error?.message ?? error) }) + '\\n')
            throw error
          }
        }
        return listener(...args)
      })
      await import(${JSON.stringify(pathToFileURL(join(root, 'out/main/index.js')).href)})
    })
  `)
  const port = await freePort()
  const log = []
  const child = spawn(electron, [mainEntry, `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--disable-gpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run'], {
    env: {
      ...process.env, HOME: home, ELECTRON_ENABLE_LOGGING: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '0',
      // A dev Electron cannot answer the macOS Safe Storage prompt, and daemon mode reads
      // it before the window loads, so daemon runs are owned test apps (hidden window).
      SCRY_TEST_APP: mode === 'daemon' ? '1' : (show ? '0' : '1'),
      SCRY_ELECTRON_SMOKE_PROVIDER: '1',
      SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1',
      SCRY_ELECTRON_SMOKE_INPUTS: join(temp, 'inputs.jsonl'),
      SCRY_ELECTRON_SMOKE_CALLS: join(temp, 'calls.jsonl'),
      SCRY_DISABLED_PROVIDERS: 'qoder,opencode',
      SCRY_REMOTE_HOST: '0',
      ...(mode === 'daemon' ? { SCRY_HOST_DAEMON: '1', SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1' } : {}),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', c => log.push(String(c)))
  child.stderr.on('data', c => log.push(String(c)))
  child.once('exit', (code, signal) => log.push(`\nElectron exited code=${code} signal=${signal}`))
  return { temp, userDataDir, home, workspace, receipts, port, child, log, mode }
}

export async function attach(instance) {
  const page = await waitForTarget(instance.port)
  const cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed')
    return r.result?.value
  }
  instance.cdp = cdp; instance.evaluate = evaluate
  return instance
}

export const json = JSON.stringify
export async function wait(instance, expression, timeoutMs = 30000, label = '') {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await instance.evaluate(expression); if (last) return last } catch (e) { last = String(e) }
    await sleep(50)
  }
  throw new Error(`timeout${label ? ' ' + label : ''}: ${expression} last=${JSON.stringify(last)?.slice(0, 300)}`)
}

export function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
}
export function badgeCounts(instance) {
  if (!existsSync(instance.receipts.badge)) return []
  return JSON.parse(readFileSync(instance.receipts.badge, 'utf8'))
}
export function lsofPaths(instance) {
  try {
    return execFileSync('lsof', ['-p', String(instance.child.pid), '-Fn'], { encoding: 'utf8' })
      .split('\n').filter(l => l.startsWith('n/')).map(l => l.slice(1))
  } catch { return [] }
}
