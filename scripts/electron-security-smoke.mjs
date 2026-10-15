import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { exerciseMetaPromptsApp } from './meta-prompts-ui-checks.mjs'
import { exerciseSourceControlApp } from './source-control-ui-checks.mjs'

const sourceControlOnly = process.argv[2] === '--dev-source-control-only'
const performanceOnly = ['--dev-performance-only', '--performance-only'].includes(process.argv[2])
const nativeHistoryOnly = process.argv[2] === '--dev-pi-history-only'
const fileHistoryOnly = ['--dev-file-history-only', '--file-history-only'].includes(process.argv[2])
const sourceFileHistory = fileHistoryOnly ? JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8')) : null
const devMetaPromptsOnly = process.argv[2] === '--dev-meta-prompts-only'
const devTerminalOnly = process.argv[2] === '--dev-terminal-only'
const devQuestionOnly = process.argv[2] === '--dev-question-only'
const foreground = process.argv.includes('--foreground')
// Dock attention is cleared only by a genuinely focused native window.
// Do not silently weaken that acceptance test or activate the app by default.
if (devQuestionOnly && !foreground) {
  throw new Error('Dock attention requires native foreground focus; explicitly opt in with --dev-question-only --foreground')
}
const devFilesOnly = process.argv[2] === '--dev-files-only'
const filesOnly = devFilesOnly || process.argv[2] === '--files-only'
const devApp = sourceControlOnly || devMetaPromptsOnly || nativeHistoryOnly || process.argv[2] === '--dev-file-history-only' || devTerminalOnly || devQuestionOnly || devFilesOnly || process.argv[2] === '--dev' || process.argv[2] === '--dev-performance-only'
const packagedAppArgument = ['--files-only', '--performance-only', '--file-history-only'].includes(process.argv[2]) ? undefined : process.argv[2]
const appPath = resolve(devApp ? 'node_modules/electron/dist/Electron.app' : packagedAppArgument || join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const executable = join(appPath, 'Contents', 'MacOS', devApp ? 'Electron' : 'Scry')
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
      // A file: target is published before Electron finishes creating its sandbox/preload
      // context. Do not enable Runtime/evaluate in that startup window. The static document
      // title is parsed after preload initialization; missing/broken preload still fails the
      // unchanged window.scry assertions below (both initial launch and cold restart).
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl && target.title === 'Scry')
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
  const workspace = filesOnly ? join(home, 'projects', 'dev-agent') : join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalHome = realpathSync(home)
  const canonicalWorkspace = realpathSync(workspace)
  const secondWorkspace = join(home, 'performance-second-project')
  if (performanceOnly || sourceControlOnly) {
    mkdirSync(secondWorkspace, { recursive: true })
    writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([canonicalWorkspace, realpathSync(secondWorkspace)]))
  }
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'smoke-run',
    runId: 'smoke-run',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    cwd: workspace,
    preview: 'security smoke',
    ts: Date.now()
  }]))
  const nativeSessionId = '01a1338c-3d8b-775b-8645-fd964faa29a3'
  if (nativeHistoryOnly) {
    // Reproduce a phone-created catalog row after host restart: no Scry archive,
    // but the Provider's real-format JSONL survives. No Provider is ever launched.
    const nativeDir = join(home, '.pi', 'agent', 'sessions', `--${canonicalWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
    mkdirSync(nativeDir, { recursive: true })
    const entry = (id, parentId, role, text) => ({ type: 'message', id, parentId,
      timestamp: '2026-10-13T04:36:31Z', message: { role, content: [{ type: 'text', text }] } })
    writeFileSync(join(nativeDir, `2026-10-13_${nativeSessionId}.jsonl`), [
      { type: 'session', version: 3, id: nativeSessionId, cwd: canonicalWorkspace },
      entry('u', null, 'user', '手机发起的真实格式消息'),
      entry('old', 'u', 'assistant', 'abandoned branch must not appear'),
      entry('a', 'u', 'assistant', '主机重启前已有的原生回复')
    ].map((value) => JSON.stringify(value)).join('\n'))
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId: nativeSessionId, externalSessionId: nativeSessionId, runId: 'remote-run-fixture-1',
      providerId: 'pi', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace,
      preview: '手机会话恢复测试', ts: Date.now()
    }]))
  }
  if (fileHistoryOnly) {
    assert.equal(sourceFileHistory.turns.length, 1, 'replay one exact archived turn')
    const source = sourceFileHistory
    const hash = value => createHash('sha256').update(value).digest('hex')
    const turn = source.turns[0]
    const archiveDir = join(userDataDir, 'trace-archive-turns-v1', source.providerId, `cwd-${hash(source.cwd)}`, `sid-${hash(source.sessionId)}`)
    mkdirSync(archiveDir, { recursive: true })
    const identity = turn.providerTurnId ? `provider\0${turn.providerTurnId}` : `run\0${turn.runId}`
    writeFileSync(join(archiveDir, `turn-${hash(identity)}.json`), JSON.stringify(source))
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId: source.sessionId, externalSessionId: source.externalSessionId, runId: turn.runId,
      providerId: source.providerId, runtimeProvider: source.runtimeProvider,
      cwd: source.cwd, preview: 'Archived file-link replay', ts: Date.now()
    }]))
    writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([source.cwd]))
  }
  const openReceipt = join(temp, 'opened-paths.json')
  const filesEntry = join(temp, 'files-main.mjs')
  if (devFilesOnly) {
    // Run production handlers without launching viewers or executing fixture programs.
    // The receipt records the exact OS handoff after resolution and authorization.
    writeFileSync(filesEntry, `
      import { shell } from 'electron'
      import { writeFileSync } from 'node:fs'
      const opened = []
      shell.openPath = async (path) => {
        opened.push(path)
        writeFileSync(${JSON.stringify(openReceipt)}, JSON.stringify(opened))
        return path.endsWith('/fail.custom') ? 'fixture: no application associated' : ''
      }
      await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)})
    `)
  }
  const badgeReceipt = join(temp, 'dock-badge.json')
  const questionEntry = join(temp, 'question-main.mjs')
  if (devQuestionOnly) {
    // Exercise startup and repeated viewing against a stale native Dock badge.
    // Forward every call to Electron; a denied OS permission remains explicit.
    writeFileSync(questionEntry, `
      import { app } from 'electron'
      import { writeFileSync } from 'node:fs'
      app.whenReady().then(async () => {
        const initial = { success: app.setBadgeCount(1), nativeCount: app.getBadgeCount() }
        const requests = []
        let residual = null
        const setBadgeCount = app.setBadgeCount.bind(app)
        app.setBadgeCount = (count) => {
          const success = setBadgeCount(count)
          requests.push({ count, success, nativeCount: app.getBadgeCount(), dockBadge: app.dock.getBadge() })
          if (count === 0 && requests.some(request => request.count === 1) && !residual) {
            // The session is already read. Recreate native drift without changing unread state.
            const restored = setBadgeCount(1)
            residual = { success: restored, nativeCount: app.getBadgeCount(), dockBadge: app.dock.getBadge() }
          }
          writeFileSync(${JSON.stringify(badgeReceipt)}, JSON.stringify({ initial, requests, residual }))
          return success
        }
        writeFileSync(${JSON.stringify(badgeReceipt)}, JSON.stringify({ initial, requests, residual }))
        await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)})
      })
    `)
  }
  const launchApp = () => {
    child = spawn(executable, [
      ...(devApp ? [devQuestionOnly ? questionEntry : devFilesOnly ? filesEntry : resolve('.')] : []),
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
        SCRY_TEST_APP: foreground ? '0' : '1',
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
  if (sourceControlOnly) {
    const result = await exerciseSourceControlApp(cdp, evaluate, { workspace: canonicalWorkspace, remote: realpathSync(secondWorkspace), home })
    cdp.close()
    console.log(JSON.stringify(result))
    return
  }
  if (devMetaPromptsOnly) {
    const result = await exerciseMetaPromptsApp(cdp, evaluate)
    cdp.close()
    await stopOwnedApp(child)
    launchApp()
    const restarted = await waitForTarget(port)
    cdp = connectCdp(restarted.page.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await evaluate(`(async () => {
      const deadline = Date.now() + 5000;
      while (!document.querySelector('[aria-label="主要视图"] .sb-navitem:last-child')) {
        if (Date.now() > deadline) throw new Error('Restarted App navigation missing');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      document.querySelector('[aria-label="主要视图"] .sb-navitem:last-child').click();
    })()`)
    await evaluate(`(async () => {
      const deadline = Date.now() + 5000;
      while (document.querySelector('.mp-body')?.textContent !== ${JSON.stringify(result.body)}) {
        if (Date.now() > deadline) throw new Error('Prompt lost after full App restart');
        await new Promise(resolve => setTimeout(resolve, 16));
      }
    })()`)
    cdp.close()
    console.log(JSON.stringify({ ...result, coldRestartPersistence: true }))
    return
  }
  if (fileHistoryOnly) {
    const source = sourceFileHistory
    const candidates = [...new Set(source.turns[0].items.flatMap(event => event.filePath?.endsWith('/brief.md') ? [event.filePath] : []))]
    assert.equal(candidates.length, 1, 'archive must identify the requested file uniquely')
    const expected = readFileSync(candidates[0], 'utf8')
    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 10000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('File history UI timed out: ' + ${JSON.stringify(expression)});
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`)
    const click = async expression => {
      const point = await evaluate(`(() => {
        const button = ${expression};
        if (!button) throw new Error('Replay target not found');
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Replay target obscured');
        return { x, y };
      })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    await wait(`Array.from(document.querySelectorAll('.sb-sess')).some(button => button.textContent.includes('Archived file-link replay'))`)
    await click(`Array.from(document.querySelectorAll('.sb-sess')).find(button => button.textContent.includes('Archived file-link replay'))`)
    await wait(`Array.from(document.querySelectorAll('.md-file-ref')).some(button => button.textContent === 'brief.md')`)
    const brief = `Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.textContent === 'brief.md')`
    const title = await evaluate(`(${brief}).title`)
    assert.ok(title.includes('designs/scry-unified-remote/brief.md'), `wrong archived target: ${title}`)
    await click(brief)
    await wait(`document.querySelector('.workspace-title b')?.textContent.includes('brief.md')`)
    await click(`Array.from(document.querySelectorAll('.workspace-editorbar button')).find(button => button.textContent === '展开源码')`)
    await wait(`document.querySelector('.workspace-editor textarea')?.value === ${JSON.stringify(expected)}`)
    assert.ok(!await evaluate(`document.body.textContent.includes('文件不存在：brief.md')`))
    assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
    console.log(JSON.stringify({ archivedFileLink: { runId: source.turns[0].runId, path: candidates[0], exactBytes: true, nativeClick: true, noProviderRuns: true, isolatedUserData: true } }))
    cdp.close()
    return
  }
  if (nativeHistoryOnly) {
    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 10000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('Native history UI timed out: ' + ${JSON.stringify(expression)});
        await new Promise(requestAnimationFrame);
      }
    })()`)
    await wait(`Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('手机会话恢复测试'))`)
    const point = await evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('手机会话恢复测试'));
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      if (!button.contains(document.elementFromPoint(x, y))) throw new Error('Session row obscured');
      return { x, y };
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await wait(`document.body.textContent.includes('主机重启前已有的原生回复')`)
    const text = await evaluate('document.body.textContent')
    assert.ok(text.includes('手机发起的真实格式消息'))
    assert.ok(text.includes('Pi 原生会话记录'))
    assert.ok(!text.includes('abandoned branch must not appear'))
    assert.deepEqual(await evaluate('window.scry.activeRuns()'), [])
    // Continue/reopen after one canonical archived turn is added. The original
    // native-only prefix must survive, and a requested page limit must be real.
    const nativePath = join(home, '.pi', 'agent', 'sessions', `--${canonicalWorkspace.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, `2026-10-13_${nativeSessionId}.jsonl`)
    const entries = readFileSync(nativePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    let parentId = entries.at(-1).id
    for (let i = 0; i < 40; i++) {
      entries.push({ type: 'message', id: `continued-user-${i}`, parentId, timestamp: '2026-10-13T05:00:00Z',
        message: { role: 'user', content: [{ type: 'text', text: `continued prompt ${i}` }] } })
      parentId = `continued-reply-${i}`
      entries.push({ type: 'message', id: parentId, parentId: `continued-user-${i}`, timestamp: '2026-10-13T05:00:01Z',
        message: { role: 'assistant', content: [{ type: 'text', text: `continued reply ${i}` }] } })
    }
    writeFileSync(nativePath, entries.map(entry => JSON.stringify(entry)).join('\n'))
    const context = { providerId: 'pi', cwd: canonicalWorkspace, externalSessionId: nativeSessionId }
    const page = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 3 })`)
    assert.equal(page.totalTurns, 41)
    assert.equal(page.offset, 38)
    assert.equal(page.turns.length, 3)
    assert.equal(page.hasOlder, true)
    const hash = value => createHash('sha256').update(value).digest('hex')
    const archiveDir = join(userDataDir, 'trace-archives-v2', 'pi', `cwd-${hash(canonicalWorkspace)}`)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(join(archiveDir, `sid-${hash(nativeSessionId)}.json`), JSON.stringify({ version: 3,
      providerId: 'pi', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace, sessionId: nativeSessionId,
      turns: [{ runId: 'scry-continuation', providerTurnId: 'continued-user-39', userText: 'continued prompt 39',
        done: true, status: 'completed', ts: Date.now(), items: [{ id: 'canonical', runId: 'scry-continuation',
          kind: 'model', stage: 'text', text: 'continued reply 39', ts: '2026-10-13T05:00:01Z' }] }]
    }))
    const reopened = await evaluate(`window.scry.loadSession(${JSON.stringify(context)}, { limit: 3 })`)
    assert.equal(reopened.totalTurns, 41)
    assert.equal(reopened.turns.length, 3)
    assert.equal(reopened.turns.at(-1).runId, 'scry-continuation')
    const oldest = await evaluate(`window.scry.loadSessionOlder(${JSON.stringify(context)}, { before: 1, limit: 1 })`)
    assert.equal(oldest.turns.length, 1)
    assert.equal(oldest.turns[0].userText, '手机发起的真实格式消息')
    console.log('Pi native history: click restores phone conversation; provenance, 41-turn pagination and continuation/reopen verified without Provider execution')
    cdp.close()
    return
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
    'start', 'stop', 'activeRuns', 'llmPerformanceSummary', 'llmPerformanceHistory', 'usageStats', 'stats', 'listSessions', 'listProjects', 'mcpSnapshot', 'listSkills', 'onFocusedRun', 'onDataUpdated',
    'terminalStart', 'terminalActive', 'terminalAttach', 'terminalWrite', 'terminalResize', 'terminalReady', 'terminalAck', 'terminalClose', 'onTerminalData', 'onTerminalExit'
  ]) {
    assert.ok(boundary.preloadKeys.includes(key), `preload missing ${key}`)
  }
  if (performanceOnly) {
    const measurement = await evaluate(`(async () => {
      const waitFor = async (read, label) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const result = await read()
          if (result) return result
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Performance IPC timed out: ' + label)
      }
      const initial = await window.scry.llmPerformanceSummary()
      if (initial.sessions.length !== 0) throw new Error('Fresh instance invented running sessions')
      const first = await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(workspace)}, prompt: 'llm performance smoke' })
      const second = await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(secondWorkspace)}, prompt: 'llm performance smoke' })
      const active = await waitFor(async () => {
        const runs = await window.scry.activeRuns()
        return runs.length === 2 && runs.every(run => run.llmPerformance?.firstOutputWaitMs != null) ? runs : null
      }, 'main observer snapshots')
      const sampled = await window.scry.llmPerformanceSummary()
      if (sampled.sessions.length !== 2 || !sampled.sessions.every(session => session.outputStarted && session.providerId === 'codex'))
        throw new Error('Main registry/observer session mismatch: ' + JSON.stringify(sampled))
      // Speed comes only from the run's own per-call observation, never from the summary itself.
      const speeds = active.map(run => run.llmPerformance.apiTokensPerSecond ?? null).sort()
      if (JSON.stringify(sampled.sessions.map(session => session.tokensPerSecond ?? null).sort()) !== JSON.stringify(speeds))
        throw new Error('Main synthesized session speed: ' + JSON.stringify(sampled))
      await window.scry.focusRun(null)
      if ((await window.scry.llmPerformanceSummary()).sessions.length !== 2) throw new Error('Focus removed background runs')
      return { runIds: [first.runId, second.runId], running: sampled.sessions.length }
    })()`)
    const point = await evaluate(`(() => {
      const node = document.querySelector('.sb-navitem[title="LLM 性能"]')
      if (!node) throw new Error('Production performance entry missing')
      node.focus()
      const box = node.getBoundingClientRect()
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    const modal = await evaluate(`(async () => {
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const dialog = document.querySelector('.llm-perf-modal[role="dialog"]')
        if (dialog?.contains(document.activeElement) && dialog.textContent.includes('2 个会话运行中') && dialog.querySelectorAll('.llm-perf-run').length === 2)
          return { focused: true, labelled: !!dialog.getAttribute('aria-labelledby') }
        await new Promise(requestAnimationFrame)
      }
      throw new Error('Production modal did not load real IPC history or focus')
    })()`)
    assert.deepEqual(modal, { focused: true, labelled: true })
    const terminal = await evaluate(`(async () => {
      for (const runId of ${JSON.stringify(measurement.runIds)}) await window.scry.stop(runId)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const summary = await window.scry.llmPerformanceSummary()
        const history = await window.scry.llmPerformanceHistory()
        const dialog = document.querySelector('.llm-perf-modal')
        if (summary.sessions.length === 0 && history.rows.length === 2 && dialog?.textContent.includes('无运行中的会话')) {
          if (!history.rows.every(row => row.failed && row.performance.firstOutputWaitMs != null && row.performance.networkConfiguration && row.performance.tokenTimingSource !== 'provider_api'))
            throw new Error('Failed rounds lost evidence or fabricated API timing')
          if (dialog.querySelector('.llm-perf-mrow, .llm-perf-line')) throw new Error('Stopped rounds were drawn as speed')
          return { historyRounds: history.rows.length, networkSources: history.rows.map(row => row.performance.networkConfiguration.source) }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error('Live production modal did not clear stopped runs or refresh owned history: ' + JSON.stringify({
        summary: await window.scry.llmPerformanceSummary(), history: await window.scry.llmPerformanceHistory(),
        dialog: document.querySelector('.llm-perf-modal')?.textContent
      }))
    })()`)

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    assert.equal(await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(!document.querySelector('.llm-perf-modal') && document.activeElement?.title === 'LLM 性能'))))`), true)
    console.log(JSON.stringify({ productionPerformance: { ...measurement, ...terminal }, modal }))
    cdp.close()
    return
  }
  const discovered = await evaluate(`Promise.all([window.scry.detectFast(), window.scry.detect(), window.scry.providerDescriptors()]).then((groups) => groups.map((group) => group.map((item) => item.id)))`)
  assert.deepEqual(discovered, [['codex'], ['codex'], ['codex']], 'smoke discovery must use only the fixture adapter')
  const disabledCapabilities = await evaluate(`Promise.all(['claude', 'qoder', 'opencode', 'pi'].map(async (providerId) => {
    const context = { providerId, cwd: ${JSON.stringify(workspace)} }
    const results = await Promise.all([window.scry.runControls(context), window.scry.listSkills(context)])
    return results.every((result) => result.state === 'unsupported' && result.reason.includes('SCRY_DISABLED_PROVIDERS'))
  }))`)
  assert.deepEqual(disabledCapabilities, [true, true, true, true], 'smoke must not start non-fixture providers')
  if (filesOnly) {
    const cwd = join(canonicalHome, 'projects', 'dev-agent')
    const docs = join(canonicalHome, 'projects', 'rotom-team', 'docs')
    mkdirSync(docs, { recursive: true })
    writeFileSync(join(docs, 'NATIVE-DELIVERY.md'), '# Actual sibling delivery\n')
    writeFileSync(join(canonicalHome, 'projects', 'LICENSE'), 'Actual license without an extension')
    writeFileSync(join(canonicalHome, 'projects', 'asset.custom'), Buffer.from([0, 1, 2, 3]))
    writeFileSync(join(canonicalHome, 'projects', 'report.docx'), Buffer.from([0x50, 0x4b, 0, 1]))
    writeFileSync(join(cwd, 'run.command'), '#!/bin/sh\necho never-run')
    const screens = join(temp, 'screens')
    mkdirSync(screens)
    symlinkSync(screens, join(cwd, 'screens'))
    for (const name of ['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom', 'fail.custom']) {
      writeFileSync(join(screens, name), Buffer.from([0, 1, 2, 3]))
    }
    writeFileSync(join(temp, 'outside.md'), '# Actual outside-home delivery\n')
    symlinkSync(join(temp, 'outside.md'), join(cwd, 'escaped.md'))
    const resolved = await evaluate(`(async () => {
      const cwd = ${JSON.stringify(cwd)};
      await window.scry.setCwd(cwd);
      const text = await window.scry.workspaceResolveFile({ cwd, path: 'rotom-team/docs/NATIVE-DELIVERY.md' });
      const snapshot = await window.scry.workspaceReadKnown(text);
      const binary = await window.scry.workspaceResolveFile({ cwd, path: '../asset.custom' });
      const office = await window.scry.workspaceResolveFile({ cwd, path: '../report.docx' });
      const outside = [];
      for (const path of ['escaped.md', ${JSON.stringify(join(temp, 'outside.md'))}]) {
        const target = await window.scry.workspaceResolveFile({ cwd, path });
        const file = await window.scry.workspaceReadKnown(target);
        const page = await window.scry.workspaceReadPageKnown({ ...target, limit: 10 });
        outside.push({ mode: target.mode, content: file.content, page: page.content });
      }
      const target = await window.scry.workspaceResolveFile({ cwd, path: 'escaped.md' });
      const denied = [];
      for (const operation of [
        () => window.scry.workspaceResolveFile({ cwd: ${JSON.stringify(temp)}, path: 'outside.md' }),
        () => window.scry.workspaceReadKnown({ ...target, path: 'other.md' }),
        () => window.scry.workspaceReadKnown({ cwd: 'scry-file:forged', path: 'outside.md' }),
        () => window.scry.workspaceWrite({ ...target, content: 'must not write', expectedRevision: 'x' })
      ]) {
        try { await operation(); denied.push(false); }
        catch { denied.push(true); }
      }
      const script = await window.scry.workspaceResolveFile({ cwd, path: 'run.command' });
      ${devFilesOnly ? "await window.scry.workspaceOpenExternal({ cwd, path: 'run.command' });" : ''}
      return { text, content: snapshot.content, binary: binary.mode, office: office.mode, outside, denied, script: script.mode };
    })()`)
    assert.deepEqual(resolved.text, { cwd: '~', path: 'projects/rotom-team/docs/NATIVE-DELIVERY.md', mode: 'text' })
    assert.equal(resolved.content, '# Actual sibling delivery\n')
    assert.equal(resolved.binary, 'external')
    assert.equal(resolved.office, 'external')
    assert.deepEqual(resolved.outside, [0, 1].map(() => ({
      mode: 'text', content: '# Actual outside-home delivery\n', page: '# Actual outs'
    })))
    assert.deepEqual(resolved.denied, [true, true, true, true])
    assert.equal(resolved.script, 'text')
    if (devFilesOnly) assert.deepEqual(JSON.parse(readFileSync(openReceipt, 'utf8')), [join(cwd, 'run.command')])
    await evaluate(`(async () => {
      let offDone, offError;
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('file-link fixture timed out')), 10000);
        const cleanup = () => { clearTimeout(timer); offDone(); offError(); };
        offDone = window.scry.onTurnDone(() => { cleanup(); resolve(); });
        offError = window.scry.onError(event => { cleanup(); reject(new Error(event.message)); });
      });
      await window.scry.start({ providerId: 'codex', cwd: ${JSON.stringify(cwd)}, prompt: 'file links smoke' });
      await terminal;
    })()`)
    const wait = expression => evaluate(`(async () => {
      const deadline = performance.now() + 8000;
      while (!(${expression})) {
        if (performance.now() > deadline) throw new Error('File-link condition timed out: ' + ${JSON.stringify(expression)});
        // Hidden windows can suspend animation frames; keep the failure deadline live.
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })()`)
    const clickFile = async title => {
      await wait(`Array.from(document.querySelectorAll('.md-file-ref')).some(button => button.title === ${JSON.stringify(title)})`)
      await evaluate(`Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.title === ${JSON.stringify(title)}).scrollIntoView({ block: 'center' })`)
      // DOM presence can precede the frame used by native input hit testing.
      // Paint the scrolled result, then measure and hit-test that rendered frame.
      await cdp.send('Page.captureScreenshot', { format: 'png' })
      const point = await evaluate(`(() => {
        const button = Array.from(document.querySelectorAll('.md-file-ref')).find(button => button.title === ${JSON.stringify(title)});
        const box = button.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        if (!button.contains(document.elementFromPoint(x, y))) throw new Error('File link obscured');
        return { x, y };
      })()`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    await clickFile('rotom-team/docs/NATIVE-DELIVERY.md · 在右侧文件面板打开')
    // Markdown opens as a read-only preview first (7d4b6bd); expanding the
    // source must show the actual file bytes in a read-only textarea.
    await wait(`document.querySelector('.workspace-preview h1')?.textContent === 'Actual sibling delivery' && document.querySelector('.workspace-editorbar')?.textContent.includes('只读预览')`)
    await evaluate(`Array.from(document.querySelectorAll('.workspace-editorbar button')).find(button => button.textContent === '展开源码').click()`)
    await wait(`document.querySelector('textarea[aria-label="查看 NATIVE-DELIVERY.md"]')?.value === '# Actual sibling delivery\\n'`)
    assert.equal(await evaluate(`document.querySelector('textarea[aria-label="查看 NATIVE-DELIVERY.md"]').readOnly`), true)
    await clickFile('../LICENSE · 打开文件')
    await wait(`document.querySelector('textarea[aria-label="查看 LICENSE"]')?.value === 'Actual license without an extension'`)
    await clickFile('escaped.md · 打开文件')
    await wait(`document.querySelector('.workspace-preview h1')?.textContent === 'Actual outside-home delivery' && document.querySelector('.workspace-editorbar')?.textContent.includes('只读预览')`)
    assert.equal(readFileSync(join(temp, 'outside.md'), 'utf8'), '# Actual outside-home delivery\n')
    await clickFile('missing.md · 在右侧文件面板打开')
    await wait(`document.body.textContent.includes('文件不存在：missing.md')`)
    if (devFilesOnly) {
      const waitForOpen = async path => {
        const deadline = Date.now() + 8000
        while (JSON.parse(readFileSync(openReceipt, 'utf8')).at(-1) !== path) {
          if (Date.now() > deadline) throw new Error(`No system handoff for ${path}`)
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }
      await clickFile('screens · 在外部应用打开')
      await waitForOpen(realpathSync(screens))
      for (const name of ['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom']) {
        await clickFile(`screens/${name} · ${name.endsWith('.png') ? '在外部应用打开' : '在右侧文件面板打开'}`)
        await waitForOpen(join(realpathSync(screens), name))
        await wait(`!document.querySelector('.composer-status.is-error')`)
      }
      assert.deepEqual(JSON.parse(readFileSync(openReceipt, 'utf8')), [
        join(cwd, 'run.command'), realpathSync(screens),
        ...['remote-workspace.png', 'remote-hosts.png', 'remote-settings.png', 'asset.custom'].map(name => join(realpathSync(screens), name))
      ])
      await clickFile('screens/fail.custom · 在右侧文件面板打开')
      await wait(`document.body.textContent.includes('fixture: no application associated')`)
      assert.equal(JSON.parse(readFileSync(openReceipt, 'utf8')).filter(path => path.endsWith('/fail.custom')).length, 1)
    }
    console.log(JSON.stringify({ fileLinks: { siblingProject: true, actualContent: true, readOnlyOutsideWorkspace: true,
      extensionlessLink: true, officeAndUnknownBinary: true, outsideHomeSymlink: true, fileScopedReads: true,
      missingFileReported: true, outsideWorkspaceWriteDenied: true,
      contextualScreenshotsAndDirectory: devFilesOnly, executableHandoff: devFilesOnly, systemErrorReportedWithoutRetry: devFilesOnly } }))
    cdp.close()
    return
  }
  if (devQuestionOnly) {
    const startupBadge = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.equal(startupBadge.requests[0]?.count, 0, 'production startup must synchronize the empty unread count to Dock')
    if (startupBadge.requests[0].success) {
      assert.equal(startupBadge.requests[0].nativeCount, 0)
      assert.equal(startupBadge.requests[0].dockBadge, '')
    }
    const result = await evaluate(`(async () => {
      const waitFor = async (read, label) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const value = await read()
          if (value) return value
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Timed out waiting for ' + label)
      }
      const { runId } = await window.scry.start({
        providerId: 'codex', cwd: ${JSON.stringify(workspace)}, prompt: 'dock badge question smoke'
      })
      const pendingRun = async (questionId) => {
        const active = (await window.scry.activeRuns()).find(run => run.runId === runId)
        return active?.pendingQuestions?.some(question => question.questionId === questionId) ? active : null
      }
      const firstQuestionId = runId + ':question:1'
      await waitFor(() => pendingRun(firstQuestionId), 'initial question')
      await window.scry.focusRun(null)
      const answered = await window.scry.answerQuestion({
        runId, questionId: firstQuestionId, behavior: 'answered',
        answers: { 'Continue the isolated badge smoke?': 'Continue' }
      })
      if (!answered) throw new Error('Fixture question response was rejected')
      const run = await waitFor(() => pendingRun(runId + ':question:2'), 'background question')
      const unread = await window.scry.unreadSessions()
      await window.scry.focusRun(runId)
      const viewed = await window.scry.unreadSessions()
      return { runId, done: run.done, pendingCount: run.pendingQuestions.length, unread, viewed }
    })()`)
    assert.equal(result.done, false, 'question attention must arrive before a terminal result')
    assert.equal(result.pendingCount, 1)
    assert.equal(result.unread.unreadSessionKeys.length, 1, 'background question must trigger Dock attention')
    assert.equal(result.viewed.unreadSessionKeys.length, 0, 'viewing the pending session must clear its attention')
    const beforeRepeat = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    assert.ok(beforeRepeat.residual, 'fixture must recreate a native badge after the session is read')
    if (beforeRepeat.residual.success) {
      assert.equal(beforeRepeat.residual.nativeCount, 1)
      assert.equal(beforeRepeat.residual.dockBadge, '1')
    }
    const repeatedView = await evaluate(`(async () => {
      await window.scry.focusRun(${JSON.stringify(result.runId)})
      const snapshot = await window.scry.unreadSessions()
      await window.scry.stop(${JSON.stringify(result.runId)})
      return snapshot
    })()`)
    assert.deepEqual(repeatedView, result.viewed, 'repeated viewing must not manufacture unread changes')
    const badgeLifecycle = JSON.parse(readFileSync(badgeReceipt, 'utf8'))
    const counts = badgeLifecycle.requests.map(request => request.count)
    assert.deepEqual(counts.filter((count, index) => index === 0 || count !== counts[index - 1]), [0, 1, 0])
    assert.equal(badgeLifecycle.requests.length, beforeRepeat.requests.length + 1,
      'repeated viewing of an already-read session must resynchronize Dock')
    const lastRequest = badgeLifecycle.requests.at(-1)
    assert.equal(lastRequest.count, 0)
    if (lastRequest.success) assert.equal(lastRequest.dockBadge, '')
    for (const request of badgeLifecycle.requests) {
      if (request.success) assert.equal(request.nativeCount, request.count)
    }
    console.log(JSON.stringify({ ok: true, badgeLifecycle, questionAttention: result, repeatedView }))
    cdp.close()
    return
  }
  if (devTerminalOnly) {
    const result = await evaluate(`(async () => {
      const outputs = new Map(), exited = new Set()
      const offData = window.scry.onTerminalData(event => {
        outputs.set(event.id, (outputs.get(event.id) || '') + event.data)
        void window.scry.terminalAck(event.id, event.ownershipEpoch, new TextEncoder().encode(event.data).byteLength)
      })
      const offExit = window.scry.onTerminalExit(event => exited.add(event.id))
      const waitForOutput = async (id, marker) => {
        const deadline = Date.now() + 5000
        while (!(outputs.get(id) || '').includes(marker)) {
          if (exited.has(id) || Date.now() > deadline) throw new Error('Shell did not survive selection: ' + id)
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
      const sessions = []
      try {
        await window.scry.setCwd(null)
        const first = await window.scry.terminalStart({ cwd: null, scopeId: 'conversation-a', cols: 80, rows: 24 })
        sessions.push(first)
        await window.scry.terminalReady(first.id, first.ownershipEpoch)
        await window.scry.setCwd(${JSON.stringify(workspace)})
        const second = await window.scry.terminalStart({ cwd: ${JSON.stringify(workspace)}, scopeId: 'conversation-b', cols: 80, rows: 24 })
        sessions.push(second)
        await window.scry.terminalReady(second.id, second.ownershipEpoch)
        // Split the marker in shell syntax so input echo cannot satisfy the assertion.
        await window.scry.terminalWrite(first.id, first.ownershipEpoch, "printf '__ALIVE_%s__:%s\\\\n' A \\\"$PWD\\\"\\r")
        await waitForOutput(first.id, '__ALIVE_A__:' + ${JSON.stringify(canonicalHome)})
        await window.scry.setCwd(null)
        await window.scry.terminalWrite(second.id, second.ownershipEpoch, "printf '__ALIVE_%s__:%s\\\\n' B \\\"$PWD\\\"\\r")
        await waitForOutput(second.id, '__ALIVE_B__:' + ${JSON.stringify(canonicalWorkspace)})
        const active = await window.scry.terminalActive()
        return { alive: sessions.every(session => active.some(item => item.id === session.id && item.pid === session.pid)),
          scopes: active.map(item => item.scopeId), exited: [...exited], retainedCwd: true }
      } finally {
        for (const session of sessions) await window.scry.terminalClose(session.id, session.ownershipEpoch)
        offData(); offExit()
      }
    })()`)
    assert.equal(result.alive, true)
    assert.deepEqual(result.scopes, ['conversation-a', 'conversation-b'])
    assert.deepEqual(result.exited, [])
    console.log(JSON.stringify({ realAppTerminalSurvival: result }))
    cdp.close()
    return
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
    const current = (selector) => document.querySelector('[data-session-surface-current="true"]')?.querySelector(selector)
    const waitFor = async (selector, timeout = 4_000) => {
      const deadline = Date.now() + timeout
      let node = null
      while (!node && Date.now() < deadline) {
        node = selector.startsWith('button') ? document.querySelector(selector) : current(selector)
        if (!node) await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return node
    }
    const openSurface = async (label, selector) => {
      current('button[aria-label="添加 Surface"]')?.click()
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
    const scopedSelection = !current('.terminal-surface') && unboundTerminal?.getBoundingClientRect().width === 0
    document.querySelector('button[title="右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const panel = current('.right-surface-panel')
    const terminal = panel ? await openSurface('终端', '.terminal-surface') : null
    const agents = terminal ? await openSurface('Agents', '.agents-surface') : null
    const activeTab = current('[role="tab"][aria-selected="true"]')
    const terminalPanel = current('.surface-content-terminal')

    current('button[aria-label="最大化右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const maximized = document.querySelector('.app')?.classList.contains('right-panel-maximized') === true
    current('button[aria-label="恢复右侧工作区"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const restored = document.querySelector('.app')?.classList.contains('right-panel-maximized') === false

    current('button[aria-label="隐藏右侧工作区"]')?.click()
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
      scopedSelection,
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
    scopedSelection: true,
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

  const historyReloadSmoke = await evaluate(`(async () => {
    const cwd = ${JSON.stringify(canonicalWorkspace)}
    const externalSessionId = ${JSON.stringify(lifecycleSmoke.externalSessionId)}
    let cleanupDone = () => {}
    let cleanupError = () => {}
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('second-turn history fixture timed out')), 15_000)
      cleanupDone = window.scry.onTurnDone((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        resolve(event)
      })
      cleanupError = window.scry.onError((event) => {
        clearTimeout(timer)
        cleanupDone()
        cleanupError()
        reject(new Error(event.message))
      })
    })
    const started = await window.scry.start({ providerId: 'codex', cwd, expectedSessionId: externalSessionId, prompt: 'latest second-turn history' })
    const ended = await terminal
    const context = { providerId: 'codex', cwd, externalSessionId }
    const first = await window.scry.loadSession(context)
    const reopened = await window.scry.loadSession(context)
    return {
      sameSession: ended.externalSessionId === externalSessionId,
      firstLatest: first?.turns.at(-1)?.runId === started.runId,
      reopenedLatest: reopened?.turns.at(-1)?.runId === started.runId,
      latestPrompt: reopened?.turns.at(-1)?.userText,
      bothTurns: reopened?.turns.length >= 2
    }
  })()`)
  assert.deepEqual(historyReloadSmoke, {
    sameSession: true, firstLatest: true, reopenedLatest: true,
    latestPrompt: 'latest second-turn history', bothTurns: true
  })

  const windowChrome = await evaluate(`(async () => {
    const toggle = document.querySelector('button[title="右侧工作区"]')
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const inspect = (selector) => {
      const scoped = selector.startsWith('.surface') || selector === '.right-surface-panel'
      const node = document.querySelector(scoped ? '[data-session-surface-current="true"] ' + selector : selector)
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
    const surfaceAction = document.querySelector('[data-session-surface-current="true"] .surface-topbar button')
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

    document.querySelector('[data-session-surface-current="true"] button[aria-label="最大化右侧工作区"]')?.click()
    const maximized = await waitFor(() => document.querySelector('.app')?.classList.contains('right-panel-maximized') === true)
    const surfaceLeft = Math.round(document.querySelector('.right-panel-slot')?.getBoundingClientRect().left ?? -1)
    const surfaceActionLeft = Math.round(document.querySelector('[data-session-surface-current="true"] .surface-topbar button')?.getBoundingClientRect().left ?? -1)

    document.querySelector('[data-session-surface-current="true"] button[aria-label="恢复右侧工作区"]')?.click()
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
    if (!trigger) throw new Error('MCP modal trigger is missing')
    trigger.focus()
    const triggerState = {
      disabled: trigger.disabled,
      focused: document.activeElement === trigger,
      width: trigger.getBoundingClientRect().width,
      height: trigger.getBoundingClientRect().height,
      agentMenuOpen: !!document.querySelector('.climenu')
    }
    trigger.click()
    let dialog = null
    let focusedInside = false
    for (let attempt = 0; attempt < 40; attempt++) {
      dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      focusedInside = !!dialog && dialog.contains(document.activeElement)
      if (focusedInside) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!dialog) throw new Error('MCP modal did not open: ' + JSON.stringify({
      triggerState,
      connected: trigger.isConnected,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.outerHTML.slice(0, 300)),
      activeElement: document.activeElement?.outerHTML.slice(0, 300)
    }))
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
    const unboundAlive = (await window.scry.terminalActive()).some(session => session.id === unbound.id)
    await window.scry.terminalWrite(unbound.id, unbound.ownershipEpoch, 'exit' + String.fromCharCode(13))
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
    return { unbound, unboundAlive, unboundExited, oldWriteRejected, bound, activeBeforeAttach, adopted, adoptedReady, staleWriteRejected, replay }
  })()`)
  assert.equal(terminalSmoke.unbound.ok, true, `packaged unbound PTY smoke failed: ${JSON.stringify(terminalSmoke)}\n${stderr.slice(-4000)}`)
  assert.equal(terminalSmoke.unbound.cwd, canonicalHome)
  assert.ok(terminalSmoke.unbound.output.includes(`__SCRY_TERMINAL_HOME_OK__:${canonicalHome}`))
  assert.equal(terminalSmoke.unboundAlive, true, JSON.stringify(terminalSmoke))
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
    const root = () => document.querySelector('[data-session-surface-current="true"]')
    const query = (selector) => selector.startsWith('button.sb-sess') || selector.includes('title="右侧工作区"')
      ? document.querySelector(selector) : root()?.querySelector(selector)
    const queryAll = (selector) => root()?.querySelectorAll(selector) ?? []
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 8_000
      while (!await predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      if (!await predicate()) throw new Error('terminal recording UI condition timed out: ' + JSON.stringify({
        text: query('.terminal-surface')?.textContent?.slice(-1500),
        host: query('.terminal-pane:not([hidden]) .terminal-xterm')?.getBoundingClientRect().toJSON()
      }))
    }
    await waitFor(() => !!query('button.sb-sess'))
    query('button.sb-sess')?.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await waitFor(() => !!query('button[title="右侧工作区"]'))
    const toggle = query('button[title="右侧工作区"]')
    if (toggle?.getAttribute('aria-pressed') !== 'true') toggle?.click()
    await waitFor(() => !!query('.right-surface-panel'))
    let terminalTab = [...queryAll('.surface-tab-activate')].find((node) => node.textContent.includes('终端'))
    if (!terminalTab) {
      query('button[aria-label="添加 Surface"]')?.click()
      await waitFor(() => [...queryAll('[role="menuitem"]')].some((node) => node.textContent?.trim().startsWith('终端')))
      ;[...queryAll('[role="menuitem"]')].find((node) => node.textContent?.trim().startsWith('终端'))?.click()
    } else terminalTab.click()
    const button = (label) => query('button[aria-label="' + label + '"]')
    await waitFor(() => query('.terminal-pane:not([hidden]) .terminal-xterm')?.clientWidth > 0)
    const priorIds = new Set((await window.scry.terminalRecordingList()).items.map((item) => item.id))
    button('重新启动终端').click()
    let startedId = null
    await waitFor(async () => {
      startedId = (await window.scry.terminalRecordingList()).items.find((item) => item.active && !priorIds.has(item.id))?.id
      return !!startedId && !!query('.terminal-state.running')
    })
    const disabledWhileRunning = button('回放终端录制').disabled && button('删除终端录制').disabled
    let offExit = () => {}
    const exit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { offExit(); reject(new Error('UI terminal did not exit')) }, 8_000)
      offExit = window.scry.onTerminalExit((event) => {
        if (event.id === startedId) { clearTimeout(timer); offExit(); resolve(event) }
      })
    })
    const textarea = query('.terminal-pane:not([hidden]) .xterm-helper-textarea')
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
    await waitFor(() => query('.terminal-foot')?.textContent.includes('录制回放完成'))
    // The footer is set only after xterm's write callback confirms parsing. DOM painting is renderer-dependent.
    const rendered = page.data
    query('.terminal-tab.active .terminal-tab-close').click()
    const beforeHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    button('终端录制历史').click()
    await waitFor(() => !!query('[data-recording-id="' + ended.id + '"] button'))
    query('[data-recording-id="' + ended.id + '"] button').click()
    await waitFor(() => query('.terminal-foot')?.textContent.includes('录制回放完成'))
    const readonly = button('重新启动终端').disabled
    const afterHistory = (await window.scry.terminalRecordingList()).items.map((item) => item.id)
    const noSpawn = JSON.stringify(beforeHistory) === JSON.stringify(afterHistory)
    button('删除终端录制').click()
    await waitFor(() => query('.terminal-foot')?.textContent.includes('磁盘录制已删除'))
    let deleted = false
    try { await window.scry.terminalRecordingRead({ id: ended.id, offset: 0 }) } catch { deleted = true }
    query('.terminal-tab.active .terminal-tab-close').click()
    button('新建终端').click()
    await waitFor(() => !!query('.terminal-state.running'))
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
    historyReload: historyReloadSmoke,
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
