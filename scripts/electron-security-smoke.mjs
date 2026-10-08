import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'

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
  const launchApp = () => {
    child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--disable-gpu',
      // This isolated fixture may be occluded by the user's active apps. Keep its
      // bounded UI waits independent of Chromium's background timer/priority throttling.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run'
    ], {
      env: {
        ...process.env,
        HOME: home,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '0',
        SCRY_ELECTRON_SMOKE_PROVIDER: '1',
        // The smoke adapter replaces Codex only. Never discover/start real Provider services.
        SCRY_DISABLED_PROVIDERS: 'claude,qoder,opencode,pi',
        SCRY_REMOTE_HOST: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => { stderr += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (code) => {
      if (code && code !== 0) stderr += `\nElectron exited ${code}`
    })
  }
  launchApp()

  const { page, targets: initialTargets } = await waitForTarget(port)
  assert.match(page.url, /^file:/, 'production renderer must load from a local file URL')
  let cdp = connectCdp(page.webSocketDebuggerUrl)
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
    'start', 'stop', 'activeRuns', 'usageStats', 'stats', 'listSessions', 'listProjects', 'mcpSnapshot', 'listSkills', 'onFocusedRun', 'onDataUpdated',
    'terminalStart', 'terminalActive', 'terminalAttach', 'terminalWrite', 'terminalResize', 'terminalReady', 'terminalAck', 'terminalClose', 'onTerminalData', 'onTerminalExit'
  ]) {
    assert.ok(boundary.preloadKeys.includes(key), `preload missing ${key}`)
  }
  const discovered = await evaluate(`Promise.all([window.scry.detectFast(), window.scry.detect(), window.scry.providerDescriptors()]).then((groups) => groups.map((group) => group.map((item) => item.id)))`)
  assert.deepEqual(discovered, [['codex'], ['codex'], ['codex']], 'smoke discovery must use only the fixture adapter')
  const disabledCapabilities = await evaluate(`Promise.all(['claude', 'qoder', 'opencode', 'pi'].map(async (providerId) => {
    const context = { providerId, cwd: ${JSON.stringify(workspace)} }
    const results = await Promise.all([window.scry.runControls(context), window.scry.listSkills(context)])
    return results.every((result) => result.state === 'unsupported' && result.reason.includes('SCRY_DISABLED_PROVIDERS'))
  }))`)
  assert.deepEqual(disabledCapabilities, [true, true, true, true], 'smoke must not start non-fixture providers')
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

  const lifecycleSmoke = await evaluate(`(async () => {
    const cwd = ${JSON.stringify(canonicalWorkspace)}
    await window.scry.setCwd(cwd)
    let cleanupDone = () => {}
    let cleanupError = () => {}
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fake Provider lifecycle timed out')), 15_000)
      cleanupDone = window.scry.onTurnDone((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        resolve({ kind: 'done', event })
      })
      cleanupError = window.scry.onError((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        reject(new Error(event.message))
      })
    })
    const started = await window.scry.start({ providerId: 'codex', cwd, prompt: 'packaged fake-provider smoke' })
    const outcome = await terminal
    const externalSessionId = outcome.event.externalSessionId || outcome.event.sessionId
    const loadedPage = await window.scry.loadSession({ providerId: 'codex', cwd, externalSessionId })
    const loaded = loadedPage?.turns || []
    const toolResult = loaded.flatMap((turn) => turn.items).find((item) => item.stage === 'tool_result')
    const ref = toolResult?.outputContent?.contentRef
    if (!ref || ref.bytes < 12 * 1024 * 1024) throw new Error('large tool body was not persisted')
    const tail = await window.scry.recorderContentPage({ source: 'app-trace', ref, offset: ref.bytes - 64, limit: 64 })
    const fullTail = atob(tail.dataBase64).includes('COMPLETE_LARGE_TOOL_TAIL')
    await window.scry.setCwd(null)
    let foreignContentDenied = false
    try { await window.scry.recorderContentPage({ source: 'app-trace', ref }) } catch { foreignContentDenied = true }
    await window.scry.setCwd(cwd)
    const stats = await window.scry.stats()
    return {
      sameRun: outcome.event.runId === started.runId,
      externalSessionId,
      loadedTurns: loaded.length,
      boundedHistory: JSON.stringify(loaded).length < 64 * 1024,
      fullTail,
      foreignContentDenied,
      hasTool: loaded.some((turn) => turn.items.some((item) => item.stage === 'tool_use')),
      rawInput: loaded.some((turn) => turn.items.some((item) => JSON.stringify(item.input ?? item.inputContent ?? null).includes('sk-ant-api03-scry-smoke-not-a-real-key-000000'))),
      rawOutput: loaded.some((turn) => turn.items.some((item) => item.stage === 'tool_result' && JSON.stringify(item.output ?? item.text ?? item.outputContent ?? null).includes('sk-ant-api03-scry-smoke-not-a-real-key-000000'))),
      statsStatus: stats.status,
      statsTurns: stats.totals.turns
    }
  })()`)
  assert.equal(lifecycleSmoke.sameRun, true)
  assert.ok(lifecycleSmoke.externalSessionId)
  assert.ok(lifecycleSmoke.loadedTurns >= 1)
  assert.equal(lifecycleSmoke.hasTool, true)
  assert.equal(lifecycleSmoke.boundedHistory, true, 'large tool body must not cross history IPC inline')
  assert.equal(lifecycleSmoke.fullTail, true, 'the entire captured body must remain inspectable')
  assert.equal(lifecycleSmoke.foreignContentDenied, true, 'content reference must not cross workspace scope')
  assert.equal(lifecycleSmoke.rawInput, true, 'captured tool input must survive archive reload verbatim')
  assert.equal(lifecycleSmoke.rawOutput, true, 'captured tool output must survive archive reload verbatim')
  assert.equal(lifecycleSmoke.statsStatus, 'ready')
  assert.ok(lifecycleSmoke.statsTurns >= 1)

  const windowChrome = await evaluate(`(() => {
    const inspect = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const style = getComputedStyle(node)
      const rect = node.getBoundingClientRect()
      return {
        top: Math.round(rect.top),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        background: style.backgroundColor,
        drag: style.getPropertyValue('-webkit-app-region'),
        paddingLeft: style.paddingLeft,
        position: style.position,
        borderRadius: style.borderRadius
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
      viewportWidth: document.documentElement.clientWidth,
      sidebar: inspect('.sidebar'),
      brand: inspect('.sb-brand'),
      main: inspect('.main-area'),
      topbar: inspect('.topbar'),
      surfaceSlot: inspect('.right-panel-slot'),
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
    [windowChrome.brand?.top, windowChrome.topbar?.top],
    [0, 0],
    'macOS primary app columns must extend to the top window edge'
  )
  assert.deepEqual(
    [windowChrome.surfaceSlot?.top, windowChrome.surfaceTopbar?.top],
    [0, 0],
    'on-demand Surface must join the integrated titlebar at the window edge'
  )
  assert.deepEqual(
    [windowChrome.surfaceSlot?.position, windowChrome.surfaceSlot?.borderRadius],
    ['static', '0px'],
    'on-demand Surface must remain a docked split workspace'
  )
  assert.ok(windowChrome.surfaceSlot?.width >= 360, 'docked Surface fell below its usable width')
  assert.equal(
    windowChrome.viewportWidth - windowChrome.surfaceSlot?.right,
    0,
    'docked Surface lost its right-edge alignment'
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
  assert.equal(windowChrome.surfaceTopbar?.background, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.brand, 'rgba(0, 0, 0, 0)')
  assert.equal(windowChrome.lightBackgrounds.topbar, windowChrome.lightBackgrounds.main)
  assert.equal(windowChrome.lightBackgrounds.surfaceTopbar, 'rgba(0, 0, 0, 0)')
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

    const analyticsButton = [...document.querySelectorAll('button.sb-navitem')]
      .find((node) => node.textContent?.includes('分析'))
    analyticsButton?.click()
    const analytics = await waitFor(() => !!document.querySelector('.usage-page'))
    const analyticsLoading = document.querySelector('.lazy-panel-loading')?.textContent
    const auxTopbar = document.querySelector('.aux-view-topbar')
    const auxRect = auxTopbar?.getBoundingClientRect()
    const auxDrag = auxTopbar ? getComputedStyle(auxTopbar).getPropertyValue('-webkit-app-region') : null
    const analyticsTop = Math.round(document.querySelector('.usage-page')?.getBoundingClientRect().top ?? -1)

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
      analytics,
      analyticsLoading,
      auxTop: Math.round(auxRect?.top ?? -1),
      auxHeight: Math.round(auxRect?.height ?? -1),
      auxDrag,
      analyticsTop,
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
  assert.equal(collapsedChrome.analytics, true, `Analytics transition failed: ${JSON.stringify(collapsedChrome)}`)
  assert.deepEqual(
    [collapsedChrome.auxTop, collapsedChrome.auxHeight, collapsedChrome.auxDrag],
    [0, 52, 'drag'],
    `auxiliary view is missing integrated window chrome: ${JSON.stringify(collapsedChrome)}`
  )
  assert.ok(collapsedChrome.analyticsTop >= 52, `Analytics overlaps traffic lights: ${JSON.stringify(collapsedChrome)}`)
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
    const menuDeadline = Date.now() + 2_000
    while (!document.querySelector('.climenu') && Date.now() < menuDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
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
    let dialog = null
    let focusedInside = false
    for (let attempt = 0; attempt < 40; attempt++) {
      dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      focusedInside = !!dialog && dialog.contains(document.activeElement)
      if (focusedInside) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    let closed = false
    let restored = false
    for (let attempt = 0; attempt < 40; attempt++) {
      closed = !document.querySelector('[role="dialog"]')
      restored = document.activeElement === trigger
      if (closed && restored) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return {
      opened: !!dialog,
      labelled: !!dialog?.getAttribute('aria-labelledby'),
      focusedInside,
      closed,
      restored
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
        if (!result.ok || close) {
          offData()
          offExit()
        }
        if (close && session) await window.scry.terminalClose(session.id, session.ownershipEpoch).catch(() => {})
        resolve(result)
      }
      const timeout = setTimeout(() => void finish({ ok: false, error: 'timeout', output }, true), 12_000)
      void (async () => {
        try {
          offData = window.scry.onTerminalData((event) => {
            if (event.id !== session?.id) return
            void window.scry.terminalAck(event.id, event.ownershipEpoch, new TextEncoder().encode(event.data).byteLength)
            output += event.data
            const markerIndex = output.indexOf(marker + ':')
            if (markerIndex >= 0 && output.indexOf(String.fromCharCode(10), markerIndex) >= 0) {
              void finish({ ok: true, id: session.id, ownershipEpoch: session.ownershipEpoch, cwd: session.cwd, output })
            }
          })
          offExit = window.scry.onTerminalExit((event) => {
            if (event.id === session?.id && !output.includes(marker + ':')) {
              void finish({ ok: false, error: 'early-exit', event, output })
            }
          })
          session = await window.scry.terminalStart({ cwd, cols: 80, rows: 24 })
          await window.scry.terminalReady(session.id, session.ownershipEpoch)
          await window.scry.terminalResize(session.id, session.ownershipEpoch, 100, 30)
          const slash = String.fromCharCode(92)
          const encodedMarker = slash + '137' + slash + '137' + marker.slice(2)
          await window.scry.terminalWrite(
            session.id,
            session.ownershipEpoch,
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
    const oldWriteRejected = await window.scry.terminalWrite(
      unbound.id, unbound.ownershipEpoch, 'pwd' + String.fromCharCode(13)
    ) === false
    const bound = await probe(${JSON.stringify(workspace)}, '__SCRY_TERMINAL_WORKSPACE_OK__')
    const activeBeforeAttach = (await window.scry.terminalActive()).some((session) => session.id === bound.id)
    const adopted = await window.scry.terminalAttach(bound.id)
    let replay = ''
    let offset = 0
    while (offset < adopted.catchUp.endOffset) {
      const page = await window.scry.terminalRecordingRead({
        id: bound.id,
        offset,
        limit: Math.max(4, Math.min(64 * 1024, adopted.catchUp.endOffset - offset))
      })
      replay += page.data
      if (page.nextOffset <= offset) throw new Error('terminal catch-up cursor stalled')
      offset = page.nextOffset
    }
    const staleWriteRejected = await window.scry.terminalWrite(
      bound.id, bound.ownershipEpoch, 'stale-owner'
    ) === false
    const adoptedReady = await window.scry.terminalReady(bound.id, adopted.ownershipEpoch)
    return { unbound, unboundExited, oldWriteRejected, bound, activeBeforeAttach, adopted, adoptedReady, staleWriteRejected, replay }
  })()`)
  assert.equal(terminalSmoke.unbound.ok, true, `packaged unbound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.unbound.cwd, canonicalHome)
  assert.ok(terminalSmoke.unbound.output.includes(`__SCRY_TERMINAL_HOME_OK__:${canonicalHome}`))
  assert.equal(terminalSmoke.unboundExited, true, JSON.stringify(terminalSmoke))
  assert.equal(terminalSmoke.oldWriteRejected, true)
  assert.equal(terminalSmoke.bound.ok, true, `packaged bound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.bound.cwd, canonicalWorkspace)
  assert.ok(terminalSmoke.bound.output.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))
  assert.equal(terminalSmoke.activeBeforeAttach, true)
  assert.ok(terminalSmoke.adopted.ownershipEpoch > terminalSmoke.bound.ownershipEpoch)
  assert.equal(terminalSmoke.adopted.catchUp.state, 'available')
  assert.equal(terminalSmoke.adoptedReady, true)
  assert.equal(terminalSmoke.staleWriteRejected, true)
  assert.ok(terminalSmoke.replay.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))

  await cdp.send('Page.enable')
  await cdp.send('Page.reload', { ignoreCache: true })
  const reloadDeadline = Date.now() + 15_000
  let activeAfterReload = false
  while (Date.now() < reloadDeadline && !activeAfterReload) {
    try {
      activeAfterReload = await evaluate(`(async () => {
        if (!window.scry?.terminalActive) return false
        return (await window.scry.terminalActive()).some((session) => session.id === ${JSON.stringify(terminalSmoke.bound.id)})
      })()`)
    } catch {
      // The old execution context is expected to disappear during reload.
    }
    if (!activeAfterReload) await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  assert.equal(activeAfterReload, true, 'renderer reload terminated the active PTY')
  const reloadAdoption = await evaluate(`(async () => {
    const id = ${JSON.stringify(terminalSmoke.bound.id)}
    const staleEpoch = ${JSON.stringify(terminalSmoke.adopted.ownershipEpoch)}
    const adopted = await window.scry.terminalAttach(id)
    let replay = ''
    let offset = 0
    while (offset < adopted.catchUp.endOffset) {
      const page = await window.scry.terminalRecordingRead({ id, offset, limit: Math.max(4, Math.min(64 * 1024, adopted.catchUp.endOffset - offset)) })
      replay += page.data
      if (page.nextOffset <= offset) throw new Error('renderer reload catch-up cursor stalled')
      offset = page.nextOffset
    }
    const staleWriteRejected = await window.scry.terminalWrite(id, staleEpoch, 'stale-after-reload') === false
    const ready = await window.scry.terminalReady(id, adopted.ownershipEpoch)
    const closed = await window.scry.terminalClose(id, adopted.ownershipEpoch)
    return { adopted, replay, staleWriteRejected, ready, closed }
  })()`)
  assert.ok(reloadAdoption.adopted.ownershipEpoch > terminalSmoke.adopted.ownershipEpoch)
  assert.equal(reloadAdoption.staleWriteRejected, true)
  assert.equal(reloadAdoption.ready, true)
  assert.equal(reloadAdoption.closed, true)
  assert.ok(reloadAdoption.replay.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`))

  const recordingSmoke = await evaluate(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8_000
      while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      if (!await predicate()) throw new Error('terminal recording UI condition timed out: ' + JSON.stringify({
        text: document.querySelector('.terminal-surface')?.textContent?.slice(-1500),
        host: document.querySelector('.terminal-pane:not([hidden]) .terminal-xterm')?.getBoundingClientRect().toJSON()
      }))
    }
    await waitFor(() => !!document.querySelector('button.sb-sess'))
    document.querySelector('button.sb-sess')?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(() => !!document.querySelector('button[title="右侧工作区"]'))
    const toggle = document.querySelector('button[title="右侧工作区"]')
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click()
    await waitFor(() => !!document.querySelector('.right-surface-panel'))
    let terminalTab = [...document.querySelectorAll('.surface-tab-activate')].find((node) => node.textContent.includes('终端'))
    if (!terminalTab) {
      document.querySelector('button[aria-label="添加 Surface"]')?.click()
      await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent?.trim().startsWith('终端')))
      ;[...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.trim().startsWith('终端'))?.click()
    } else terminalTab.click()
    const button = (label) => document.querySelector('button[aria-label="' + label + '"]')
    await waitFor(() => document.querySelector('.terminal-pane:not([hidden]) .terminal-xterm')?.clientWidth > 0)
    const priorIds = new Set((await window.scry.terminalRecordingList()).items.map((item) => item.id))
    button('重新启动终端').click()
    let startedId = null
    await waitFor(async () => {
      startedId = (await window.scry.terminalRecordingList()).items.find((item) => item.active && !priorIds.has(item.id))?.id
      return !!startedId && !!document.querySelector('.terminal-state.running')
    })
    const disabledWhileRunning = button('回放终端录制').disabled && button('删除终端录制').disabled
    let offExit = () => {}
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { offExit(); reject(new Error('UI terminal did not exit')) }, 8_000)
      offExit = window.scry.onTerminalExit((event) => {
        if (event.id === startedId) { clearTimeout(timer); offExit(); resolve(event) }
      })
    })
    const textarea = document.querySelector('.terminal-pane:not([hidden]) .xterm-helper-textarea')
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', "printf '__SCRY_RECORDING_SENTINEL__\\\\n'; exit")
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }))
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    const ended = await exit
    await waitFor(() => !button('回放终端录制').disabled)
    const page = await window.scry.terminalRecordingRead({ id: ended.id, offset: 0, limit: 65536 })
    if (!page.data.includes('__SCRY_RECORDING_SENTINEL__')) throw new Error('UI Shell recording is missing its marker')
    button('清空终端显示').click()
    button('回放终端录制').click()
    await waitFor(() => document.querySelector('.terminal-foot')?.textContent.includes('录制回放完成'))
    // The footer is set only after xterm's write callback confirms parsing. DOM painting is renderer-dependent.
    const rendered = page.data
    document.querySelector('.terminal-tab.active .terminal-tab-close').click()
    const beforeHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    button('终端录制历史').click()
    await waitFor(() => !!document.querySelector('[data-recording-id="' + ended.id + '"] button'))
    document.querySelector('[data-recording-id="' + ended.id + '"] button').click()
    await waitFor(() => document.querySelector('.terminal-foot')?.textContent.includes('录制回放完成'))
    const readonly = button('重新启动终端').disabled
    const afterHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    const noSpawn = JSON.stringify(beforeHistory) === JSON.stringify(afterHistory)
    button('删除终端录制').click()
    await waitFor(() => document.querySelector('.terminal-foot')?.textContent.includes('磁盘录制已删除'))
    let deleted = false
    try { await window.scry.terminalRecordingRead({ id: ended.id, offset: 0 }) } catch { deleted = true }
    document.querySelector('.terminal-tab.active .terminal-tab-close').click()
    button('新建终端').click()
    await waitFor(() => !!document.querySelector('.terminal-state.running'))
    return { disabledWhileRunning, state: page.state, captured: page.data.includes('__SCRY_RECORDING_SENTINEL__'),
      replayed: rendered.includes('__SCRY_RECORDING_SENTINEL__'), readonly, noSpawn, deleted }
  })()`)
  assert.deepEqual(recordingSmoke, { disabledWhileRunning: true, state: 'complete', captured: true, replayed: true, readonly: true, noSpawn: true, deleted: true })

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
  // Ownership is captured outside Electron before the crash. Confirm the registered tree is
  // gone before restarting, rather than treating only the parent's exit as cleanup success.
  await stopOwnedApp(child, { crash: true })
  child = undefined
  launchApp()
  const restarted = await waitForTarget(port)
  cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const historyRestart = await evaluate(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8_000
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      if (!predicate()) throw new Error('cold terminal history UI condition timed out: ' + predicate.toString() + '; ' + document.querySelector('.terminal-surface')?.innerText?.slice(-1500))
    }
    await waitFor(() => !!document.querySelector('button.sb-sess'))
    document.querySelector('button.sb-sess').click()
    await waitFor(() => !!document.querySelector('button.sb-sess[aria-current="true"]'))
    const id = ${JSON.stringify(terminalSmoke.bound.id)}
    const cold = await window.scry.terminalRecordingList()
    const entry = cold.items.find((item) => item.id === id)
    const toggle = document.querySelector('button[title="右侧工作区"]')
    if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
    await waitFor(() => !!document.querySelector('button[aria-label="添加 Surface"]'))
    let terminalTab = [...document.querySelectorAll('.surface-tab-activate')].find((node) => node.textContent.includes('终端'))
    if (!terminalTab) {
      document.querySelector('button[aria-label="添加 Surface"]').click()
      await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent.trim().startsWith('终端')))
      ;[...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith('终端')).click()
    } else terminalTab.click()
    await waitFor(() => !!document.querySelector('.terminal-state.running'))
    const before = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    document.querySelector('button[aria-label="终端录制历史"]').click()
    await waitFor(() => !!document.querySelector('[data-recording-id="' + id + '"] button'))
    const row = document.querySelector('[data-recording-id="' + id + '"]')
    const modal = row.closest('[role="dialog"]')
    const modalAccessible = modal.getAttribute('aria-modal') === 'true' && modal.contains(document.activeElement)
    const rect = modal.getBoundingClientRect()
    const modalVisible = rect.width > 200 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && [[rect.left + 24, rect.top + 24], [rect.right - 24, rect.bottom - 24]].every(([x, y]) => modal.contains(document.elementFromPoint(x, y)))
    row.querySelector('button').click()
    await waitFor(() => document.querySelector('.terminal-pane:not([hidden]) .xterm-rows')?.textContent.includes('__SCRY_TERMINAL_WORKSPACE_OK__'))
    const readonly = document.querySelector('button[aria-label="重新启动终端"]').disabled
    const after = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    const oldWriteRejected = await window.scry.terminalWrite(id, 1, 'no-old-shell') === false
    await window.scry.setCwd(null)
    const foreignHidden = !(await window.scry.terminalRecordingList()).items.some((item) => item.id === id)
    let foreignReadRejected = false
    try { await window.scry.terminalRecordingRead({ id, offset: 0 }) } catch { foreignReadRejected = true }
    return { found: !!entry && !entry.active, replayed: true, readonly, modalAccessible, modalVisible,
      noSpawn: JSON.stringify(before) === JSON.stringify(after), oldWriteRejected, foreignHidden, foreignReadRejected }
  })()`)
  assert.deepEqual(historyRestart, { found: true, replayed: true, readonly: true, modalAccessible: true, modalVisible: true,
    noSpawn: true, oldWriteRejected: true, foreignHidden: true, foreignReadRejected: true })
  cdp.close()
  console.log(JSON.stringify({
    appPath,
    rendererUrl: page.url,
    preloadKeys: boundary.preloadKeys.length,
    fixtureDiscovery: discovered,
    toolContent: { boundedHistory: lifecycleSmoke.boundedHistory, fullTail: lifecycleSmoke.fullTail, foreignContentDenied: lifecycleSmoke.foreignContentDenied },
    terminal: true,
    rendererReloadTerminal: {
      active: activeAfterReload,
      epochAdvanced: reloadAdoption.adopted.ownershipEpoch > terminalSmoke.adopted.ownershipEpoch,
      replayed: reloadAdoption.replay.includes(`__SCRY_TERMINAL_WORKSPACE_OK__:${canonicalWorkspace}`),
      staleOwnerFenced: reloadAdoption.staleWriteRejected
    },
    recording: recordingSmoke,
    historyRestart: { ...historyRestart, mode: 'owned-app-crash' },
    surfaces: surfaceSmoke,
    modal,
    subframeIpc,
    popupDenied: true,
    navigationDenied: true
  }))
}

try {
  await main()
} catch (error) {
  // Keep the primary assertion and App logs visible even if cleanup independently fails.
  console.error('[scry] smoke failure:', error, stderr.slice(-8000))
  throw error
} finally {
  // A failed cleanup throws before deleting the fixture, preserving evidence for diagnosis.
  await stopOwnedApp(child)
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn(`[scry] smoke temp cleanup failed: ${error.message}`)
  }
}
