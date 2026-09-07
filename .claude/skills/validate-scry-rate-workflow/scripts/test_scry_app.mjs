#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { cdpEndpointOpen, claimRendererOwnership, inspectCdpEndpoint, waitForRendererOwnership } from './cdp_ownership.mjs'
import { stopOwnedProcess, withStopStateLock } from './owned_process_stop.mjs'

const START_TIMEOUT_MS = 30_000
const RUN_PREFIX = 'validate-scry-rate-workflow-'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const CONTRACT = JSON.parse(readFileSync(join(SCRIPT_DIR, '..', 'references', 'contract.json'), 'utf8'))
const RUN_ROOT_PARENT = resolve(CONTRACT.retention.runRootParent)
const RUNTIME_RELATIVE = CONTRACT.recoveryPolicy.runtimeSnapshot.relativePath
const STATE_VERSION = CONTRACT.recoveryPolicy.runtimeSnapshot.stateVersion
const CANONICAL_SCRY_REPO = resolve(process.env.SCRY_VALIDATION_SCRY_REPO ?? resolve(SCRIPT_DIR, '../../../..'))
const PI_AGENT_NODE = '/Users/baobingjiang/.nvm/versions/node/v24.18.0/bin/node'
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function parseOptions(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid option near ${key ?? '<end>'}`)
    }
    result.set(key.slice(2), value)
  }
  return result
}

function requireOption(options, name) {
  const value = options.get(name)
  if (!value) throw new Error(`missing --${name}`)
  return value
}

function safeRunRoot(raw) {
  const path = realpathSync(resolve(raw))
  if (basename(path).startsWith(RUN_PREFIX) === false) {
    throw new Error(`run root basename must start with ${RUN_PREFIX}`)
  }
  const parent = realpathSync(dirname(path))
  if (parent !== realpathSync(RUN_ROOT_PARENT)) {
    throw new Error(`run root must be a direct child of ${RUN_ROOT_PARENT}`)
  }
  return path
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

function providerLaunchIdentity(provider, contract = CONTRACT) {
  const providerConfig = contract.providers?.[provider]
  const fixed = contract.fixedTreehouse
  const slot = providerConfig?.treehouseSlot
  if (!providerConfig || !fixed || !Number.isInteger(slot) || slot <= 0) {
    throw new Error(`unsupported Provider launch identity: ${provider}`)
  }
  const matchingProviders = Object.entries(contract.providers ?? {})
    .filter(([, value]) => value?.treehouseSlot === slot)
    .map(([name]) => name)
  const rawPoolRoot = fixed.poolRoot
  const workspaceName = fixed.workspaceName
  if (
    matchingProviders.length !== 1
    || matchingProviders[0] !== provider
    || typeof rawPoolRoot !== 'string'
    || !isAbsolute(rawPoolRoot)
    || typeof workspaceName !== 'string'
    || !workspaceName
    || workspaceName === '.'
    || workspaceName === '..'
    || workspaceName.includes('/')
  ) {
    throw new Error('fixed treehouse launch contract is invalid')
  }
  const poolRoot = resolve(rawPoolRoot)
  return {
    provider,
    slot,
    workspace: join(poolRoot, String(slot), workspaceName),
    slotLockPath: join(poolRoot, '.validate-scry-rate-workflow', 'locks', `slot-${slot}-${provider}.json`),
  }
}

function validHeartbeat(value) {
  return typeof value === 'string'
    && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
}

function validateStartIdentity({
  provider,
  runRoot,
  scryRepo,
  canonicalScryRepo,
  workspace,
  expectedWorkspace,
  slotLockPath,
  expectedSlotLockPath,
  slotLock,
}) {
  const expectedOwner = {
    schemaVersion: 2,
    scope: `slot:${provider}`,
    provider,
    runRoot,
  }
  const actualOwner = Object.fromEntries(Object.keys(expectedOwner).map((key) => [key, slotLock?.[key]]))
  const ownerValid = Boolean(
    slotLock
    && actualOwner.schemaVersion === expectedOwner.schemaVersion
    && actualOwner.scope === expectedOwner.scope
    && actualOwner.provider === expectedOwner.provider
    && actualOwner.runRoot === expectedOwner.runRoot
    && typeof slotLock.ownerId === 'string'
    && slotLock.ownerId.length > 0
    && slotLock.ownerState === 'ACTIVE'
    && slotLock.ownerStage === 'BOOTSTRAP_READY'
    && validHeartbeat(slotLock.heartbeatAt)
  )
  if (scryRepo !== canonicalScryRepo) {
    throw new Error(`Scry repo identity mismatch: expected ${canonicalScryRepo}, got ${scryRepo}`)
  }
  if (workspace !== expectedWorkspace) {
    throw new Error(`fixed workspace identity mismatch: expected ${expectedWorkspace}, got ${workspace}`)
  }
  if (slotLockPath !== expectedSlotLockPath) {
    throw new Error(`Provider slot identity mismatch: expected ${expectedSlotLockPath}, got ${slotLockPath}`)
  }
  if (!ownerValid) {
    throw new Error(`Provider slot owner identity is not active: ${JSON.stringify({ expected: expectedOwner, actual: actualOwner })}`)
  }
  return { provider, runRoot, scryRepo, workspace, slotLockPath, ownerId: slotLock.ownerId, ownerStage: slotLock.ownerStage }
}

function readValidatedStartIdentity(provider, runRoot, scryRepo, workspace) {
  const expected = providerLaunchIdentity(provider)
  const canonicalScryRepo = realpathSync(CANONICAL_SCRY_REPO)
  const expectedWorkspace = realpathSync(expected.workspace)
  const expectedSlotLockPath = resolve(expected.slotLockPath)
  const stat = lstatSync(expectedSlotLockPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Provider slot lock must be a regular file: ${expectedSlotLockPath}`)
  }
  const slotLock = readJson(expectedSlotLockPath)
  return validateStartIdentity({
    provider,
    runRoot,
    scryRepo,
    canonicalScryRepo,
    workspace,
    expectedWorkspace,
    slotLockPath: expectedSlotLockPath,
    expectedSlotLockPath,
    slotLock,
  })
}

