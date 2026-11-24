import { randomUUID } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ProviderId } from '../../shared/provider.js'
import { applyHookEnvironment } from './commit-environment.js'
import { recorderEnablement, recoverRecorder, handleRecorderHook, drainRecorderDelivery } from './recorder.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic, writeTextAtomic } from './io.js'
import type { RecorderEnablement } from './config.js'
import { hasSymlinkComponent } from './config.js'
import { recorderHasOpenTurn } from './runtime-state.js'
import { RECORDER_VERSION, listRecordSummaries } from './store.js'
import { pruneStaleTemps } from './temp-prune.js'
import {
  PROTOCOL_VERSION, HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, daemonRequest, writeJson, header, readJsonBody, recorderSocketPath
} from './daemon-transport.js'
import { ownerPath, type DaemonOwner, processAlive, removeOwnedMarker, pathExists } from './daemon-owner.js'
import { serveCaptureRequest } from './daemon-capture.js'
import { SESSION_CAPTURE_PROTOCOL } from './session-capture-contract.js'

const DEFAULT_IDLE_MS = 30 * 60 * 1_000
const MAX_IDLE_MS = 24 * 60 * 60 * 1_000
const RECOVERY_POLL_MS = 1_000
const MAX_RECOVERY_POLL_MS = 15_000
const WAKE_PATH = '/v1/wake'
const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
export const OWNER_TOKEN_ENV = 'SCRY_RECORDER_OWNER_TOKEN'

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

interface RecorderDaemonListenOptions {
  workspace: string
  socketPath?: string
  idleMs?: number
  env?: NodeJS.ProcessEnv
  idleCloseProbe?: () => Promise<void> | void
  recoveryProbe?: () => Promise<void> | void
  recoveryPollMs?: number
  maxRecoveryPollMs?: number
  scheduleRecoveryTimeout?: (run: () => Promise<void>, delayMs: number) => () => void
  idleUpdate?: () => Promise<string | null>
}

export async function listenRecorderDaemon(args: RecorderDaemonListenOptions): Promise<RecorderDaemonHandle> {
  const env = args.env ?? process.env
  const enablement = await recorderEnablement(args.workspace, env)
  if (!enablement.enabled) throw new Error(`recorder is disabled: ${enablement.reason}`)
  const socketPath = recorderSocketPath(enablement.workspaceRoot, args.socketPath
    ? { ...env, SCRY_RECORDER_SOCKET: args.socketPath }
    : env)
  return withDirectoryLock(`${socketPath}.listen.lock`, () => startRecorderDaemon(args, enablement, socketPath, env))
}

