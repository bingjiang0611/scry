import { randomUUID } from 'node:crypto'
import { type Server, createServer } from 'node:http'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ProviderId } from '../../shared/provider.js'
import { applyHookEnvironment } from './commit-environment.js'
import { recorderEnablement, recoverRecorder, handleRecorderHook, drainRecorderDelivery } from './recorder.js'
import { appendRotatingLog, readJson, writeJsonAtomic, writeTextAtomic } from './io.js'
import { hasSymlinkComponent } from './config.js'
import { recorderHasOpenTurn } from './runtime-state.js'
import { RECORDER_VERSION } from './store.js'
import { pruneStaleTemps } from './temp-prune.js'
import {
  PROTOCOL_VERSION, HOOK_EVENT_PATH, RECORDER_VERSION_HEADER, daemonRequest, writeJson, header, readJsonBody, recorderSocketPath
} from './daemon-transport.js'
import { ownerPath, type DaemonOwner, processAlive, removeOwnedMarker, pathExists } from './daemon-owner.js'

const DEFAULT_IDLE_MS = 30 * 60 * 1_000
const MAX_IDLE_MS = 24 * 60 * 60 * 1_000
const RECOVERY_POLL_MS = 1_000
const MAX_RECOVERY_POLL_MS = 15_000
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
      // `/v1/hook` stays readable for hooks installed by an older CLI. New hooks use the versioned
      // path below so a mixed-version daemon cannot apply an event under the wrong recorder.
      if (request.method !== 'POST' || (request.url !== HOOK_EVENT_PATH && request.url !== '/v1/hook')) {
        writeJson(response, 404, { ok: false, error: 'not found' })
        return
      }
      if (header(request, 'x-scry-protocol') !== PROTOCOL_VERSION) {
        writeJson(response, 409, { ok: false, error: 'protocol mismatch' })
        return
      }
      if (request.url === HOOK_EVENT_PATH && header(request, RECORDER_VERSION_HEADER) !== RECORDER_VERSION) {
        // Refuse before reading or applying the event: the hook must replace this owner and resend.
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
      const { payload, env: requestEnv } = await readJsonBody(request)
      const result = await handleRecorderHook({
        provider, event, workspace: enablement.workspaceRoot, payload,
        env: applyHookEnvironment(env, requestEnv), deferDelivery: true
      })
      scheduleRecovery(true)
      writeJson(response, 200, { ok: true, status: result.status })
      // The daemon outlives this response, so delivery runs after it instead of inside the
      // Provider's hook budget. A crash before it lands is covered by at-least-once redelivery.
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
      // HTTP responses can finish before delivery; shutdown must not release a workspace still in use.
      await Promise.all(deliveryInFlight)
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
  // 常驻进程起来时顺手清理一次中断写盘留下的 `.tmp`：排队的 hook 事件很多时，下一个提交通知可能要
  // 等很久。与提交路径的按天清理互不依赖，失败也只是这次不清理。等待它完成，避免进程在别处收尾时
  // 还有一次目录遍历在写标记文件。
  await pruneStaleTemps(enablement.dataRoot).catch(() => undefined)
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