function validateStartAuthorization(options, runRoot, provider) {
  const gateFd = Number(requireOption(options, 'lifecycle-gate-fd'))
  const gatePath = resolve(String(CONTRACT.fixedTreehouse.poolRoot), '.validate-scry-rate-workflow', 'lifecycle.lock')
  if (!Number.isInteger(gateFd) || gateFd < 3) throw new Error('invalid inherited lifecycle gate fd')
  const inheritedGate = fstatSync(gateFd)
  const expectedGate = statSync(gatePath)
  if (inheritedGate.dev !== expectedGate.dev || inheritedGate.ino !== expectedGate.ino) {
    throw new Error('inherited lifecycle gate fd does not match the contract lock file')
  }
  const expectedPath = join(runRoot, 'test-app-start-authorization.json')
  const authorizationPath = resolve(requireOption(options, 'authorization'))
  if (authorizationPath !== expectedPath) {
    throw new Error(`start authorization must be the exact run-local path: ${expectedPath}`)
  }
  const stat = lstatSync(authorizationPath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`start authorization must be a regular file: ${authorizationPath}`)
  }
  const authorization = readJson(authorizationPath)
  const token = process.env.SCRY_TEST_START_TOKEN
  if (!(
    authorization?.schemaVersion === 1
    && authorization.provider === provider
    && authorization.runRoot === runRoot
    && typeof authorization.token === 'string'
    && authorization.token.length >= 32
    && authorization.token === token
    && authorization.wrapperPid === process.ppid
    && typeof authorization.wrapperCommandSha256 === 'string'
    && authorization.wrapperCommandSha256.startsWith('sha256:')
  )) {
    throw new Error('start authorization does not prove the lifecycle-gate wrapper identity')
  }
  unlinkSync(authorizationPath)
  delete process.env.SCRY_TEST_START_TOKEN
  return { path: authorizationPath, wrapperPid: authorization.wrapperPid, consumed: true, gatePath }
}

function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  const result = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : ''
  if (result.status === 0) return stdout
  if (result.status === 1 && stdout.length === 0) return ''
  const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : ''
  const detail = result.error?.message || stderr || `exit ${result.status ?? 'unknown'}`
  throw new Error(`inspect PID ${pid}: ${detail}`)
}

function alive(pid) {
  return processCommand(pid).length > 0
}

async function findFreePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolvePort(port))
    })
  })
}

async function waitForDevToolsIdentity(userDataDir, expectedPort, pid, timeoutMs = START_TIMEOUT_MS) {
  const path = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) throw new Error('Scry Test exited before writing DevToolsActivePort')
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/)
      if (lines.length < 2) {
        await wait(250)
        continue
      }
      const port = Number(lines[0])
      const browserPath = lines[1]
      if (port !== expectedPort) throw new Error(`DevToolsActivePort port mismatch: expected ${expectedPort}, got ${lines[0] ?? '<missing>'}`)
      if (!/^\/devtools\/browser\/[0-9a-f-]+$/i.test(browserPath ?? '')) {
        throw new Error(`DevToolsActivePort browser path is invalid: ${browserPath ?? '<missing>'}`)
      }
      return { path, port, browserPath }
    }
    await wait(250)
  }
  throw new Error(`Scry Test did not write DevToolsActivePort within ${timeoutMs}ms`)
}

