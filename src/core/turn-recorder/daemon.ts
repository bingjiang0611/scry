import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rm, mkdir, realpath, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { recorderEnablement } from './recorder.js'
import { appendRotatingLog, withDirectoryLock, readJson } from './io.js'
import { RECORDER_VERSION } from './store.js'
import { type RecorderDaemonStatus, PROTOCOL_VERSION, recorderDaemonStatus, daemonRequest, recorderSocketPath } from './daemon-transport.js'
import { OWNER_TOKEN_ENV } from './daemon-listen.js'
import { isNewerRecorderVersion } from './recorder-version-order.js'
import {
  ownerPath, type DaemonOwner, type ForcedStopSignal, processAlive, stopOwner, legacyStartingPath, waitForOwner,
  removeOwnedMarker, waitForProcessExit, pathExists, GRACEFUL_STOP_WAIT_MS, SIGTERM_WAIT_MS, SIGKILL_WAIT_MS
} from './daemon-owner.js'
export { PROTOCOL_VERSION, HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, RecorderHookRejected, type RecorderDaemonStatus, recorderSocketPath, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon-transport.js'
export { listenRecorderDaemon, serveRecorderDaemon, OWNER_TOKEN_ENV, type RecorderDaemonHandle } from './daemon-listen.js'

const STARTING_TTL_MS = 30_000
const OWNER_WAIT_MS = 15_000
const READY_WAIT_MS = 15_000
const SOCKET_RELEASE_WAIT_MS = 2_000

function isRecorderPackageManifest(manifest: { name?: unknown; version?: unknown } | null): manifest is { name: string; version: string } {
  if (!manifest || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') return false
  const name = manifest.name.trim()
  return (name === 'scry-turn-recorder' || name.endsWith('/scry-turn-recorder')) && manifest.version.trim().length > 0
}

export async function resolveTargetRecorderVersion(scriptPath: string | undefined): Promise<string> {
  if (!scriptPath) return RECORDER_VERSION
  const resolved = await realpath(scriptPath).catch(() => scriptPath)
  let current = dirname(resolved)
  for (let depth = 0; depth < 4; depth++) {
    const manifest = await readJson<{ name?: unknown; version?: unknown }>(join(current, 'package.json'))
    if (isRecorderPackageManifest(manifest)) return manifest.version.trim()
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return RECORDER_VERSION
}

export function shouldReplaceDaemon(runningVersion: string | undefined, targetVersion: string): boolean {
  if (!runningVersion || !runningVersion.trim()) return true
  if (runningVersion.trim() === targetVersion.trim()) return false
  if (isNewerRecorderVersion(runningVersion, targetVersion)) return false
  return isNewerRecorderVersion(targetVersion, runningVersion)
}

function sanitizeVersionForLog(version: string | undefined): string {
  if (!version) return 'unknown'
  const trimmed = version.trim()
  return /^[0-9A-Za-z._-]{1,64}$/.test(trimmed) ? trimmed : 'unknown'
}

async function logForcedStop(
  dataRoot: string,
  reason: 'graceful_drain_timeout' | 'stop_endpoint_unavailable' | 'stale_owner_marker',
  signal: ForcedStopSignal,
  fromVersion: string | undefined,
  toVersion: string
): Promise<void> {
  const line = `${new Date().toISOString()} WARN daemon_handoff_forced_stop reason=${reason} signal=${signal} fromVersion=${sanitizeVersionForLog(fromVersion)} toVersion=${sanitizeVersionForLog(toVersion)}`
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), line).catch(() => undefined)
}

async function waitForDaemon(
  workspace: string,
  env: NodeJS.ProcessEnv,
  expectedVersion: string,
  deadlineMs: number
): Promise<RecorderDaemonStatus | null> {
  const deadline = Date.now() + deadlineMs
  do {
    const status = await recorderDaemonStatus(workspace, env)
    if (status.running && status.recorderVersion === expectedVersion) return status
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

async function lockActive(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath)
    return Date.now() - info.mtimeMs <= STARTING_TTL_MS
  } catch {
    return false
  }
}

export async function startRecorderDaemon(args: {
  workspace: string
  scriptPath: string
  env?: NodeJS.ProcessEnv
  waitForReady?: boolean
  detachReplace?: boolean
  drainWaitMs?: number
  sigtermWaitMs?: number
  sigkillWaitMs?: number
}): Promise<{ started: boolean; status: RecorderDaemonStatus }> {
  const env = args.env ?? process.env
  const enablement = await recorderEnablement(args.workspace, env)
  if (!enablement.enabled) throw new Error(`recorder is disabled: ${enablement.reason}`)
  const socketPath = recorderSocketPath(enablement.workspaceRoot, env)
  const lockPath = join(enablement.dataRoot, 'locks', 'daemon-start.lock')
  const targetVersion = await resolveTargetRecorderVersion(args.scriptPath)
  if (args.detachReplace) {
    const existing = await recorderDaemonStatus(enablement.workspaceRoot, env)
    if (existing.running) {
      if (!shouldReplaceDaemon(existing.recorderVersion, targetVersion)) return { started: false, status: existing }
      if (await lockActive(lockPath)) {
        return { started: true, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
      }
      if (await pathExists(args.scriptPath)) {
        const handoff = spawn(process.execPath, [args.scriptPath, 'recorder', 'start', '--workspace', enablement.workspaceRoot, '--quiet'], {
          cwd: enablement.workspaceRoot,
          detached: true,
          env: { ...env, SCRY_RECORDER_SOCKET: socketPath },
          stdio: 'ignore'
        })
        handoff.unref()
        return { started: true, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
      }
    } else if (args.waitForReady === false && await lockActive(lockPath)) {
      return { started: true, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
    }
  }
  const drainWaitMs = args.drainWaitMs ?? GRACEFUL_STOP_WAIT_MS
  const sigtermWaitMs = args.sigtermWaitMs ?? SIGTERM_WAIT_MS
  const sigkillWaitMs = args.sigkillWaitMs ?? SIGKILL_WAIT_MS
  return withDirectoryLock(lockPath, async () => {
    const existing = await recorderDaemonStatus(enablement.workspaceRoot, env)
    if (existing.running && !shouldReplaceDaemon(existing.recorderVersion, targetVersion)) {
      return { started: false, status: existing }
    }
    if (existing.running) {
      await stopRecorderDaemon(enablement.workspaceRoot, env, {
        drainWaitMs,
        sigtermWaitMs,
        sigkillWaitMs,
        onForcedStop: (reason, signal, fromVersion) =>
          logForcedStop(enablement.dataRoot, reason, signal, fromVersion ?? existing.recorderVersion, targetVersion)
      })
      if (!await waitForSocketRelease(socketPath, SOCKET_RELEASE_WAIT_MS)) {
        throw new Error(`previous recorder daemon did not stop within ${SOCKET_RELEASE_WAIT_MS}ms`)
      }
    }
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (
      marker &&
      marker.state === 'starting' &&
      processAlive(marker.pid) &&
      Date.now() - marker.createdAt <= STARTING_TTL_MS &&
      !shouldReplaceDaemon(marker.recorderVersion, targetVersion)
    ) {
      if (args.waitForReady === false) {
        return { started: false, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
      }
      const status = await waitForDaemon(enablement.workspaceRoot, env, marker.recorderVersion || targetVersion, READY_WAIT_MS)
      if (status) return { started: false, status }
      throw new Error('recorder daemon is still starting')
    }
    if (marker) {
      const forced = await stopOwner(marker, { sigtermWaitMs, sigkillWaitMs })
      if (forced) await logForcedStop(enablement.dataRoot, 'stale_owner_marker', forced, marker.recorderVersion, targetVersion)
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
    const status = await waitForDaemon(enablement.workspaceRoot, env, targetVersion, READY_WAIT_MS)
    if (!status) {
      await stopOwner(launchedOwner, { sigtermWaitMs, sigkillWaitMs })
      await removeOwnedMarker(markerPath, instanceId)
      await rm(socketPath, { force: true })
      throw new Error(`recorder daemon did not become ready within ${READY_WAIT_MS}ms`)
    }
    return { started: true, status }
  }, { waitMs: Math.max(3_000, drainWaitMs + sigtermWaitMs + sigkillWaitMs + 2_000) })
}

export async function notifyRecorderInbox(args: {
  workspace: string
  scriptPath?: string
  env?: NodeJS.ProcessEnv
  wakeBudgetMs?: number
}): Promise<'started' | 'woken' | 'unavailable'> {
  const env = args.env ?? process.env
  const socketPath = recorderSocketPath(args.workspace, env)
  if (!args.scriptPath) return 'unavailable'
  const started = await startRecorderDaemon({
    workspace: args.workspace, scriptPath: args.scriptPath, env, waitForReady: false, detachReplace: true
  }).catch(() => null)
  if (!started) return 'unavailable'
  if (started.started) return 'started'
  try {
    const response = await daemonRequest(socketPath, {
      method: 'POST', path: '/v1/wake', timeoutMs: Math.max(50, Math.min(1_000, args.wakeBudgetMs ?? 250))
    })
    return response.statusCode === 200 ? 'woken' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export async function stopRecorderDaemon(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    drainWaitMs?: number
    sigtermWaitMs?: number
    sigkillWaitMs?: number
    onForcedStop?: (
      reason: 'graceful_drain_timeout' | 'stop_endpoint_unavailable',
      signal: ForcedStopSignal,
      fromVersion?: string
    ) => Promise<void> | void
  } = {}
): Promise<boolean> {
  const socketPath = recorderSocketPath(workspace, env)
  const drainWaitMs = options.drainWaitMs ?? GRACEFUL_STOP_WAIT_MS
  const sigtermWaitMs = options.sigtermWaitMs ?? SIGTERM_WAIT_MS
  const sigkillWaitMs = options.sigkillWaitMs ?? SIGKILL_WAIT_MS
  try {
    const response = await daemonRequest(socketPath, { method: 'POST', path: '/v1/stop', timeoutMs: 2_000 })
    if (response.statusCode !== 200 || response.body.ok !== true) return false
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (marker && marker.pid !== process.pid) {
      if (!await waitForProcessExit(marker.pid, drainWaitMs)) {
        const forced = await stopOwner(marker, { sigtermWaitMs, sigkillWaitMs })
        if (forced) await options.onForcedStop?.('graceful_drain_timeout', forced, marker.recorderVersion)
      }
      if (!processAlive(marker.pid)) {
        await removeOwnedMarker(markerPath, marker.instanceId)
        await rm(socketPath, { force: true })
      }
    }
    return true
  } catch {
    const markerPath = ownerPath(socketPath)
    const marker = await readJson<DaemonOwner>(markerPath)
    if (!marker || marker.pid === process.pid || !processAlive(marker.pid)) return false
    const forced = await stopOwner(marker, { sigtermWaitMs, sigkillWaitMs })
    if (forced) await options.onForcedStop?.('stop_endpoint_unavailable', forced, marker.recorderVersion)
    if (processAlive(marker.pid)) return false
    await removeOwnedMarker(markerPath, marker.instanceId)
    await rm(socketPath, { force: true })
    return true
  }
}
