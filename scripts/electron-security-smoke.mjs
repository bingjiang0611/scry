import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { freePort, waitForTarget, connectCdp } from './electron-security-cdp.mjs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { exerciseMetaPromptsApp } from './meta-prompts-ui-checks.mjs'
import { exerciseUnified } from './electron-security-unified.mjs'
import { exerciseOwnership } from './electron-security-ownership.mjs'
import { exerciseMeta } from './electron-security-meta.mjs'
import { exerciseSourceControlApp } from './source-control-ui-checks.mjs'
import { exerciseUnifiedConversation, verifyUnifiedConversationRestart } from './unified-conversation-smoke.mjs'
import { seedConversationOwnership, exerciseConversationOwnership, prepareOwnershipRecoveryFailure, exerciseOwnershipRecoveryFailure } from './conversation-ownership-smoke.mjs'
import { exerciseFileHistory } from './electron-security-file-history.mjs'
import { exerciseNativeHistory } from './electron-security-native-history.mjs'
import { exerciseProductionPerformance } from './electron-security-performance.mjs'
import { exerciseFiles } from './electron-security-files.mjs'
import { exerciseQuestion } from './electron-security-question.mjs'
import { exerciseDevTerminal } from './electron-security-dev-terminal.mjs'
import { exerciseSurfaces } from './electron-security-surfaces.mjs'
import { exerciseProviderHistory } from './electron-security-provider-history.mjs'
import { exerciseWindowBoundary } from './electron-security-window-boundary.mjs'
import { exerciseTerminalCore } from './electron-security-terminal-core.mjs'
import { exerciseRecording } from './electron-security-recording.mjs'
import { exerciseRestart } from './electron-security-restart.mjs'