function commandMatches(state, command) {
  const appRoot = state.runtimeRoot ?? state.scryRepo
  return Boolean(
    command
    && appRoot
    && command.includes(appRoot)
    && (!state.appPath || command.includes(state.appPath))
    && command.includes(`--user-data-dir=${state.userDataDir}`)
    && command.includes(`--remote-debugging-port=${state.port}`)
    && command.includes('--remote-allow-origins=*')
    && (state.version < 2 || command.includes(`--scry-e2e-owned-launch-id=${state.launchId}`))
  )
}

function treeFingerprint(root) {
  const digest = createHash('sha256')
  let files = 0
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(path)
      if (stat.isDirectory()) {
        visit(path, relative)
        continue
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue
      digest.update(relative)
      digest.update('\0')
      digest.update(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path))
      digest.update('\0')
      files += 1
    }
  }
  visit(root)
  return { files, sha256: `sha256:${digest.digest('hex')}` }
}

function resolveBuildOut(scryRepo, runRoot, rawBuildOut) {
  const canonical = join(realpathSync(scryRepo), 'out')
  const isolated = join(realpathSync(runRoot), 'scry-build-out')
  const requested = resolve(rawBuildOut ?? canonical)
  if (lstatSync(requested).isSymbolicLink()) throw new Error(`refusing symlinked build output: ${requested}`)
  const actual = realpathSync(requested)
  if (actual !== canonical && actual !== isolated) {
    throw new Error(`build output must be canonical Scry out or this run's exact isolated child: ${actual}`)
  }
  return actual
}

function createRuntimeSnapshot(scryRepo, runRoot, sourceOut) {
  const packageJson = join(scryRepo, 'package.json')
  const nodeModules = join(scryRepo, 'node_modules')
  for (const required of [sourceOut, packageJson, nodeModules]) {
    if (!existsSync(required)) throw new Error(`Scry runtime input missing: ${required}`)
  }
  const runtimeRoot = join(runRoot, RUNTIME_RELATIVE)
  if (existsSync(runtimeRoot)) throw new Error(`run root already contains a Scry runtime snapshot: ${runtimeRoot}`)
  mkdirSync(runtimeRoot, { mode: 0o700 })
  const sourceFingerprint = treeFingerprint(sourceOut)
  cpSync(sourceOut, join(runtimeRoot, 'out'), { recursive: true, errorOnExist: true })
  cpSync(packageJson, join(runtimeRoot, 'package.json'), { errorOnExist: true })
  const fixtures = join(scryRepo, 'fixtures')
  if (existsSync(fixtures)) cpSync(fixtures, join(runtimeRoot, 'fixtures'), { recursive: true, errorOnExist: true })
  symlinkSync(nodeModules, join(runtimeRoot, 'node_modules'), 'dir')
  const snapshotFingerprint = treeFingerprint(join(runtimeRoot, 'out'))
  const sourceFingerprintAfterCopy = treeFingerprint(sourceOut)
  if (
    sourceFingerprint.files !== snapshotFingerprint.files
    || sourceFingerprint.sha256 !== snapshotFingerprint.sha256
    || sourceFingerprint.files !== sourceFingerprintAfterCopy.files
    || sourceFingerprint.sha256 !== sourceFingerprintAfterCopy.sha256
  ) {
    throw new Error(`Scry runtime snapshot does not match one stable source out: ${JSON.stringify({ sourceFingerprint, sourceFingerprintAfterCopy, snapshotFingerprint })}`)
  }
  return {
    runtimeRoot: realpathSync(runtimeRoot),
    sourceOut: realpathSync(sourceOut),
    sourceFingerprint,
    sourceFingerprintAfterCopy,
    snapshotFingerprint,
  }
}

function recoverPrelaunchResidue(runRoot, includeInvalidState = false) {
  const relatives = [RUNTIME_RELATIVE, 'scry-test-user-data', 'Scry Test.app', 'scry-test.log']
  if (includeInvalidState) relatives.push('test-scry-state.json')
  for (const name of readdirSync(runRoot)) {
    if (/^test-scry-state\.json\.(?:tmp-\d+|stop\.lock)$/.test(name)) relatives.push(name)
  }
  const existing = []
  for (const relative of relatives) {
    const path = join(runRoot, relative)
    try {
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`refusing to recover symlinked prelaunch residue: ${path}`)
      existing.push({ relative, path })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (!existing.length) return []

  const processes = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (processes.status !== 0) throw new Error('cannot prove prelaunch residue has no live Scry Test process')
  const live = processes.stdout.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/)
    if (!match || Number(match[1]) === process.pid) return []
    const command = match[2]
    return command.includes(runRoot)
      && (command.includes('--user-data-dir=') || command.includes('/Scry Test.app/Contents/MacOS/Electron'))
      ? [Number(match[1])]
      : []
  })
  if (live.length) throw new Error(`prelaunch residue may still be owned by live process IDs: ${JSON.stringify(live)}`)

  const quarantine = join(runRoot, 'test-app-recovery', `prelaunch-${Date.now()}`)
  mkdirSync(quarantine, { recursive: true, mode: 0o700 })
  const moved = existing.map(({ relative, path }) => {
    const destination = join(quarantine, relative)
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
    renameSync(path, destination)
    return { source: path, destination }
  })
  writeFileSync(join(quarantine, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    recoveredAt: new Date().toISOString(),
    moved,
  }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return moved
}

