import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { freePort, waitForTarget, connectCdp, rendererEvaluator } from './electron-security-cdp.mjs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { stopOwnedDaemonApp } from './owned-daemon-app.mjs'
import { exerciseUnified } from './electron-security-unified.mjs'
import { exerciseTerminalSteer } from './terminal-steer-queue-smoke.mjs'
import { exerciseOwnership } from './electron-security-ownership.mjs'
import { exerciseMeta } from './electron-security-meta.mjs'
import { exerciseSourceControlApp } from './source-control-ui-checks.mjs'
import { exerciseWorkspaceSessions } from './workspace-session-ui-checks.mjs'
import { seedConversationOwnership } from './conversation-ownership-smoke.mjs'
import { exerciseFileHistory, seedFileHistorySource } from './electron-security-file-history.mjs'
import { exerciseNativeHistory } from './electron-security-native-history.mjs'
import { nativeHistoryCatalog } from './electron-security-activity-history.mjs'
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
import { exerciseStructureApp } from './structure-app-checks.mjs'
import { prepareSideChatMode } from './side-chat-smoke.mjs'
import { lostReplyPath, writeConversationFaultEntry, writeDockBadgeEntry, writeFileOpenEntry, writeIpcCountEntry } from './smoke-app-entries.mjs'

import { defaultPackagedAppPath, electronDevLayout, packagedAppLayout } from './packaged-app-layout.mjs'
import { assertArtifactMatchesSource } from './packaged-artifact-guard.mjs'
import { preparePackagedSmokeEntry } from './packaged-smoke-entry.mjs'
import { electronSecurityModes, electronSecurityTestEnvironment } from './electron-security-modes.mjs'

const {
  steerOnly, structureOnly, sideChatOnly, largeHistoryOnly, sourceControlOnly, conversationOwnershipOnly, unifiedConversationOnly, performanceOnly, nativeHistoryPerformanceOnly, nativeHistoryOnly, fileHistoryOnly, sourceFileHistory: replaySource, devMetaPromptsOnly, devTerminalOnly, devQuestionOnly, foreground, devFilesOnly, filesOnly, devApp, instrumentedPackage, packagedAppArgument
} = electronSecurityModes(process.argv)
const dev = devApp ? electronDevLayout() : null
const appPath = resolve(dev?.appPath || packagedAppArgument || defaultPackagedAppPath())
if (!dev) assertArtifactMatchesSource(appPath)
let executable = dev ? resolve(dev.executable) : packagedAppLayout(appPath).executable
// Keep unix socket paths under macOS's 104-byte sun_path limit in default daemon mode.
const temp = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'scry-es-')))
let child
let stderr = ''
let smokeIdentity = 'default'
const conversationInputs = join(temp, 'conversation-inputs.jsonl')
const conversationCalls = join(temp, 'conversation-provider-calls.jsonl')