const sourceControlOnly = process.argv[2] === '--dev-source-control-only'
const conversationOwnershipOnly = process.argv[2] === '--dev-conversation-ownership-only'
const unifiedConversationOnly = process.argv[2] === '--dev-unified-conversation-only'
const performanceOnly = ['--dev-performance-only', '--performance-only'].includes(process.argv[2])
const nativeHistoryPerformanceOnly = process.argv[2] === '--dev-pi-history-perf-only'
const nativeHistoryOnly = process.argv[2] === '--dev-pi-history-only' || nativeHistoryPerformanceOnly
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
const devApp = unifiedConversationOnly || conversationOwnershipOnly || sourceControlOnly || devMetaPromptsOnly || nativeHistoryOnly || process.argv[2] === '--dev-file-history-only' || devTerminalOnly || devQuestionOnly || devFilesOnly || process.argv[2] === '--dev' || process.argv[2] === '--dev-performance-only'
const packagedAppArgument = ['--files-only', '--performance-only', '--file-history-only'].includes(process.argv[2]) ? undefined : process.argv[2]
const appPath = resolve(devApp ? 'node_modules/electron/dist/Electron.app' : packagedAppArgument || join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const executable = join(appPath, 'Contents', 'MacOS', devApp ? 'Electron' : 'Scry')
const temp = mkdtempSync(join(tmpdir(), 'scry-electron-smoke-'))
let child
let stderr = ''
let smokeIdentity = 'default'
const conversationInputs = join(temp, 'conversation-inputs.jsonl')
const conversationCalls = join(temp, 'conversation-provider-calls.jsonl')

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
  if (performanceOnly || sourceControlOnly || conversationOwnershipOnly || unifiedConversationOnly) {
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
    const nativePath = join(nativeDir, `2026-10-13_${nativeSessionId}.jsonl`)
    writeFileSync(nativePath, [
      { type: 'session', version: 3, id: nativeSessionId, cwd: canonicalWorkspace },
      entry('u', null, 'user', '手机发起的真实格式消息'),
      entry('old', 'u', 'assistant', 'abandoned branch must not appear')
    ].map((value) => JSON.stringify(value)).join('\n') + '\n')
    // A real >64 MiB JSONL file, not a mocked stat. Abandoned payloads must not
    // block native-only recovery or later archive reconciliation.
    const padding = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 65; i++) {
      appendFileSync(nativePath, JSON.stringify(entry(`old-${i}`, 'u', 'assistant', padding)) + '\n')
    }
    appendFileSync(nativePath, JSON.stringify(entry('a', 'u', 'assistant', '主机重启前已有的原生回复')))
    assert.ok(statSync(nativePath).size > 64 * 1024 * 1024)
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
      sessionId: nativeSessionId, externalSessionId: nativeSessionId, runId: 'remote-run-fixture-1',
      providerId: 'pi', agentProfileId: 'pi:rotom', runtimeProvider: 'pi_rpc', cwd: canonicalWorkspace,
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
  const ownershipFixture = conversationOwnershipOnly ? seedConversationOwnership({
    userData: userDataDir, cwd: canonicalWorkspace, otherCwd: realpathSync(secondWorkspace)
  }) : undefined
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
  const conversationEntry = join(temp, 'conversation-main.mjs')
  if (unifiedConversationOnly) {
    // Fault injection surrounds, rather than replaces, the production trusted handler.
    // Lose one reply after the native effect and durable commit; recovery must not replay it.
    writeFileSync(conversationEntry, `
      import { ipcMain } from 'electron'
      import { existsSync, writeFileSync } from 'node:fs'
      const marker = ${JSON.stringify(join(temp, 'fork-reply-lost'))}
      const handle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, listener) => handle(channel, async (...args) => {
        const result = await listener(...args)
        if (channel === 'conversation:fork' && result.fork?.status === 'accepted' && !existsSync(marker)) {
          writeFileSync(marker, 'native fork committed')
          throw new Error('fixture: native fork reply lost after commit')
        }
        return result
      })
      await import(${JSON.stringify(pathToFileURL(resolve('out/main/index.js')).href)})
    `)
  }
  const launchApp = () => {
    child = spawn(executable, [
      ...(devApp ? [devQuestionOnly ? questionEntry : devFilesOnly ? filesEntry : unifiedConversationOnly ? conversationEntry : resolve('.')] : []),
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
        ...(ownershipFixture ? { SCRY_ELECTRON_SMOKE_CALLS: ownershipFixture.callsFile } : {}),
        ...(unifiedConversationOnly ? { SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1', SCRY_ELECTRON_SMOKE_INPUTS: conversationInputs, SCRY_ELECTRON_SMOKE_CALLS: conversationCalls, SCRY_ELECTRON_SMOKE_IDENTITY: smokeIdentity } : {}),
        // Only explicit smoke adapters may run. Never discover/start real Provider services.
        SCRY_DISABLED_PROVIDERS: unifiedConversationOnly ? 'qoder,opencode' : 'claude,qoder,opencode,pi',
        SCRY_REMOTE_HOST: '0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (chunk) => { stderr += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('exit', (code, signal) => {
      stderr += `\nElectron exited code=${code} signal=${signal}`
    })
    return child
  }
  launchApp()

  const { page, targets: initialTargets } = await waitForTarget(port, () => child)
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
  const context = () => ({ ownershipFixture, smokeIdentity, setSmokeIdentity: (value) => { smokeIdentity = value }, conversationInputs, conversationCalls, sourceFileHistory, evaluate, cdp, workspace, secondWorkspace, canonicalWorkspace, canonicalHome, home, temp, userDataDir, openReceipt, badgeReceipt, nativeHistoryPerformanceOnly, nativeSessionId, performanceOnly, filesOnly, devFilesOnly, devQuestionOnly, foreground, waitForTarget, stopOwnedApp, launchApp, port, child, stderr, initialTargets, page })
  if (ownershipFixture) return exerciseOwnership(context())
  if (sourceControlOnly) {
    const result = await exerciseSourceControlApp(cdp, evaluate, { workspace: canonicalWorkspace, remote: realpathSync(secondWorkspace), home })
    cdp.close()
    console.log(JSON.stringify(result))
    return
  }
  if (unifiedConversationOnly) return exerciseUnified(context())
  if (devMetaPromptsOnly) return exerciseMeta(context())
  const boundary = await evaluate(`(() => ({
    requireType: typeof require,
    preloadType: typeof window.scry,
    preloadKeys: Object.keys(window.scry || {}),
  }))()`)
  assert.equal(boundary.requireType, 'undefined')
  assert.equal(boundary.preloadType, 'object', `packaged preload did not expose window.scry\n${stderr.slice(-4000)}`)
  for (const key of [
    'start', 'stop', 'activeRuns', 'llmPerformanceSummary', 'llmPerformanceHistory', 'usageStats', 'stats', 'listSessions', 'listProjects', 'mcpSnapshot', 'listSkills', 'onFocusedRun', 'onDataUpdated',
    'terminalStart', 'terminalActive', 'terminalAttach', 'terminalWrite', 'terminalResize', 'terminalReady', 'terminalAck', 'terminalClose', 'onTerminalData', 'onTerminalExit'
  ]) assert.ok(boundary.preloadKeys.includes(key), `preload missing ${key}`)
  if (fileHistoryOnly) return exerciseFileHistory(context())
  if (nativeHistoryOnly) return exerciseNativeHistory(context())
  if (performanceOnly) return exerciseProductionPerformance(context())
  const discovered = await evaluate(`Promise.all([window.scry.detectFast(), window.scry.detect(), window.scry.providerDescriptors()]).then((groups) => groups.map((group) => group.map((item) => item.id)))`)
  assert.deepEqual(discovered, [['codex'], ['codex'], ['codex']], 'smoke discovery must use only the fixture adapter')
  const disabledCapabilities = await evaluate(`Promise.all(['claude', 'qoder', 'opencode', 'pi'].map(async (providerId) => {
    const providerContext = { providerId, cwd: ${JSON.stringify(workspace)} }
    const results = await Promise.all([window.scry.runControls(providerContext), window.scry.listSkills(providerContext)])
    return results.every((result) => result.state === 'unsupported' && result.reason.includes('SCRY_DISABLED_PROVIDERS'))
  }))`)
  assert.deepEqual(disabledCapabilities, [true, true, true, true], 'smoke must not start non-fixture providers')
  if (filesOnly) return exerciseFiles(context())
  if (devQuestionOnly) return exerciseQuestion(context())
  if (devTerminalOnly) return exerciseDevTerminal(context())
  const surfaces = await exerciseSurfaces(context())
  const providerHistory = await exerciseProviderHistory(context())
  const windowBoundary = await exerciseWindowBoundary(context())
  const terminalCore = await exerciseTerminalCore(context())
  const recording = await exerciseRecording(context())
  const restart = await exerciseRestart({ ...context(), terminalSmoke: terminalCore.terminalSmoke, cdp, child })
  const { surfaceSmoke } = surfaces
  const { lifecycleSmoke, historyReloadSmoke } = providerHistory
  const { windowChrome, collapsedChrome, transportPicker, modal, subframeIpc } = windowBoundary
  const { terminalSmoke, reloadAdoption, activeAfterReload } = terminalCore
  const { recordingSmoke } = recording
  const { historyRestart } = restart

  cdp.close()
  // Ownership is captured outside Electron before the crash. Confirm the registered tree is
  // gone before restarting, rather than treating only the parent's exit as cleanup success.
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