function isolatedElectron(scryRepo) {
  const cli = join(scryRepo, 'node_modules', '.bin', 'electron')
  if (process.platform !== 'darwin') return { executable: cli, appPath: null, bundleIdentifier: null }

  // macOS 27 SIGKILLs copied Electron app bundles, including unmodified and
  // ad-hoc signed copies. Isolation already comes from the run-local runtime,
  // userData, CDP port and launch marker, so execute the installed app in place.
  const appPath = realpathSync(join(scryRepo, 'node_modules', 'electron', 'dist', 'Electron.app'))
  const executable = join(appPath, 'Contents', 'MacOS', 'Electron')
  if (!existsSync(executable)) throw new Error(`Electron executable not found: ${executable}`)
  return { executable, appPath, bundleIdentifier: null }
}

function errorRecord(error) {
  return {
    name: error?.name ?? 'Error',
    code: error?.code ?? null,
    phase: error?.phase ?? null,
    message: error instanceof Error ? error.message : String(error),
  }
}

async function liveOwnership(state) {
  return await waitForRendererOwnership({
    port: state.port,
    expectedUrl: state.expectedRendererUrl,
    expectedBrowserPath: state.expectedBrowserPath,
    launchId: state.launchId,
    expectedTargetId: state.rendererOwnership?.actual?.targetId,
    timeoutMs: 2_000,
  })
}

function stopControlFrom(state) {
  const value = state.stopControl
  if (value?.schemaVersion === 1 && Number.isInteger(value.signalsReserved) && Array.isArray(value.attempts)) {
    return {
      schemaVersion: 1,
      maxSignals: 2,
      signalsReserved: value.signalsReserved,
      attempts: [...value.attempts],
    }
  }
  return { schemaVersion: 1, maxSignals: 2, signalsReserved: 0, attempts: [] }
}

function retryDelayFor(control) {
  if (control.signalsReserved !== 1) return 8_000
  const firstReservation = control.attempts
    .flatMap((attempt) => Array.isArray(attempt.reservations) ? attempt.reservations : [])
    .find((reservation) => reservation.sequence === 1)
  const reservedAt = Date.parse(firstReservation?.reservedAt ?? '')
  if (!Number.isFinite(reservedAt)) return 8_000
  return Math.max(0, 8_000 - (Date.now() - reservedAt))
}

function finalStopObservation(observation) {
  return {
    processAlive: observation?.processAlive ?? null,
    commandMatches: observation?.commandMatches ?? null,
    cdpOpen: observation?.cdpOpen ?? null,
  }
}