async function startRecorderDaemon(
  args: RecorderDaemonListenOptions, enablement: Extract<RecorderEnablement, { enabled: true }>, socketPath: string, env: NodeJS.ProcessEnv
): Promise<RecorderDaemonHandle> {
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
  const deliveryInFlight = new Set<Promise<void>>()
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
      .then(() => recoverRecorder(enablement.workspaceRoot, env, undefined, undefined, { incremental: true }))
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
          const installed = await args.idleUpdate().catch(() => null)
          if (installed) {
            await appendRotatingLog(
              daemonLog,
              `${new Date().toISOString()} idle update installed ${RECORDER_VERSION} -> ${installed}; exiting so the next event starts it`
            ).catch(() => undefined)
          }
        }
        if (closing || activityGeneration !== scheduledGeneration) return
        if (await recorderHasOpenTurn(enablement.dataRoot)) {
          scheduleIdle()
          return
        }
        if (activityGeneration !== scheduledGeneration) return
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
    const activity = request.method === 'POST' &&
      (request.url === HOOK_EVENT_PATH || request.url === '/v1/hook' || request.url === WAKE_PATH)
    if (activity) {
      activityGeneration++
      if (idleTimer) clearTimeout(idleTimer)
    }
    requestCount++
    lastRequestAt = new Date().toISOString()
    try {
      if (request.method === 'GET' && request.url === '/v1/status') {
        writeJson(response, 200, { running: true, protocol: PROTOCOL_VERSION, captureProtocol: SESSION_CAPTURE_PROTOCOL, recorderVersion: RECORDER_VERSION, pid: process.pid, startedAt, requestCount, errorCount, lastRequestAt })
        return
      }
      if (request.method === 'POST' && request.url === WAKE_PATH) {
        scheduleRecovery(true)
        writeJson(response, 200, { ok: true, queued: true })
        return
      }
      if (request.method === 'POST' && request.url === '/v1/stop') {
        writeJson(response, 200, { ok: true })
        setImmediate(() => void close())
        return
      }
      if (request.method !== 'POST' || (request.url !== HOOK_EVENT_PATH && request.url !== '/v1/hook')) {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      if (header(request, 'x-scry-protocol') !== PROTOCOL_VERSION) {
        writeJson(response, 409, { ok: false, error: 'protocol mismatch' })
        return
      }
      if (request.url === HOOK_EVENT_PATH && header(request, RECORDER_VERSION_HEADER) !== RECORDER_VERSION) {
        writeJson(response, 409, {
          ok: false,
          error: 'recorder version mismatch',
          recorderVersion: RECORDER_VERSION,
          expected: header(request, RECORDER_VERSION_HEADER) ?? null
        })
        return
      }
      const provider = header(request, 'x-scry-provider') as ProviderId | undefined
      const event = header(request, 'x-scry-event')
      if (!provider || !PROVIDERS.has(provider) || !event || event.length > 128 || /[\r\n]/.test(event)) {
        writeJson(response, 400, { ok: false, error: 'invalid provider or event' })
        return
      }
      const clientPidHeader = header(request, 'x-scry-client-pid')
      const clientPid = clientPidHeader && /^\d{1,10}$/.test(clientPidHeader) ? Number(clientPidHeader) : undefined
      if (clientPid !== undefined && clientPid <= 1) {
        writeJson(response, 400, { ok: false, error: 'invalid client pid' })
        return
      }
      const captureMode = header(request, 'x-scry-capture-mode')
      if (captureMode !== undefined && captureMode !== 'session') {
        writeJson(response, 400, { ok: false, error: 'unsupported capture mode' })
        return
      }
      const { payload, env: requestEnv } = await readJsonBody(request)
      const hookEnv = applyHookEnvironment(env, requestEnv)
      if (captureMode === 'session') {
        await serveCaptureRequest({
          enablement, provider, event, payload, env: hookEnv, response,
          recovery: () => scheduleRecovery(true), deliveries: deliveryInFlight,
          ...(clientPid !== undefined ? { ancestryFromPid: clientPid } : {})
        })
        return
      }
      const result = await handleRecorderHook({
        provider, event, workspace: enablement.workspaceRoot, payload,
        env: hookEnv, deferDelivery: true,
        ...(clientPid !== undefined ? { ancestryFromPid: clientPid } : {})
      })
      scheduleRecovery(true)
      writeJson(response, 200, { ok: true, status: result.status })
      const delivery = drainRecorderDelivery(enablement.workspaceRoot, env).catch(() => undefined)
      deliveryInFlight.add(delivery)
      void delivery.finally(() => { deliveryInFlight.delete(delivery) })
    } catch (error) {
      errorCount++
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
      const message = error instanceof Error ? error.message : String(error)
      await appendRotatingLog(daemonLog, `${new Date().toISOString()} ERROR ${message}`).catch(() => undefined)
      if (!response.headersSent) writeJson(response, statusCode, { ok: false, error: message })
      else response.end()
    } finally {
      if (activity && !closing) scheduleIdle()
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
      await Promise.all(deliveryInFlight)
    }).finally(async () => {
      const currentOwner = await readJson<DaemonOwner>(markerPath)
      if (currentOwner?.instanceId === instanceId) {
        await rm(socketPath, { force: true })
        await removeOwnedMarker(markerPath, instanceId)
      }
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
    if (await hasSymlinkComponent(enablement.workspaceRoot, '.scry')) {
      throw new Error('cannot publish recorder socket through a symlinked .scry directory')
    }
    await writeTextAtomic(join(enablement.workspaceRoot, '.scry', 'recorder-socket-path'), `${socketPath}\n`)
  } catch (error) {
    if (server.listening) await close()
    await removeOwnedMarker(markerPath, instanceId)
    throw error
  }
  await pruneStaleTemps(enablement.dataRoot).catch(() => undefined)
  // Warm the derived record summary before the first hook needs it: a cold rebuild costs one full
  // pass over the store, and a hook that met it would pay that on its own synchronous path. Started
  // here, once per daemon, it runs beside the socket instead of inside an event.
  void listRecordSummaries(enablement.dataRoot).catch(() => undefined)
  scheduleIdle()
  scheduleRecovery(true)
  return { socketPath, closed, close }
}

export async function serveRecorderDaemon(args: {
  workspace: string
  socketPath?: string
  env?: NodeJS.ProcessEnv
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
