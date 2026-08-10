import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalHome = realpathSync(home)
  const canonicalWorkspace = realpathSync(workspace)
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
      HOME: home,
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
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'renderer evaluation failed')
    }
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
  for (const key of [
    'start', 'stop', 'activeRuns', 'usageStats', 'stats', 'listSessions', 'listProjects', 'mcpSnapshot', 'listSkills', 'onFocusedRun',
    'terminalStart', 'terminalWrite', 'terminalResize', 'terminalClose', 'onTerminalData', 'onTerminalExit'
  ]) {
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

  const surfaceSmoke = await evaluate(`(async () => {
    const waitFor = async (selector, timeout = 4_000) => {
      const deadline = Date.now() + timeout
      let node = null
      while (!node && Date.now() < deadline) {
        node = document.querySelector(selector)
        if (!node) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return node
    }
    const openSurface = async (label, selector) => {
      document.querySelector('button[aria-label="添加 Surface"]')?.click()
      const deadline = Date.now() + 2_000
      let item = null
      while (!item && Date.now() < deadline) {
        item = [...document.querySelectorAll('[role="menuitem"]')]
          .find((node) => node.textContent?.trim().startsWith(label)) || null
        if (!item) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      item?.click()
      return waitFor(selector)
    }

    const unboundButton = await waitFor('button[title="右侧工作区"]')
    const unboundInitiallyHidden = !document.querySelector('.right-surface-panel')
      && unboundButton?.getAttribute('aria-pressed') === 'false'
    unboundButton?.click()
    const unboundPanel = await waitFor('.right-surface-panel')
    const unboundOpened = !!unboundPanel
      && document.querySelector('button[title="右侧工作区"]')?.getAttribute('aria-pressed') === 'true'
    const unboundTerminal = unboundPanel ? await openSurface('终端', '.terminal-surface') : null
    const unboundTerminalRunning = unboundTerminal ? await waitFor('.terminal-state.running') : null
    document.querySelector('button[aria-label="隐藏右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const unboundHidden = document.querySelector('.app')?.classList.contains('right-panel-hidden') === true
      && document.querySelector('button[title="右侧工作区"]')?.getAttribute('aria-pressed') === 'false'
    const unboundTerminalRetained = !!document.querySelector('.terminal-surface')

    const recent = await waitFor('button.sb-sess')
    recent?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const panel = await waitFor('.right-surface-panel')
    const terminal = panel ? await waitFor('.terminal-surface') : null
    const agents = terminal ? await openSurface('Agents', '.agents-surface') : null
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]')
    const terminalPanel = document.querySelector('.surface-content-terminal')

    document.querySelector('button[aria-label="最大化右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const maximized = document.querySelector('.app')?.classList.contains('right-panel-maximized') === true
    document.querySelector('button[aria-label="恢复右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const restored = document.querySelector('.app')?.classList.contains('right-panel-maximized') === false

    document.querySelector('button[aria-label="隐藏右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const hidden = document.querySelector('.app')?.classList.contains('right-panel-hidden') === true
    const terminalRetained = !!document.querySelector('.terminal-surface')
    document.querySelector('button[title="右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reopened = document.querySelector('.app')?.classList.contains('right-panel-hidden') === false

    return {
      unboundButton: !!unboundButton,
      unboundInitiallyHidden,
      unboundOpened,
      unboundTerminal: !!unboundTerminal,
      unboundTerminalRunning: !!unboundTerminalRunning,
      unboundHidden,
      unboundTerminalRetained,
      panel: !!panel,
      terminal: !!terminal,
      agents: !!agents,
      agentsActive: activeTab?.textContent?.includes('Agents') === true,
      terminalHiddenButMounted: terminalPanel?.hidden === true && terminalRetained,
      maximized,
      restored,
      hidden,
      reopened
    }
  })()`)
  assert.deepEqual(surfaceSmoke, {
    unboundButton: true,
    unboundInitiallyHidden: true,
    unboundOpened: true,
    unboundTerminal: true,
    unboundTerminalRunning: true,
    unboundHidden: true,
    unboundTerminalRetained: true,
    panel: true,
    terminal: true,
    agents: true,
    agentsActive: true,
    terminalHiddenButMounted: true,
    maximized: true,
    restored: true,
    hidden: true,
    reopened: true
  })

  const windowChrome = await evaluate(`(() => {
    const inspect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        top: Math.round(rect.top),
        height: Math.round(rect.height),
        background: style.backgroundColor,
        drag: style.getPropertyValue('-webkit-app-region'),
        paddingLeft: style.paddingLeft
      }
    }
    const topbarAction = document.querySelector('.topbar button')
    const surfaceAction = document.querySelector('.surface-topbar button')
    const root = document.documentElement
    const previousTheme = root.dataset.theme
    root.dataset.theme = 'light'
    const lightBackgrounds = {
      sidebar: inspect('.sidebar')?.background,
      brand: inspect('.sb-brand')?.background,
      main: inspect('.main-area')?.background,
      topbar: inspect('.topbar')?.background,
      surface: inspect('.right-surface-panel')?.background,
      surfaceTopbar: inspect('.surface-topbar')?.background
    }
    if (previousTheme) root.dataset.theme = previousTheme
    else delete root.dataset.theme
    return {
      platform: document.documentElement.dataset.platform,
      sidebar: inspect('.sidebar'),
      brand: inspect('.sb-brand'),
      main: inspect('.main-area'),
      topbar: inspect('.topbar'),
      surface: inspect('.right-surface-panel'),
      surfaceTopbar: inspect('.surface-topbar'),
      topbarActionDrag: topbarAction
        ? getComputedStyle(topbarAction).getPropertyValue('-webkit-app-region')
        : null,
      surfaceActionDrag: surfaceAction
        ? getComputedStyle(surfaceAction).getPropertyValue('-webkit-app-region')
        : null,
      lightBackgrounds
    }
  })()`)
  assert.equal(windowChrome.platform, 'macos')
  assert.deepEqual(
    [windowChrome.brand?.top, windowChrome.topbar?.top, windowChrome.surfaceTopbar?.top],
    [0, 0, 0],
    'macOS app columns must extend to the top window edge'
  )
  assert.deepEqual(
    [windowChrome.brand?.height, windowChrome.topbar?.height, windowChrome.surfaceTopbar?.height],
    [52, 52, 52],
    'macOS app chrome must share the 52px integrated titlebar height'
  )
  assert.equal(windowChrome.brand?.paddingLeft, '80px', 'sidebar chrome must reserve the traffic-light safe area')
  assert.deepEqual(
    [windowChrome.brand?.drag, windowChrome.topbar?.drag, windowChrome.surfaceTopbar?.drag],
    ['drag', 'drag', 'drag'],
    'integrated titlebars must remain draggable'
  )
  assert.deepEqual(
    [windowChrome.topbarActionDrag, windowChrome.surfaceActionDrag],
    ['no-drag', 'no-drag'],
    'titlebar actions must remain interactive'
  )
  assert.equal(windowChrome.brand?.background, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.topbar?.background, windowChrome.main?.background)
  assert.equal(windowChrome.surfaceTopbar?.background, windowChrome.surface?.background)
  assert.equal(windowChrome.lightBackgrounds.brand, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.topbar, windowChrome.lightBackgrounds.main)
  assert.equal(windowChrome.lightBackgrounds.surfaceTopbar, windowChrome.lightBackgrounds.surface)
  assert.equal(windowChrome.lightBackgrounds.main, 'rgb(255, 255, 255)')
  assert.notEqual(windowChrome.lightBackgrounds.main, windowChrome.main?.background)

  const collapsedChrome = await evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 2_000) => {
      const deadline = Date.now() + timeout
      while (!predicate() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return predicate()
    }
    const splitter = document.querySelector('.sidebar-resizer')
    splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const collapsed = await waitFor(() => document.querySelector('.app')?.classList.contains('sidebar-collapsed') === true)
    const mainLeft = Math.round(document.querySelector('.main-area')?.getBoundingClientRect().left ?? -1)
    const mainActionLeft = Math.round(document.querySelector('.topbar button')?.getBoundingClientRect().left ?? -1)

    const diagnosticsButton = [...document.querySelectorAll('button.sb-navitem')]
      .find((node) => node.textContent?.includes('诊断'))
    diagnosticsButton?.click()
    const diagnostics = await waitFor(() => !!document.querySelector('.diagnostics-evidence-page'))
    const auxTopbar = document.querySelector('.aux-view-topbar')
    const auxRect = auxTopbar?.getBoundingClientRect()
    const auxDrag = auxTopbar ? getComputedStyle(auxTopbar).getPropertyValue('-webkit-app-region') : null
    const diagnosticsTop = Math.round(document.querySelector('.diagnostics-evidence-page')?.getBoundingClientRect().top ?? -1)

    document.querySelector('button.sb-sess')?.click()
    const chatRestored = await waitFor(() => !!document.querySelector('.topbar'))

    document.querySelector('button[aria-label="最大化右侧工作区"]')?.click()
    const maximized = await waitFor(() => document.querySelector('.app')?.classList.contains('right-panel-maximized') === true)
    const surfaceLeft = Math.round(document.querySelector('.right-panel-slot')?.getBoundingClientRect().left ?? -1)
    const surfaceActionLeft = Math.round(document.querySelector('.surface-topbar button')?.getBoundingClientRect().left ?? -1)

    document.querySelector('button[aria-label="恢复右侧工作区"]')?.click()
    await waitFor(() => document.querySelector('.app')?.classList.contains('right-panel-maximized') === false)
    splitter?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const restored = await waitFor(() => document.querySelector('.app')?.classList.contains('sidebar-collapsed') === false)
    return {
      collapsed,
      mainLeft,
      mainActionLeft,
      diagnostics,
      auxTop: Math.round(auxRect?.top ?? -1),
      auxHeight: Math.round(auxRect?.height ?? -1),
      auxDrag,
      diagnosticsTop,
      chatRestored,
      maximized,
      surfaceLeft,
      surfaceActionLeft,
      restored
    }
  })()`)
  assert.equal(collapsedChrome.collapsed, true)
  assert.ok(collapsedChrome.mainLeft < 16, `collapsed sidebar did not release its layout width: ${JSON.stringify(collapsedChrome)}`)
  assert.ok(collapsedChrome.mainActionLeft >= 80, `collapsed main chrome overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.diagnostics, true)
  assert.deepEqual(
    [collapsedChrome.auxTop, collapsedChrome.auxHeight, collapsedChrome.auxDrag],
    [0, 52, 'drag'],
    `auxiliary view is missing integrated window chrome: ${JSON.stringify(collapsedChrome)}`
  )
  assert.ok(collapsedChrome.diagnosticsTop >= 52, `Diagnostics overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.chatRestored, true)
  assert.equal(collapsedChrome.maximized, true)
  assert.ok(collapsedChrome.surfaceLeft < 16, `maximized Surface did not move into the collapsed sidebar track: ${JSON.stringify(collapsedChrome)}`)
  assert.ok(collapsedChrome.surfaceActionLeft >= 80, `collapsed Surface chrome overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
  assert.equal(collapsedChrome.restored, true)

  const transportPicker = await evaluate(`(async () => {
    const deadline = Date.now() + 2_000
    let recent
    while (!recent && Date.now() < deadline) {
      recent = document.querySelector('button.sb-sess')
      if (!recent) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    document.querySelector('button.sb-new')?.click()
    const unlockDeadline = Date.now() + 2_000
    let unlockedAgent
    while ((!unlockedAgent || unlockedAgent.disabled) && Date.now() < unlockDeadline) {
      unlockedAgent = document.querySelector('button.clibtn')
      if (!unlockedAgent || unlockedAgent.disabled) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    unlockedAgent?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const button = [...document.querySelectorAll('button')].find((node) => node.title?.includes('API/BYOK'))
    return {
      recentFound: !!recent,
      newSessionAgentUnlocked: !!unlockedAgent && !unlockedAgent.disabled,
      menuFound: !!document.querySelector('.climenu'),
      apiPlaceholderFound: !!button
    }
  })()`)
  assert.deepEqual(transportPicker, {
    recentFound: true,
    newSessionAgentUnlocked: true,
    menuFound: true,
    apiPlaceholderFound: false
  })

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

  const terminalSmoke = await evaluate(`(async () => {
    const probe = (cwd, marker) => new Promise((resolve) => {
      let output = ''
      let session = null
      let settled = false
      let offData = () => {}
      let offExit = () => {}
      const finish = async (result, close = false) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        offData()
        offExit()
        if (close && session) await window.scry.terminalClose(session.id).catch(() => {})
        resolve(result)
      }
      const timeout = setTimeout(() => void finish({ ok: false, error: 'timeout', output }, true), 12_000)
      void (async () => {
        try {
          offData = window.scry.onTerminalData((event) => {
            if (event.id !== session?.id) return
            output += event.data
            const markerIndex = output.indexOf(marker + ':')
            if (markerIndex >= 0 && output.indexOf(String.fromCharCode(10), markerIndex) >= 0) {
              void finish({ ok: true, id: session.id, cwd: session.cwd, output })
            }
          })
          offExit = window.scry.onTerminalExit((event) => {
            if (event.id === session?.id && !output.includes(marker + ':')) {
              void finish({ ok: false, error: 'early-exit', event, output })
            }
          })
          session = await window.scry.terminalStart({ cwd, cols: 80, rows: 24 })
          await window.scry.terminalResize(session.id, 100, 30)
          const slash = String.fromCharCode(92)
          const encodedMarker = slash + '137' + slash + '137' + marker.slice(2)
          await window.scry.terminalWrite(
            session.id,
            "printf '" + encodedMarker + ":'; pwd -P" + String.fromCharCode(13)
          )
        } catch (error) {
          await finish({ ok: false, error: String(error), output }, true)
        }
      })()
    })
    const waitForExit = (id) => new Promise((resolve) => {
      let settled = false
      let timer = 0
      let off = () => {}
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        off()
        resolve(value)
      }
      off = window.scry.onTerminalExit((event) => {
        if (event.id === id) finish(true)
      })
      timer = setTimeout(() => finish(false), 2_000)
    })

    await window.scry.setCwd(null)
    const unbound = await probe(null, '__SCRY_TERMINAL_HOME_OK__')
    const unboundExit = waitForExit(unbound.id)
    await window.scry.setCwd(${JSON.stringify(workspace)})
    const unboundExited = await unboundExit
    let oldWriteRejected = false
    try {
      await window.scry.terminalWrite(unbound.id, 'pwd' + String.fromCharCode(13))
    } catch {
      oldWriteRejected = true
    }
    const bound = await probe(${JSON.stringify(workspace)}, '__SCRY_TERMINAL_WORKSPACE_OK__')
    if (bound.id) await window.scry.terminalClose(bound.id).catch(() => {})
    return { unbound, unboundExited, oldWriteRejected, bound }
  })()`)
  assert.equal(terminalSmoke.unbound.ok, true, `packaged unbound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.unbound.cwd, canonicalHome)
  assert.ok(terminalSmoke.unbound.output.includes(`__SCRY_TERMINAL_HOME_OK__:${canonicalHome}`))
  assert.equal(terminalSmoke.unboundExited, true)
  assert.equal(terminalSmoke.oldWriteRejected, true)
  assert.equal(terminalSmoke.bound.ok, true, `packaged bound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.bound.cwd, canonicalWorkspace)
  assert.ok(terminalSmoke.bound.output.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))

  const popupOpened = await evaluate(`window.open('file:///scry-smoke') !== null`)
  assert.equal(popupOpened, false)
  await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  const afterPopupTargets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json())
  assert.equal(afterPopupTargets.filter((target) => target.type === 'page').length, initialTargets.filter((target) => target.type === 'page').length)

  await evaluate(`location.assign('file:///scry-navigation-smoke')`)
  await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  const afterNavigation = await waitForTarget(port, 2_000)
  assert.equal(afterNavigation.page.url, page.url, 'will-navigate failed to keep renderer on its trusted URL')

  cdp.close()
  console.log(JSON.stringify({
    appPath,
    rendererUrl: page.url,
    preloadKeys: boundary.preloadKeys.length,
    terminal: true,
    surfaces: surfaceSmoke,
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