async function terminateOwnedStateUnlocked(state, statePath) {
  if (state.status === 'stopped' || state.status === 'stale') return state
  if (!['starting', 'running', 'failed', 'stopping'].includes(state.status)) {
    throw new Error(`owned Scry Test has invalid state: ${state.status}`)
  }

  let control = stopControlFrom(state)
  const attemptId = randomUUID()
  let attempt = {
    id: attemptId,
    startedWithStatus: state.status,
    startedWithSignalsReserved: control.signalsReserved,
    startedAt: new Date().toISOString(),
    retrySignalAfterMs: 8_000,
    timeoutMs: 35_000,
    reservations: [],
  }
  control = { ...control, attempts: [...control.attempts, attempt] }
  let stopping = {
    ...state,
    status: 'stopping',
    stopControl: control,
    stopAttempt: attempt,
  }
  writeJsonAtomic(statePath, stopping)

  const persistAttempt = (nextAttempt, nextControl = control) => {
    attempt = nextAttempt
    control = {
      ...nextControl,
      attempts: nextControl.attempts.map((item) => item.id === attemptId ? attempt : item),
    }
    stopping = { ...stopping, stopControl: control, stopAttempt: attempt }
    writeJsonAtomic(statePath, stopping)
  }

  try {
    const result = await stopOwnedProcess(stopping, {
      processCommand,
      commandMatches,
      cdpOpen: cdpEndpointOpen,
      sendSignal: (pid, signal) => process.kill(pid, signal),
      now: Date.now,
      sleep: wait,
      beforeSignal: async (reservation) => {
        const persisted = { ...reservation, reservedAt: new Date().toISOString(), sentAt: null, errorCode: null }
        const nextControl = { ...control, signalsReserved: reservation.sequence }
        persistAttempt({ ...attempt, reservations: [...attempt.reservations, persisted] }, nextControl)
      },
      afterSignal: async (record) => {
        persistAttempt({
          ...attempt,
          reservations: attempt.reservations.map((reservation) => reservation.sequence === record.sequence
            ? { ...reservation, sentAt: record.sent ? new Date().toISOString() : null, errorCode: record.errorCode }
            : reservation),
        })
      },
    }, {
      signalsReserved: control.signalsReserved,
      retryDelayMs: retryDelayFor(control),
    })
    const completedAt = new Date().toISOString()
    const completedAttempt = {
      ...attempt,
      completedAt,
      outcome: result.outcome,
      finalObservation: finalStopObservation(result.observation),
    }
    control = {
      ...control,
      signalsReserved: result.signalsReserved,
      attempts: control.attempts.map((item) => item.id === attemptId ? completedAttempt : item),
    }
    const terminal = {
      ...stopping,
      status: result.outcome,
      ownedRendererReady: false,
      windowTitleLabeled: false,
      stopControl: control,
      stopAttempt: completedAttempt,
      stoppedAt: result.outcome === 'stopped' ? completedAt : state.stoppedAt ?? null,
      staleAt: result.outcome === 'stale' ? completedAt : state.staleAt ?? null,
    }
    writeJsonAtomic(statePath, terminal)
    return terminal
  } catch (error) {
    const failedAttempt = {
      ...attempt,
      failedAt: new Date().toISOString(),
      error: errorRecord(error),
      evidence: error?.evidence ?? null,
      finalObservation: finalStopObservation(error?.evidence),
    }
    control = {
      ...control,
      attempts: control.attempts.map((item) => item.id === attemptId ? failedAttempt : item),
    }
    const failedStop = {
      ...stopping,
      stopControl: control,
      stopAttempt: failedAttempt,
    }
    writeJsonAtomic(statePath, failedStop)
    throw error
  }
}

async function terminateOwnedState(statePath) {
  return await withStopStateLock(statePath, readJson, async (latestState) => {
    if (latestState.status === 'stopped' || latestState.status === 'stale') return latestState
    return await terminateOwnedStateUnlocked(latestState, statePath)
  })
}

