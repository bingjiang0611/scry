import { applyHookEnvironment } from './commit-environment.js'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rm, mkdir, chmod } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { type ProviderId } from '../../shared/provider.js'
import { recorderEnablement, recoverRecorder, handleRecorderHook, drainRecorderDelivery } from './recorder.js'
import { withDirectoryLock, readJson, appendRotatingLog, writeJsonAtomic, writeTextAtomic } from './io.js'
import { hasSymlinkComponent } from './config.js'
import { recorderHasOpenTurn } from './runtime-state.js'
import { RECORDER_VERSION } from './store.js'
import { type RecorderDaemonStatus, recorderDaemonStatus, daemonRequest, recorderSocketPath, PROTOCOL_VERSION, writeJson, header, readJsonBody } from './daemon-transport.js'
import { ownerPath, type DaemonOwner, processAlive, stopOwner, legacyStartingPath, waitForOwner, removeOwnedMarker, waitForProcessExit, STOP_WAIT_MS, pathExists } from './daemon-owner.js'
export { PROTOCOL_VERSION, type RecorderDaemonStatus, recorderSocketPath, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon-transport.js'

const DEFAULT_IDLE_MS = 30 * 60 * 1_000
const MAX_IDLE_MS = 24 * 60 * 60 * 1_000
const RECOVERY_POLL_MS = 1_000
const MAX_RECOVERY_POLL_MS = 15_000
const STARTING_TTL_MS = 30_000
const OWNER_WAIT_MS = 15_000
const READY_WAIT_MS = 15_000
const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const OWNER_TOKEN_ENV = 'SCRY_RECORDER_OWNER_TOKEN'

export interface RecorderDaemonHandle {
  socketPath: string
  closed: Promise<void>
  close(): Promise<void>
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.max(min, Math.min(max, parsed)) : fallback
}

async function waitForDaemon(workspace: string, env: NodeJS.ProcessEnv, deadlineMs: number): Promise<RecorderDaemonStatus | null> {
  const deadline = Date.now() + deadlineMs
  do {
    const status = await recorderDaemonStatus(workspace, env)
    if (status.running && status.recorderVersion === RECORDER_VERSION) return status
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  } while (Date.now() < deadline)
  return null
}

async function waitForSocketRelease(socketPath: string, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  do {
    try {
      await daemonRequest(socketPath, { method: 'GET', path: '/v1/status', timeoutMs: 100 })
    } catch {
      return true
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  } while (Date.now() < deadline)
  return false
}

export async function startRecorderDaemon(args: {
  workspace: string
  scriptPath: string
  env?: NodeJS.ProcessEnv
  waitForReady?: boolean
}): Promise<{ started: boolean; status: RecorderDaemonStatus }> {
  const env = args.env ?? process.env
  const enablement = await recorderEnablement(args.workspace, env)
  if (!enablement.enabled) throw new Error(`recorder is disabled: ${enablement.reason}`)
  const socketPath = recorderSocketPath(enablement.workspaceRoot, env)
  const lockPath = join(enablement.dataRoot, 'locks', 'daemon-start.lock')
  return withDirectoryLock(lockPath, async () => {
    const existing = await recorderDaemonStatus(enablement.workspaceRoot, env)
    if (existing.running && existing.recorderVersion === RECORDER_VERSION) return { started: false, status: existing }
    if (existing.running) {
      await stopRecorderDaemon(enablement.workspaceRoot, env)
      if (!await waitForSocketRelease(socketPath, 1_000)) throw new Error('previous recorder daemon did not stop within 1000ms')
    }
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (
      marker &&
      marker.state === 'starting' &&
      processAlive(marker.pid) &&
      Date.now() - marker.createdAt <= STARTING_TTL_MS
    ) {
      if (args.waitForReady === false) {
        return { started: false, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
      }
      const status = await waitForDaemon(enablement.workspaceRoot, env, READY_WAIT_MS)
      if (status) return { started: false, status }
      throw new Error('recorder daemon is still starting')
    }
    if (marker) {
      await stopOwner(marker)
      if (processAlive(marker.pid)) throw new Error(`previous recorder daemon process ${marker.pid} did not stop`)
    }
    await rm(markerPath, { force: true })
    await rm(legacyStartingPath(socketPath), { force: true })
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    const instanceId = randomUUID()
    const child = spawn(process.execPath, [args.scriptPath, 'recorder', 'serve', '--workspace', enablement.workspaceRoot, '--socket', socketPath], {
      cwd: enablement.workspaceRoot,
      detached: true,
      env: { ...env, SCRY_RECORDER_SOCKET: socketPath, [OWNER_TOKEN_ENV]: instanceId },
      stdio: 'ignore'
    })
    const childPid = child.pid
    child.unref()
    if (args.waitForReady === false) {
      return { started: true, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
    }
    const launchedOwner = await waitForOwner(markerPath, instanceId, OWNER_WAIT_MS)
    if (!launchedOwner) {
      if (childPid && processAlive(childPid)) {
        try { process.kill(childPid, 'SIGTERM') } catch {}
      }
      throw new Error(`recorder daemon did not publish its owner marker within ${OWNER_WAIT_MS}ms`)
    }
    const status = await waitForDaemon(enablement.workspaceRoot, env, READY_WAIT_MS)
    if (!status) {
      await stopOwner(launchedOwner)
      await removeOwnedMarker(markerPath, instanceId)
      await rm(socketPath, { force: true })
      throw new Error(`recorder daemon did not become ready within ${READY_WAIT_MS}ms`)
    }
    return { started: true, status }
  }, { waitMs: 3_000 })
}

export async function stopRecorderDaemon(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const socketPath = recorderSocketPath(workspace, env)
  try {
    const response = await daemonRequest(socketPath, { method: 'POST', path: '/v1/stop', timeoutMs: 1_000 })
    if (response.statusCode !== 200 || response.body.ok !== true) return false
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (marker?.pid !== process.pid) {
      if (marker && !await waitForProcessExit(marker.pid, STOP_WAIT_MS)) await stopOwner(marker)
      if (marker && !processAlive(marker.pid)) await removeOwnedMarker(markerPath, marker.instanceId)
    }
    return true
  } catch {
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (!marker || !processAlive(marker.pid)) return false
    await stopOwner(marker)
    if (processAlive(marker.pid)) return false
    await removeOwnedMarker(markerPath, marker.instanceId)
    await rm(socketPath, { force: true })
    return true
  }
}

export async function listenRecorderDaemon(args: {
  workspace: string
  socketPath?: string
  idleMs?: number
  env?: NodeJS.ProcessEnv
  idleCloseProbe?: () => Promise<void> | void
  recoveryProbe?: () => Promise<void> | void
  /** Test seams for deterministic backoff coverage. Production callers leave these unset. */
  recoveryPollMs?: number
  maxRecoveryPollMs?: number
  scheduleRecoveryTimeout?: (run: () => Promise<void>, delayMs: number) => () => void
  /**
   * Optional hook run once the daemon has decided to shut down for inactivity: no open turn, no
   * request for the whole idle window. That is the only safe moment to replace the CLI on disk -
   * the process is exiting anyway, so the next hook event starts whatever version is there, and no
   * turn can be split across two versions. Core stays offline; the caller owns the policy and any
   * network access. Returning the installed version only affects what gets logged.
   */
  idleUpdate?: () => Promise<string | null>
}): Promise<RecorderDaemonHandle> {
  const env = args.env ?? process.env
  const enablement = await recorderEnablement(args.workspace, env)
  if (!enablement.enabled) throw new Error(`recorder is disabled: ${enablement.reason}`)
  const socketPath = recorderSocketPath(enablement.workspaceRoot, args.socketPath
    ? { ...env, SCRY_RECORDER_SOCKET: args.socketPath }
    : env)
  const instanceId = env[OWNER_TOKEN_ENV]?.trim() || randomUUID()
  const markerPath = ownerPath(socketPath)
  const idleMs = args.idleMs ?? positiveInt(env.SCRY_RECORDER_IDLE_MS, DEFAULT_IDLE_MS, 1_000, MAX_IDLE_MS)
  const startedAt = new Date().toISOString()
  const daemonLog = join(dirname(socketPath), 'logs', 'daemon.log')
  let requestCount = 0
  let errorCount = 0
  let lastRequestAt: string | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let cancelRecoveryTimer: (() => void) | undefined
  let recoveryInFlight: Promise<{ recovered: number; pending: number }> | undefined
  const recoveryPollMs = Math.max(1, Math.floor(args.recoveryPollMs ?? RECOVERY_POLL_MS))
  const maxRecoveryPollMs = Math.max(recoveryPollMs, Math.floor(args.maxRecoveryPollMs ?? MAX_RECOVERY_POLL_MS))
  let recoveryDelayMs = recoveryPollMs
  let recoveryScheduleGeneration = 0
  let closing: Promise<void> | undefined
  let activityGeneration = 0

  const runRecovery = (): Promise<{ recovered: number; pending: number }> => {
    if (recoveryInFlight) return recoveryInFlight
    recoveryInFlight = Promise.resolve()
      .then(() => args.recoveryProbe?.())
      .then(() => recoverRecorder(enablement.workspaceRoot, env))
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        await appendRotatingLog(daemonLog, `${new Date().toISOString()} ERROR recovery: ${message}`).catch(() => undefined)
        return { recovered: 0, pending: 0 }
      })
      .finally(() => { recoveryInFlight = undefined })
    return recoveryInFlight
  }

  const scheduleRecovery = (reset = false): void => {
    if (closing) return
    if (reset) recoveryDelayMs = recoveryPollMs
    cancelRecoveryTimer?.()
    const generation = ++recoveryScheduleGeneration
    const run = async (): Promise<void> => {
      cancelRecoveryTimer = undefined
      if (!await recorderHasOpenTurn(enablement.dataRoot)) return
      const result = await runRecovery()
      if (closing || generation !== recoveryScheduleGeneration) return
      if (!await recorderHasOpenTurn(enablement.dataRoot)) return
      recoveryDelayMs = result.recovered > 0
        ? recoveryPollMs
        : Math.min(maxRecoveryPollMs, recoveryDelayMs * 2)
      scheduleRecovery()
    }
    if (args.scheduleRecoveryTimeout) {
      cancelRecoveryTimer = args.scheduleRecoveryTimeout(run, recoveryDelayMs)
    } else {
      const timer = setTimeout(() => { void run() }, recoveryDelayMs)
      timer.unref()
      cancelRecoveryTimer = () => clearTimeout(timer)
    }
  }

  let closeDaemon: () => Promise<void>
  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    const scheduledGeneration = activityGeneration
    idleTimer = setTimeout(() => {
      void (async () => {
        await runRecovery()
        if (closing || activityGeneration !== scheduledGeneration) return
        const hasOpenTurn = await recorderHasOpenTurn(enablement.dataRoot)
        if (closing || activityGeneration !== scheduledGeneration) return
        if (hasOpenTurn) {
          if (!closing) scheduleIdle()
          return
        }
        await args.idleCloseProbe?.()
        if (closing || activityGeneration !== scheduledGeneration) return
        if (args.idleUpdate) {
          // No timeout here: every step the caller runs is already bounded (npm query 8s, install
          // 120s, verify 8s). Racing it again would cut supervision while the install kept going.
          const installed = await args.idleUpdate().catch(() => null)
          if (installed) {
            await appendRotatingLog(
              daemonLog,
              `${new Date().toISOString()} idle update installed ${RECORDER_VERSION} -> ${installed}; exiting so the next event starts it`
            ).catch(() => undefined)
          }
        }
        await closeDaemon()
      })()
    }, idleMs)
  }

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  const previousOwner = await readJson<DaemonOwner>(markerPath)
  if (previousOwner && processAlive(previousOwner.pid)) {
    throw new Error(`recorder daemon socket is owned by live process ${previousOwner.pid}: ${socketPath}`)
  }
  if (previousOwner && !processAlive(previousOwner.pid)) {
    await rm(markerPath, { force: true })
  }
  const owner: DaemonOwner = {
    schemaVersion: 1,
    pid: process.pid,
    instanceId,
    state: 'starting',
    createdAt: Date.now(),
    recorderVersion: RECORDER_VERSION,
    socketPath
  }
  await writeJsonAtomic(markerPath, owner, { sync: false })
  const socketExisted = await pathExists(socketPath)
  try {
    await daemonRequest(socketPath, { method: 'GET', path: '/v1/status', timeoutMs: 250 })
    throw new Error(`recorder daemon socket is already active: ${socketPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('recorder daemon socket is already active:')) {
      await removeOwnedMarker(markerPath, instanceId)
      throw error
    }
    const code = (error as NodeJS.ErrnoException).code
    if (socketExisted && code !== 'ENOENT' && code !== 'ECONNREFUSED') {
      await removeOwnedMarker(markerPath, instanceId)
      throw new Error(`recorder daemon socket is unresponsive and ownership cannot be proven stale: ${socketPath}`)
    }
  }
  await rm(socketPath, { force: true })

  const server: Server = createServer(async (request, response) => {
    activityGeneration++
    requestCount++
    lastRequestAt = new Date().toISOString()
    if (idleTimer) clearTimeout(idleTimer)
    try {
      if (request.method === 'GET' && request.url === '/v1/status') {
        writeJson(response, 200, { running: true, protocol: PROTOCOL_VERSION, recorderVersion: RECORDER_VERSION, pid: process.pid, startedAt, requestCount, errorCount, lastRequestAt })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/stop') {
        writeJson(response, 200, { ok: true })
        setImmediate(() => void close())
        return
      }
      if (request.method !== 'POST' || request.url !== '/v1/hook') {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      if (header(request, 'x-scry-protocol') !== PROTOCOL_VERSION) {
        writeJson(response, 409, { ok: false, error: 'protocol mismatch' })
        return
      }
      const provider = header(request, 'x-scry-provider') as ProviderId | undefined
      const event = header(request, 'x-scry-event')
      if (!provider || !PROVIDERS.has(provider) || !event || event.length > 128 || /[\r\n]/.test(event)) {
        writeJson(response, 400, { ok: false, error: 'invalid provider or event' })
        return
      }
      const { payload, env: requestEnv } = await readJsonBody(request)
      const result = await handleRecorderHook({
        provider, event, workspace: enablement.workspaceRoot, payload,
        env: applyHookEnvironment(env, requestEnv), deferDelivery: true
      })
      scheduleRecovery(true)
      writeJson(response, 200, { ok: true, status: result.status })
      // The daemon outlives this response, so delivery runs after it instead of inside the
      // Provider's hook budget. A crash before it lands is covered by at-least-once redelivery.
      void drainRecorderDelivery(enablement.workspaceRoot, env).catch(() => undefined)
    } catch (error) {
      errorCount++
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
      const message = error instanceof Error ? error.message : String(error)
      await appendRotatingLog(daemonLog, `${new Date().toISOString()} ERROR ${message}`).catch(() => undefined)
      if (!response.headersSent) writeJson(response, statusCode, { ok: false, error: message })
      else response.end()
    } finally {
      if (!closing) scheduleIdle()
    }
  })

  const closed = new Promise<void>((resolvePromise) => server.once('close', resolvePromise))
  const close = closeDaemon = async (): Promise<void> => {
    if (closing) return closing
    closing = new Promise<void>((resolvePromise) => {
      if (idleTimer) clearTimeout(idleTimer)
      cancelRecoveryTimer?.()
      cancelRecoveryTimer = undefined
      recoveryScheduleGeneration++
      server.close(() => resolvePromise())
    }).then(async () => {
      await recoveryInFlight
    }).finally(async () => {
      await rm(socketPath, { force: true }).catch(() => undefined)
      await removeOwnedMarker(markerPath, instanceId).catch(() => undefined)
    })
    return closing
  }

  try {
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolvePromise()
      })
    })
    await chmod(socketPath, 0o600)
    await writeJsonAtomic(markerPath, { ...owner, state: 'running' }, { sync: false })
    // The shell cannot hash a long endpoint without starting another process. Publish only
    // after listen succeeds; a stale hint is harmless because the shell checks that it is a socket.
    if (await hasSymlinkComponent(enablement.workspaceRoot, '.scry')) {
      throw new Error('cannot publish recorder socket through a symlinked .scry directory')
    }
    await writeTextAtomic(join(enablement.workspaceRoot, '.scry', 'recorder-socket-path'), `${socketPath}\n`)
  } catch (error) {
    if (server.listening) await close()
    await removeOwnedMarker(markerPath, instanceId)
    throw error
  }
  scheduleIdle()
  scheduleRecovery(true)
  return { socketPath, closed, close }
}

export async function serveRecorderDaemon(args: {
  workspace: string
  socketPath?: string
  env?: NodeJS.ProcessEnv
  /** Forwarded to the idle shutdown path; see `listenRecorderDaemon`. */
  idleUpdate?: () => Promise<string | null>
}): Promise<void> {
  const handle = await listenRecorderDaemon(args)
  await recoverRecorder(args.workspace, args.env).catch(() => undefined)
  const shutdown = (): void => { void handle.close() }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    await handle.closed
  } finally {
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
  }
}
