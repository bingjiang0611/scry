import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { rm, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { recorderEnablement } from './recorder.js'
import { withDirectoryLock, readJson } from './io.js'
import { RECORDER_VERSION } from './store.js'
import { type RecorderDaemonStatus, PROTOCOL_VERSION, recorderDaemonStatus, daemonRequest, recorderSocketPath } from './daemon-transport.js'
import { OWNER_TOKEN_ENV } from './daemon-listen.js'
import { ownerPath, type DaemonOwner, processAlive, stopOwner, legacyStartingPath, waitForOwner, removeOwnedMarker, waitForProcessExit, STOP_WAIT_MS } from './daemon-owner.js'
export { PROTOCOL_VERSION, HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, RecorderHookRejected, type RecorderDaemonStatus, recorderSocketPath, recorderDaemonStatus, sendRecorderDaemonHook } from './daemon-transport.js'
export { listenRecorderDaemon, serveRecorderDaemon, OWNER_TOKEN_ENV, type RecorderDaemonHandle } from './daemon-listen.js'

const STARTING_TTL_MS = 30_000
const OWNER_WAIT_MS = 15_000
const READY_WAIT_MS = 15_000

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