const [action, ...rawOptions] = process.argv.slice(2)
if (action === 'self-test') {
  if (rawOptions.length) throw new Error('self-test does not accept options')
  const makeTreeWritableForCleanup = (path) => {
    if (!existsSync(path)) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      chmodSync(path, 0o700)
      for (const entry of readdirSync(path)) makeTreeWritableForCleanup(join(path, entry))
    } else {
      chmodSync(path, 0o600)
    }
  }
  const codexIdentity = providerLaunchIdentity('codex')
  if (codexIdentity.slot !== 1 || !codexIdentity.workspace.endsWith('/1/rate-native')) {
    throw new Error(`Provider launch contract self-test drifted: ${JSON.stringify(codexIdentity)}`)
  }
  const identityFixture = {
    provider: 'codex',
    runRoot: '/state/validate-scry-rate-workflow-fixture',
    scryRepo: '/repo/vibecoding/scry',
    canonicalScryRepo: '/repo/vibecoding/scry',
    workspace: '/pool/1/rate-native',
    expectedWorkspace: '/pool/1/rate-native',
    slotLockPath: '/pool/locks/slot-1-codex.json',
    expectedSlotLockPath: '/pool/locks/slot-1-codex.json',
    slotLock: {
      schemaVersion: 2,
      scope: 'slot:codex',
      provider: 'codex',
      runRoot: '/state/validate-scry-rate-workflow-fixture',
      ownerId: 'owner-fixture',
      ownerState: 'ACTIVE',
      ownerStage: 'BOOTSTRAP_READY',
      heartbeatAt: '2026-08-08T00:00:00Z',
    },
  }
  validateStartIdentity(identityFixture)
  const rejectedIdentityCases = [
    { name: 'repo', patch: { scryRepo: '/repo/wrong-scry' } },
    { name: 'workspace', patch: { workspace: '/pool/2/rate-native' } },
    { name: 'slot', patch: { slotLockPath: '/pool/locks/slot-3-qoder.json' } },
    { name: 'runRoot', slotPatch: { runRoot: '/state/other-run' } },
    { name: 'provider', patch: { provider: 'qoder' } },
    { name: 'owner', slotPatch: { ownerState: 'INACTIVE', ownerStage: 'FINALIZE_FAILED' } },
    { name: 'claimed stage', slotPatch: { ownerStage: 'CLAIMED' } },
    { name: 'turn-one intent stage', slotPatch: { ownerStage: 'TURN1_INTENT_PREPARED' } },
    { name: 'finalizing stage', slotPatch: { ownerStage: 'FINALIZING' } },
    { name: 'retained stage', slotPatch: { ownerStage: 'RETAINED_FOR_REVIEW' } },
  ]
  for (const fixture of rejectedIdentityCases) {
    let rejected = false
    try {
      validateStartIdentity({
        ...identityFixture,
        ...(fixture.patch ?? {}),
        slotLock: { ...identityFixture.slotLock, ...(fixture.slotPatch ?? {}) },
      })
    } catch {
      rejected = true
    }
    if (!rejected) throw new Error(`start identity self-test accepted wrong ${fixture.name}`)
  }
  const direct = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'start'], { encoding: 'utf8' })
  if (direct.status === 0 || !String(direct.stderr).includes('direct start is forbidden')) {
    throw new Error('direct start action was not rejected')
  }
  const root = mkdtempSync(join(tmpdir(), 'test-scry-app-'))
  try {
    const source = join(root, 'source')
    const runRoot = join(root, 'run')
    mkdirSync(join(source, 'out', 'main'), { recursive: true })
    mkdirSync(join(source, 'out', 'renderer'), { recursive: true })
    mkdirSync(join(source, 'node_modules'), { recursive: true })
    mkdirSync(runRoot)
    writeFileSync(join(source, 'out', 'main', 'index.js'), 'fixture\n')
    writeFileSync(join(source, 'out', 'renderer', 'index.html'), 'fixture\n')
    writeFileSync(join(source, 'package.json'), '{"main":"./out/main/index.js"}\n')
    mkdirSync(join(runRoot, RUNTIME_RELATIVE))
    writeFileSync(join(runRoot, RUNTIME_RELATIVE, 'partial'), 'fixture\n')
    const recovered = recoverPrelaunchResidue(runRoot)
    if (recovered.length !== 1 || !existsSync(recovered[0].destination)) {
      throw new Error('prelaunch residue self-test did not quarantine the partial runtime')
    }
    const snapshot = createRuntimeSnapshot(source, runRoot, join(source, 'out'))
    if (snapshot.sourceFingerprint.sha256 !== snapshot.snapshotFingerprint.sha256) {
      throw new Error('runtime snapshot self-test fingerprint mismatch')
    }
    if (realpathSync(join(snapshot.runtimeRoot, 'node_modules')) !== realpathSync(join(source, 'node_modules'))) {
      throw new Error('runtime snapshot self-test node_modules link mismatch')
    }
    const isolatedRun = join(root, 'isolated-run')
    mkdirSync(join(isolatedRun, 'scry-build-out', 'main'), { recursive: true })
    mkdirSync(join(isolatedRun, 'scry-build-out', 'renderer'), { recursive: true })
    writeFileSync(join(isolatedRun, 'scry-build-out', 'main', 'index.js'), 'isolated\n')
    writeFileSync(join(isolatedRun, 'scry-build-out', 'renderer', 'index.html'), 'isolated\n')
    chmodSync(join(isolatedRun, 'scry-build-out', 'main', 'index.js'), 0o400)
    chmodSync(join(isolatedRun, 'scry-build-out', 'renderer', 'index.html'), 0o400)
    chmodSync(join(isolatedRun, 'scry-build-out', 'main'), 0o500)
    chmodSync(join(isolatedRun, 'scry-build-out', 'renderer'), 0o500)
    chmodSync(join(isolatedRun, 'scry-build-out'), 0o500)
    const isolatedOut = resolveBuildOut(source, isolatedRun, join(isolatedRun, 'scry-build-out'))
    const isolatedSnapshot = createRuntimeSnapshot(source, isolatedRun, isolatedOut)
    if (isolatedSnapshot.sourceOut !== isolatedOut) throw new Error('isolated build output was not recorded')
    let outsideRejected = false
    try {
      resolveBuildOut(source, isolatedRun, join(root, 'outside'))
    } catch {
      outsideRejected = true
    }
    if (!outsideRejected) throw new Error('outside build output was accepted')
    const invalidRunRoot = join(root, 'invalid-state-run')
    mkdirSync(invalidRunRoot)
    writeFileSync(join(invalidRunRoot, 'test-scry-state.json'), '{broken\n')
    const invalidRecovered = recoverPrelaunchResidue(invalidRunRoot, true)
    if (invalidRecovered.length !== 1 || existsSync(join(invalidRunRoot, 'test-scry-state.json'))) {
      throw new Error('invalid launch state self-test was not quarantined')
    }
  } finally {
    makeTreeWritableForCleanup(root)
    rmSync(root, { recursive: true, force: true })
  }
  process.stdout.write('self-test: PASS\n')
  process.exit(0)
}
if (action === 'start') {
  throw new Error('direct start is forbidden; use fixed_workspace.py start-test-app')
}
if (!['start-locked', 'status', 'stop'].includes(action)) {
  throw new Error('usage: test_scry_app.mjs self-test | start-locked --authorization <path> --lifecycle-gate-fd <fd> --run-root <path> --provider <id> --scry-repo <path> --workspace <path> [--build-out <path>] [--port <port>] | status|stop --run-root <path>')
}
const options = parseOptions(rawOptions)
const runRoot = safeRunRoot(requireOption(options, 'run-root'))
const statePath = join(runRoot, 'test-scry-state.json')

