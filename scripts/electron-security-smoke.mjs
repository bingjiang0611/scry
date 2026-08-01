import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const appPath = resolve(process.argv[2] || join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const executable = join(appPath, 'Contents', 'MacOS', 'Scry')
const temp = mkdtempSync(join(tmpdir(), 'scry-electron-smoke-'))
let child
let stderr = ''

async function freePort() {
  const server = createServer()
  await new Promise((resolveReady, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function waitForTarget(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
      if (page) return { page, targets }
    } catch {
      // Electron may still be initializing.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`等待 Electron CDP target 超时\n${stderr.slice(-4000)}`)
}

function connectCdp(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const rejectPending = (message) => {
    for (const request of pending.values()) request.reject(new Error(message))
    pending.clear()
  }
  socket.onmessage = (message) => {
    const payload = JSON.parse(String(message.data))
    if (!payload.id) return
    const request = pending.get(payload.id)
    if (!request) return
    pending.delete(payload.id)
    if (payload.error) request.reject(new Error(payload.error.message))
    else request.resolve(payload.result)
  }
  const ready = new Promise((resolveReady, reject) => {
    socket.onopen = resolveReady
    socket.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
  })
  socket.onclose = () => rejectPending('CDP WebSocket 已关闭')
  return {
    async send(method, params = {}) {
      await ready
      const id = nextId++
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }))
      socket.send(JSON.stringify({ id, method, params }))
      return result
    },
    close() { socket.close() }
  }
}

async function main() {
  const port = await freePort()
  const userDataDir = join(temp, 'userData')
  const workspace = join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'smoke-run',
    runId: 'smoke-run',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    cwd: workspace,
    preview: 'security smoke',
    ts: Date.now()
  }]))
  child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--disable-gpu',
    '--no-first-run'
  ], {
    env: {
      ...process.env,
      HOME: join(temp, 'home'),
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => { stderr += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  child.once('exit', (code) => {
    if (code && code !== 0) stderr += `\nElectron exited ${code}`
  })

  const { page, targets: initialTargets } = await waitForTarget(port)
  assert.match(page.url, /^file:/, 'production renderer must load from a local file URL')
  const cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const evaluate = async (expression) => {
    const response = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'renderer evaluation failed')
    return response.result?.value
  }

  const boundary = await evaluate(`(() => ({
    requireType: typeof require,
    preloadType: typeof window.scry,
    preloadKeys: Object.keys(window.scry || {}),
  }))()`)
  assert.equal(boundary.requireType, 'undefined')
  assert.equal(
    boundary.preloadType,
    'object',
    `packaged preload did not expose window.scry\n${stderr.slice(-4000)}`
  )
  for (const key of ['start', 'stop', 'activeRuns', 'usageStats', 'stats', 'listSessions', 'listProjects', 'mcpSnapshot', 'listSkills']) {
    assert.ok(boundary.preloadKeys.includes(key), `preload missing ${key}`)
  }
  const csp = await evaluate(`new Promise((resolve) => {
    let violated = false
    const onViolation = () => { violated = true }
    document.addEventListener('securitypolicyviolation', onViolation, { once: true })
    const script = document.createElement('script')
    script.textContent = 'window.__scryInlineScriptRan = true'
    document.head.append(script)
    setTimeout(() => resolve({ violated, executed: window.__scryInlineScriptRan === true }), 50)
  })`)
  assert.deepEqual(csp, { violated: true, executed: false })

  const transportPicker = await evaluate(`(async () => {
    const recent = document.querySelector('button.recent')
    recent?.click()
    await new Promise((resolve) => setTimeout(resolve, 250))
    document.querySelector('button.clibtn')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const button = [...document.querySelectorAll('button')].find((node) => node.title?.includes('API/BYOK'))
    return { recentFound: !!recent, menuFound: !!document.querySelector('.climenu'), apiPlaceholderFound: !!button }
  })()`)
  assert.deepEqual(transportPicker, { recentFound: true, menuFound: true, apiPlaceholderFound: false })

  const modal = await evaluate(`(async () => {
    const trigger = document.querySelector('button[title="MCP"]')
    trigger?.focus()
    trigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    const focusedInside = !!dialog && dialog.contains(document.activeElement)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      opened: !!dialog,
      labelled: !!dialog?.getAttribute('aria-labelledby'),
      focusedInside,
      closed: !document.querySelector('[role="dialog"]'),
      restored: document.activeElement === trigger
    }
  })()`)
  assert.deepEqual(modal, { opened: true, labelled: true, focusedInside: true, closed: true, restored: true })

  const subframeIpc = await evaluate(`(async () => {
    const frame = document.createElement('iframe')
    frame.srcdoc = '<p>untrusted subframe</p>'
    document.body.append(frame)
    await new Promise((resolve) => setTimeout(resolve, 100))
    try {
      const api = frame.contentWindow?.scry
      if (!api) return 'not_exposed'
      await api.listProjects()
      return 'allowed'
    } catch {
      return 'rejected'
    } finally {
      frame.remove()
    }
  })()`)
  assert.notEqual(subframeIpc, 'allowed', 'an untrusted subframe reached privileged IPC')

  const popupOpened = await evaluate(`window.open('https://example.invalid/scry-smoke') !== null`)
  assert.equal(popupOpened, false)
  await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  const afterPopupTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  assert.equal(afterPopupTargets.filter((target) => target.type === 'page').length, initialTargets.filter((target) => target.type === 'page').length)

  await evaluate(`location.assign('https://example.invalid/scry-navigation-smoke')`)
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  const afterNavigation = await waitForTarget(port, 2_000)
  assert.match(afterNavigation.page.url, /^file:/, 'will-navigate failed to keep renderer on its trusted URL')

  cdp.close()
  console.log(JSON.stringify({
    appPath,
    rendererUrl: page.url,
    preloadKeys: boundary.preloadKeys.length,
    modal,
    subframeIpc,
    popupDenied: true,
    navigationDenied: true
  }))
}

try {
  await main()
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
    ])
  }
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn(`[scry] smoke temp cleanup failed: ${error.message}`)
  }
}