async function main() {
  const port = await freePort()
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspaceName = process.argv.includes('--unicode-workspace') ? '中文工作区' : 'workspace'
  const workspace = filesOnly ? join(home, 'projects', 'dev-agent') : join(temp, workspaceName)
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalHome = realpathSync(home)
  const sourceFileHistory = replaySource ?? (fileHistoryOnly ? seedFileHistorySource(canonicalHome) : null)
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
    // A phone-created catalog row after restart: no Scry archive, real JSONL survives.
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
    // A real >64 MiB JSONL, not a mocked stat: abandoned payloads must not block recovery.
    const padding = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 65; i++) {
      appendFileSync(nativePath, JSON.stringify(entry(`old-${i}`, 'u', 'assistant', padding)) + '\n')
    }
    appendFileSync(nativePath, JSON.stringify(entry('a', 'u', 'assistant', '主机重启前已有的原生回复')))
    assert.ok(statSync(nativePath).size > 64 * 1024 * 1024)
    writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify(
      nativeHistoryCatalog({ nativeSessionId, canonicalWorkspace, home, nativeHistoryPerformanceOnly })
    ))
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
  const ownershipFixture = conversationOwnershipOnly ? await seedConversationOwnership({
    userData: userDataDir, cwd: canonicalWorkspace, otherCwd: realpathSync(secondWorkspace), executable
  }) : undefined
  const openReceipt = join(temp, 'opened-paths.json')
  const filesEntry = join(temp, 'files-app', 'files-main.mjs')
  if (devFilesOnly) writeFileOpenEntry(filesEntry, openReceipt)
  const badgeReceipt = join(temp, 'dock-badge.json')
  const focusRequest = join(temp, 'dock-focus.request')
  const questionEntry = join(temp, 'question-app', 'question-main.mjs')
  if (devQuestionOnly) writeDockBadgeEntry(questionEntry, badgeReceipt, focusRequest)
  // Every temp entry has its own app directory: the daemon supervisor refuses an App that
  // announces Electron's version instead of the build's (smoke-app-entries.mjs).
  const conversationEntry = join(temp, 'conversation-app', 'conversation-main.mjs')
  const fixtureAppPath = instrumentedPackage ? join(temp, 'Scry.app') : null
  const fixtureEntryRoot = fixtureAppPath ? join(packagedAppLayout(fixtureAppPath).resources, 'app.asar') : undefined
  if (unifiedConversationOnly) writeConversationFaultEntry(conversationEntry, join(temp, 'fork-reply-lost'), fixtureEntryRoot)
  const structureEntry = join(temp, 'structure-app', 'structure-main.mjs')
  const structureIpc = join(temp, 'structure-ipc-counts.json')
  if (structureOnly) writeIpcCountEntry(structureEntry, structureIpc, undefined, undefined, fixtureEntryRoot)
  const sideChatMode = (sideChatOnly || largeHistoryOnly) && await prepareSideChatMode({ temp, entryPath: structureEntry, appPath: fixtureEntryRoot,
    workspace: canonicalWorkspace, userDataDir, inputsPath: conversationInputs, callsPath: conversationCalls,
    identity: smokeIdentity, largeHistory: largeHistoryOnly })
  if (fixtureAppPath) {
    executable = await preparePackagedSmokeEntry(appPath, fixtureAppPath,
      unifiedConversationOnly ? conversationEntry : structureEntry, temp)
  }
  // Every sub-mode runs the App with its daemon (S3). The fixture inputs below
  // (SCRY_ELECTRON_SMOKE_{CONVERSATIONS,SIDE_CHAT,INPUTS,CALLS,IDENTITY,READER,READS}) reach the
  // daemon's smoke Provider because this is a test instance that asked for it
  // (src/daemon/supervisor.ts smokeFixtureEnvironment).
  const launchApp = () => {
    child = spawn(executable, [
      ...(devApp ? [devQuestionOnly ? dirname(questionEntry) : devFilesOnly ? dirname(filesEntry) : unifiedConversationOnly ? dirname(conversationEntry) : (structureOnly || sideChatOnly || largeHistoryOnly) ? dirname(structureEntry) : resolve('.')] : []),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      // Both suites measure native modal exit with the production compositor.
      ...(structureOnly || performanceOnly ? [] : ['--disable-gpu']),
      // An occluded fixture keeps bounded UI waits immune to Chromium background throttling.
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--no-first-run'
    ], {
      env: {
        ...process.env,
        ...electronSecurityTestEnvironment(temp),
        SHELL: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
        ZDOTDIR: home,
        ELECTRON_ENABLE_LOGGING: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '0',
        SCRY_ELECTRON_SMOKE_PROVIDER: '1',
        SCRY_DAEMON_SMOKE_PROVIDER: '1', SCRY_DAEMON_CREDENTIAL_PLAINTEXT: '1',
        ...(steerOnly ? { SCRY_ELECTRON_SMOKE_INPUTS: conversationInputs } : {}),
        ...(ownershipFixture ? { SCRY_ELECTRON_SMOKE_CALLS: ownershipFixture.callsFile } : {}),
        ...(unifiedConversationOnly ? { SCRY_ELECTRON_SMOKE_CONVERSATIONS: '1', SCRY_ELECTRON_SMOKE_INPUTS: conversationInputs, SCRY_ELECTRON_SMOKE_CALLS: conversationCalls, SCRY_ELECTRON_SMOKE_IDENTITY: smokeIdentity } : {}),
        ...(sideChatMode ? sideChatMode.env : {}),
        // Only explicit smoke adapters may run. Never discover/start real Provider services.
        SCRY_DISABLED_PROVIDERS: unifiedConversationOnly ? 'qoder,opencode' : (sideChatOnly || largeHistoryOnly) ? '' : 'claude,qoder,opencode,pi',
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
  const evaluate = rendererEvaluator(cdp)
  const check = (condition, label) => { if (!condition) throw new Error(`Side-chat App: ${label}`) }
  const context = () => ({ ownershipFixture, smokeIdentity, setSmokeIdentity: (value) => { smokeIdentity = value }, conversationInputs, conversationCalls, sourceFileHistory, evaluate, cdp, workspace, secondWorkspace, canonicalWorkspace, canonicalHome, home, temp, userDataDir, openReceipt, badgeReceipt, nativeHistoryPerformanceOnly, nativeSessionId, performanceOnly, filesOnly, devFilesOnly, devQuestionOnly, foreground, waitForTarget, stopOwnedApp, launchApp, port, child, stderr, initialTargets, page })
  if (structureOnly) {
    const result = await exerciseStructureApp(cdp, evaluate, { ipcCountsPath: structureIpc, lostReplyPath: lostReplyPath(structureIpc) })
    cdp.close()
    console.log(JSON.stringify(result))
    return
  }
  if (sideChatOnly || largeHistoryOnly) return sideChatMode.run({ cdp, evaluate, check, lifecycle: { port, launch: launchApp, child: () => child, stop: stopOwnedApp, waitTarget: waitForTarget, connect: connectCdp } })
  if (ownershipFixture) return exerciseOwnership(context())
  if (sourceControlOnly) {
    const result = await exerciseSourceControlApp(cdp, evaluate, { workspace: canonicalWorkspace, remote: realpathSync(secondWorkspace), home })
    cdp.close()
    console.log(JSON.stringify(result))
    return
  }
  if (unifiedConversationOnly) return process.argv.includes('--workspace-start') ? exerciseWorkspaceSessions(context()) : exerciseUnified(context())
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
  if (nativeHistoryOnly) {
    if (workspaceName !== 'workspace') {
      assert.match(canonicalWorkspace, /中文工作区$/)
      const ref = { providerId: 'pi', agentProfileId: 'pi:rotom', cwd: canonicalWorkspace, externalSessionId: nativeSessionId }
      const first = await evaluate(`window.scry.loadSession(${JSON.stringify(ref)})`)
      assert.ok(first, 'the imported history page must be visible')
      assert.equal(first.projection?.legacyBefore, true, 'the production App must open the imported session projection')
      assert.equal(typeof first.projection.sessionKey, 'string')
      assert.ok(first.turns.some(turn => turn.userText === '手机发起的真实格式消息'))
      console.log(JSON.stringify({ test: 'Unicode workspace projection', cwd: canonicalWorkspace, legacyBefore: true }))
    }
    return exerciseNativeHistory(context())
  }
  if (performanceOnly) return exerciseProductionPerformance(context())
  if (steerOnly) return exerciseTerminalSteer(context())
  const discovered = await evaluate(`Promise.all([window.scry.detectFast(), window.scry.detect(), window.scry.providerDescriptors()]).then((groups) => groups.map((group) => group.map((item) => item.id)))`)
  assert.deepEqual(discovered, [['codex'], ['codex'], ['codex']], 'smoke discovery must use only the fixture adapter')
  const disabledCapabilities = await evaluate(`Promise.all(['claude', 'qoder', 'opencode', 'pi'].map(async (providerId) => {
    const providerContext = { providerId, cwd: ${JSON.stringify(workspace)} }
    const results = await Promise.all([window.scry.runControls(providerContext), window.scry.listSkills(providerContext)])
    return results.every((result) => result.state === 'unsupported' && result.reason.includes('SCRY_DISABLED_PROVIDERS'))
  }))`)
  assert.deepEqual(disabledCapabilities, [true, true, true, true], 'smoke must not start non-fixture providers')
  if (filesOnly) return exerciseFiles(context())
  if (devQuestionOnly) return exerciseQuestion({ ...context(), focusRequest })
  if (devTerminalOnly) return exerciseDevTerminal(context())
  const surfaces = await exerciseSurfaces(context())
  const providerHistory = await exerciseProviderHistory(context())
  const windowBoundary = await exerciseWindowBoundary(context())
  const terminalCore = await exerciseTerminalCore(context())
  const recording = await exerciseRecording(context())
  const restart = await exerciseRestart({ ...context(), terminalSmoke: terminalCore.terminalSmoke, cdp, child })
  const { surfaceSmoke } = surfaces
  const { lifecycleSmoke, historyReloadSmoke } = providerHistory
  const { windowChrome, collapsedChrome, transportPicker, modal, subframeIpc, chrome } = windowBoundary
  const { terminalSmoke, reloadAdoption, activeAfterReload } = terminalCore
  const { recordingSmoke } = recording
  const { historyRestart } = restart

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
    chrome,
    modal,
    subframeIpc,
    popupDenied: true,
    navigationDenied: true
  }))
}

let failed = false
try {
  await main()
} catch (error) {
  failed = true
  // Keep the primary assertion and App logs visible even if cleanup independently fails.
  console.error('[scry] smoke failure:', error, stderr.slice(-8000))
  throw error
} finally {
  try { await stopOwnedDaemonApp(child, join(temp, 'userData')) } catch (error) {
    failed = true
    process.exitCode = 1
    console.error('[scry] smoke cleanup failed:', error)
  }
  if (failed) console.warn(`[scry] smoke fixture kept for diagnosis: ${temp}`)
  else try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn(`[scry] smoke temp cleanup failed: ${error.message}`)
  }
}