if (action === 'start-locked') {
  const allowed = new Set(['authorization', 'lifecycle-gate-fd', 'run-root', 'provider', 'scry-repo', 'workspace', 'build-out', 'port'])
  if ([...options.keys()].some((key) => !allowed.has(key))) throw new Error('unsupported start option')
  const provider = requireOption(options, 'provider')
  const startAuthorization = validateStartAuthorization(options, runRoot, provider)
  const scryRepo = realpathSync(resolve(requireOption(options, 'scry-repo')))
  const expectedWorkspace = realpathSync(resolve(requireOption(options, 'workspace')))
  const launchIdentity = readValidatedStartIdentity(provider, runRoot, scryRepo, expectedWorkspace)
  const electronCli = join(scryRepo, 'node_modules', '.bin', 'electron')
  const buildOut = resolveBuildOut(scryRepo, runRoot, options.get('build-out'))
  const main = join(buildOut, 'main', 'index.js')
  const sourceRenderer = join(buildOut, 'renderer', 'index.html')
  if (!existsSync(electronCli)) throw new Error(`Electron executable not found: ${electronCli}`)
  if (!existsSync(main)) throw new Error(`Scry build not found: ${main}; run npm run build first`)
  if (!existsSync(sourceRenderer)) {
    throw new Error(`Scry renderer build not found: ${pathToFileURL(sourceRenderer).href}; run npm run build first`)
  }
  let recoveredPrelaunchResidue = []
  if (lexists(statePath)) {
    if (lstatSync(statePath).isSymbolicLink()) throw new Error(`refusing to recover symlinked launch state: ${statePath}`)
    let previous = null
    try {
      previous = readJson(statePath)
    } catch {
      recoveredPrelaunchResidue = recoverPrelaunchResidue(runRoot, true)
    }
    if (previous !== null) {
      if (['starting', 'running', 'failed', 'stopping'].includes(previous.status) && alive(previous.pid)) {
        throw new Error(`owned Scry Test launch state is still active: ${previous.pid} (${previous.status})`)
      }
      throw new Error('run root already contains launch state; create a new run root')
    }
  }

  if (!recoveredPrelaunchResidue.length) recoveredPrelaunchResidue = recoverPrelaunchResidue(runRoot)
  const buildSnapshot = createRuntimeSnapshot(scryRepo, runRoot, buildOut)
  const runtimeRoot = buildSnapshot.runtimeRoot
  const expectedRendererUrl = pathToFileURL(join(runtimeRoot, 'out', 'renderer', 'index.html')).href

  const userDataDir = join(runRoot, 'scry-test-user-data')
  mkdirSync(userDataDir, { recursive: false, mode: 0o700 })
  writeFileSync(join(userDataDir, '.legacy-agent-scope-migration-v1.done'), 'isolated test app\n', { mode: 0o600 })
  writeFileSync(join(userDataDir, 'recent-folders.json'), `${JSON.stringify([expectedWorkspace], null, 2)}\n`, { mode: 0o600 })
  const port = options.has('port') ? Number(options.get('port')) : await findFreePort()
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid --port')
  const initialEndpoint = await inspectCdpEndpoint(port)
  if (initialEndpoint.status === 'open') throw new Error(`CDP port is already in use: ${port}`)
  if (initialEndpoint.status !== 'closed') {
    throw new Error(`cannot prove CDP port ${port} is free: ${initialEndpoint.error}`)
  }

  if (provider === 'pi' && !existsSync(PI_AGENT_NODE)) throw new Error(`Pi Node runtime not found: ${PI_AGENT_NODE}`)
  const launchId = randomUUID()
  const testElectron = isolatedElectron(scryRepo)
  const logPath = join(runRoot, 'scry-test.log')
  const logFd = openSync(logPath, 'a', 0o600)
  const child = spawn(testElectron.executable, [
    runtimeRoot,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${userDataDir}`,
    `--scry-e2e-owned-launch-id=${launchId}`,
  ], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ...(provider === 'pi' ? { PI_AGENT_NODE } : {}),
      SCRY_E2E_OWNED_LAUNCH_ID: launchId,
      SCRY_TEST_APP: '1',
    },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  child.unref()
  closeSync(logFd)
  if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error('Scry Test spawn did not return a PID')

  const starting = {
    version: STATE_VERSION,
    mode: 'test',
    testAppLabel: 'Scry Test',
    status: 'starting',
    launchId,
    pid: child.pid,
    port,
    provider,
    runRoot,
    scryRepo,
    buildOut,
    runtimeRoot,
    buildSnapshot,
    launchIdentity,
    startAuthorization,
    recoveredPrelaunchResidue,
    appPath: testElectron.appPath,
    bundleIdentifier: testElectron.bundleIdentifier,
    userDataDir,
    expectedWorkspace,
    statePath,
    logPath,
    expectedRendererUrl,
    devToolsActivePortPath: null,
    expectedBrowserPath: null,
    rendererOwnership: null,
    ownedRendererReady: false,
    windowTitleLabeled: false,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
  }
  writeJsonAtomic(statePath, starting)

  let launchState = starting
  try {
    const devToolsIdentity = await waitForDevToolsIdentity(userDataDir, port, child.pid)
    launchState = {
      ...starting,
      devToolsActivePortPath: devToolsIdentity.path,
      expectedBrowserPath: devToolsIdentity.browserPath,
    }
    writeJsonAtomic(statePath, launchState)
    const ownership = await claimRendererOwnership({
      port,
      expectedUrl: expectedRendererUrl,
      expectedBrowserPath: devToolsIdentity.browserPath,
      launchId,
      timeoutMs: START_TIMEOUT_MS,
      isAlive: () => alive(child.pid),
    })
    const state = {
      ...launchState,
      status: 'running',
      rendererOwnership: ownership.evidence,
      ownedRendererReady: true,
      windowTitleLabeled: true,
    }
    writeJsonAtomic(statePath, state)
    process.stdout.write(`${JSON.stringify(state)}\n`)
    process.exit(0)
  } catch (error) {
    const failed = {
      ...launchState,
      status: 'failed',
      startFailed: true,
      startError: errorRecord(error),
      rendererOwnership: error?.evidence ?? null,
    }
    writeJsonAtomic(statePath, failed)
    let cleanupError = null
    try {
      await terminateOwnedState(statePath)
    } catch (stopError) {
      cleanupError = stopError
    }
    const cleanupDetail = cleanupError ? `; cleanup failed: ${cleanupError.message}` : ''
    throw new Error(`Scry Test ownership readiness failed: ${error.message}${cleanupDetail}; inspect ${logPath}`, { cause: error })
  }
}

if ([...options.keys()].some((key) => key !== 'run-root')) throw new Error(`unsupported ${action} option`)
if (!existsSync(statePath)) throw new Error(`launch state not found: ${statePath}`)
const state = readJson(statePath)
const command = processCommand(state.pid)
const currentAlive = command.length > 0
const currentMatches = commandMatches(state, command)

if (action === 'status') {
  const ownership = await liveOwnership(state)
  const ownedRendererReady = ownership.evidence.status === 'verified'
  const cdpClosed = ownership.evidence.status === 'cdp_closed'
  const cdpReachable = Boolean(
    !cdpClosed
    && state.expectedBrowserPath
    && ownership.evidence.actual.browserPath === state.expectedBrowserPath
  )
  const cdpReady = cdpClosed
    ? false
    : cdpReachable && !['cdp_unreachable', 'verification_unavailable', 'context_unstable', 'protocol_error'].includes(ownership.evidence.status)
      ? ownership.evidence.actual.pageTargetCount > 0
      : null
  let buildSnapshotLive = null
  let runtimeSnapshotReady = false
  try {
    buildSnapshotLive = treeFingerprint(join(state.runtimeRoot, 'out'))
    runtimeSnapshotReady = Boolean(
      state.version === STATE_VERSION
      && state.buildSnapshot?.sourceFingerprint?.files === state.buildSnapshot?.snapshotFingerprint?.files
      && state.buildSnapshot?.sourceFingerprint?.sha256 === state.buildSnapshot?.snapshotFingerprint?.sha256
      && state.buildSnapshot?.snapshotFingerprint?.files === buildSnapshotLive.files
      && state.buildSnapshot?.snapshotFingerprint?.sha256 === buildSnapshotLive.sha256
    )
  } catch {
    buildSnapshotLive = null
    runtimeSnapshotReady = false
  }
  process.stdout.write(`${JSON.stringify({
    ...state,
    processAlive: currentAlive,
    commandMatches: currentMatches,
    cdpReady,
    cdpReachable,
    cdpClosed,
    ownedRendererReady,
    ownedRendererCount: ownedRendererReady ? 1 : 0,
    windowTitleLabeled: ownedRendererReady,
    rendererOwnershipLive: ownership.evidence,
    buildSnapshotLive,
    runtimeSnapshotReady,
  })}\n`)
  process.exit(0)
}

const terminal = await terminateOwnedState(statePath)
process.stdout.write(`${JSON.stringify(terminal)}\n`)
