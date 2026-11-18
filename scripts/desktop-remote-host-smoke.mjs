import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { stopOwnedApp } from './owned-app-processes.mjs'
import { buildTransportClient, connectCdp, createEvaluate, freePort, launch, waitForTarget } from './desktop-remote-host-smoke/harness.mjs'
import { pairDevice } from './desktop-remote-host-smoke/pairing.mjs'
import { verifyWorkbench } from './desktop-remote-host-smoke/workbench.mjs'
import { verifyRuns } from './desktop-remote-host-smoke/runs.mjs'
import { verifyUnknownReceipt } from './desktop-remote-host-smoke/unknown.mjs'
import { verifyQuestions } from './desktop-remote-host-smoke/questions.mjs'
import { verifyFailureAndRecords } from './desktop-remote-host-smoke/failure.mjs'
import { verifyRevocation } from './desktop-remote-host-smoke/revocation.mjs'

// This is deliberately a host smoke, not a provider smoke. The only Provider
// process it can reach is the packaged Codex fixture selected by the production
// main process when SCRY_ELECTRON_SMOKE_PROVIDER=1.
//
// Each phase lives in ./desktop-remote-host-smoke/ and receives only the state it
// needs; this file owns the isolated app launch, phase order and the report.
const devApp = process.argv[2] === '--dev'
const appPath = resolve(devApp
  ? 'node_modules/electron/dist/Electron.app'
  : join('dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Scry.app'))
const executable = join(appPath, 'Contents', 'MacOS', devApp ? 'Electron' : 'Scry')
const root = resolve('.')
const temp = mkdtempSync(join(tmpdir(), 'scry-desktop-remote-smoke-'))
let child
let cdp
let appLog = ''

function appendLog(chunk) {
  appLog = (appLog + chunk).slice(-16_000)
}

async function main() {
  assert.ok(existsSync(executable), `production Electron executable not found: ${executable}; build/package the app before running this smoke`)
  const transport = await buildTransportClient({ root, temp })
  const cdpPort = await freePort()
  const userDataDir = join(temp, 'userData')
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const canonicalWorkspace = realpathSync(workspace)
  writeFileSync(join(workspace, 'README.md'), '# isolated remote host smoke\n')
  writeFileSync(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'desktop-remote-host-smoke', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'full', diff: true, hooks: true }
  }))
  mkdirSync(join(workspace, '.scry'), { recursive: true })
  writeFileSync(join(workspace, '.gitignore'), '.scry/\n')
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workspace, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe'
  })
  git('init', '-q')
  git('add', 'README.md', 'scry.config.json', '.gitignore')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-qm', 'isolated baseline')
  // The production workspace authorizer intentionally accepts only known projects.
  writeFileSync(join(userDataDir, 'recent-folders.json'), JSON.stringify([canonicalWorkspace]))
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify([{
    sessionId: 'desktop-remote-bootstrap', runId: 'desktop-remote-bootstrap', providerId: 'codex', runtimeProvider: 'codex_cli', cwd: canonicalWorkspace,
    preview: 'desktop remote host smoke', ts: Date.now()
  }]))

  child = launch({ spawn, executable, devApp, root, port: cdpPort, userDataDir, home, appendLog })
  const page = await waitForTarget(cdpPort)
  assert.match(page.url, /^file:/, 'production renderer must load from a file URL')
  cdp = connectCdp(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  const evaluate = createEvaluate(cdp)
  const boundary = await evaluate(`(() => ({ requireType: typeof require, scryType: typeof window.scry, inviteType: typeof window.scry?.remoteDesktopHostInvite }))()`)
  assert.equal(boundary.requireType, 'undefined')
  assert.equal(boundary.scryType, 'object')
  assert.equal(boundary.inviteType, 'function')

  const paired = await pairDevice({ evaluate, transport, temp, userDataDir, workspace, canonicalWorkspace })
  const { invitation, identity, localGrant, deviceCertPEM, info } = paired
  await verifyWorkbench({ transport, invitation, identity, deviceCertPEM, canonicalWorkspace, workspace, git })
  const runs = await verifyRuns({ transport, evaluate, invitation, identity, deviceCertPEM, canonicalWorkspace, info, temp })
  await verifyUnknownReceipt({ transport, evaluate, submit: runs.submit, invitation, identity, deviceCertPEM, canonicalWorkspace })
  const { activeTrace } = await verifyQuestions({ transport, evaluate, submit: runs.submit, sessionAction: runs.sessionAction, invitation, identity, deviceCertPEM, context: runs.context })
  const { records, scryEntries } = await verifyFailureAndRecords({ transport, submit: runs.submit, invitation, identity, deviceCertPEM, normalSession: runs.normalSession, workspace })
  await verifyRevocation({ transport, evaluate, sessionAction: runs.sessionAction, sessionContext: runs.sessionContext, localGrant, invitation, identity, deviceCertPEM, userDataDir, temp })

  console.log(JSON.stringify({
    historyAuthority: { unknownSessionRejected: true, legacyProfileUnavailable: true },
    sessionActions: { hostStoreRename: true, pinUnpin: true, archiveRestore: true, archiveStopsActiveRun: true, unauthorizedWorkspaceDenied: true, revokedOwnerDenied: true, mobileArchivesRemainHidden: true },
    workbench: { realFileWrite: true, staleRevisionDenied: true, createRename: true, realGitStageCommit: true, realPtyCwdAndInput: true, cumulativeAckDuplicateSafe: true, detachedLargeOutputContinues: true, recordingCatchUp: true, staleWriterDenied: true },
    directorySelection: { capability: true, browseDoesNotGrant: true, persistedCanonicalGrant: true, trailingSpaceKept: true, noAgentStart: true, revokedListAndSelectDenied: true },
    appPath, rendererUrl: page.url, hostId: invitation.hostId, pairPort: invitation.pairPort, runPort: invitation.runPort,
    supportedScenarios: ['trusted-local invite/confirm', 'pinned TLS CSR pairing', 'canonical info', 'normal trace/archive', 'duplicate intent', 'unknown receipt intentStatus', 'explicit recovery fences late submissions', 'production recovery IPC validation', 'question cancellation', 'independent same-workspace sessions', 'canonical failed run', 'revocation'],
    fixtureArgs: { provider: 'codex', normalPrompt: 'desktop remote write one', questionPrompt: 'dock badge question smoke', failurePrompt: 'remote provider failure smoke' },
    bounded: { traceItems: activeTrace.desktop.run.items.length, archiveTurns: runs.history.desktop.history.turns.length, canonicalRecords: records.length, scryEntries: scryEntries.length }
  }))
}

let failure
try {
  await main()
} catch (error) {
  failure = error
  console.error(`[scry] desktop remote host smoke failure: ${error instanceof Error ? error.stack : String(error)}\n${appLog.slice(-8_000)}`)
} finally {
  if (cdp) cdp.close()
  try {
    if (child && child.exitCode === null && child.signalCode === null) await stopOwnedApp(child)
  } finally {
    if (failure || (child && child.exitCode === null && child.signalCode === null)) {
      writeFileSync(join(temp, 'failure.log'), `${failure?.stack ?? failure ?? 'child exit unproven'}\n${appLog}`, { mode: 0o600 })
      console.error(`Retained isolated evidence: ${temp}`)
    } else rmSync(temp, { recursive: true, force: true })
  }
}
if (failure) process.exitCode = 1
