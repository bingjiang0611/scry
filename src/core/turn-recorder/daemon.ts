import { spawn } from 'node:child_process'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { handleRecorderHook, recorderEnablement } from './recorder.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import { RECORDER_VERSION } from './store.js'

const PROTOCOL_VERSION = '1'
const DEFAULT_IDLE_MS = 30 * 60 * 1_000
const MAX_IDLE_MS = 24 * 60 * 60 * 1_000
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_SOCKET_BYTES = 100
const STARTING_TTL_MS = 10_000
const PROVIDERS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode'])

export interface RecorderDaemonStatus {
  running: boolean
  protocol: string
  recorderVersion?: string
  pid?: number
  startedAt?: string
  requestCount?: number
  errorCount?: number
  lastRequestAt?: string
  socketPath: string
}

export interface RecorderDaemonHandle {
  socketPath: string
  closed: Promise<void>
  close(): Promise<void>
}

interface DaemonRequestResult {
  statusCode: number
  body: Record<string, unknown>
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.max(min, Math.min(max, parsed)) : fallback
}

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function startingPath(socketPath: string): string {
  return join(dirname(socketPath), 'daemon-starting.json')
}

export function recorderSocketPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCRY_RECORDER_SOCKET?.trim()
  const socketPath = configured
    ? (isAbsolute(configured) ? configured : resolve(workspace, configured))
    : join(resolve(workspace), '.scry', 'recorder-v1.sock')
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_BYTES) throw new Error(`recorder socket path is too long: ${socketPath}`)
  return socketPath
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body exceeds 8 MiB'), { statusCode: 413 })
    chunks.push(bytes)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw Object.assign(new Error('hook payload must be valid JSON'), { statusCode: 400 })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('hook payload must be a JSON object'), { statusCode: 400 })
  }
  return value as Record<string, unknown>
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function daemonRequest(
  socketPath: string,
  options: { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }
): Promise<DaemonRequestResult> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      socketPath,
      method: options.method,
      path: options.path,
      headers: {
        ...(options.body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(options.body)) } : {}),
        ...options.headers
      }
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))))
      response.on('end', () => {
        const source = Buffer.concat(chunks).toString('utf8')
        let body: Record<string, unknown> = {}
        try {
          body = source.trim() ? JSON.parse(source) as Record<string, unknown> : {}
        } catch {
          body = { error: source }
        }
        resolvePromise({ statusCode: response.statusCode ?? 500, body })
      })
    })
    request.setTimeout(options.timeoutMs ?? 500, () => request.destroy(new Error('recorder daemon request timed out')))
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

export async function recorderDaemonStatus(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<RecorderDaemonStatus> {
  const socketPath = recorderSocketPath(workspace, env)
  try {
    const response = await daemonRequest(socketPath, { method: 'GET', path: '/v1/status', timeoutMs: 500 })
    if (response.statusCode !== 200 || response.body.protocol !== PROTOCOL_VERSION) return { running: false, protocol: PROTOCOL_VERSION, socketPath }
    return { ...response.body, running: true, protocol: PROTOCOL_VERSION, socketPath } as RecorderDaemonStatus
  } catch {
    return { running: false, protocol: PROTOCOL_VERSION, socketPath }
  }
}

export async function sendRecorderDaemonHook(args: {
  workspace: string
  provider: ProviderId
  event: string
  payload: Record<string, unknown>
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}): Promise<Record<string, unknown>> {
  const socketPath = recorderSocketPath(args.workspace, args.env)
  const response = await daemonRequest(socketPath, {
    method: 'POST',
    path: '/v1/hook',
    timeoutMs: args.timeoutMs ?? 5_000,
    headers: {
      'x-scry-protocol': PROTOCOL_VERSION,
      'x-scry-provider': args.provider,
      'x-scry-event': args.event
    },
    body: JSON.stringify(args.payload)
  })
  if (response.statusCode < 200 || response.statusCode >= 300 || response.body.ok !== true) {
    throw new Error(`recorder daemon rejected hook (${response.statusCode}): ${String(response.body.error ?? 'missing ACK')}`)
  }
  return response.body
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
  const lockPath = join(dirname(socketPath), 'locks', 'daemon-start.lock')
  return withDirectoryLock(lockPath, async () => {
    const existing = await recorderDaemonStatus(enablement.workspaceRoot, env)
    if (existing.running && existing.recorderVersion === RECORDER_VERSION) return { started: false, status: existing }
    if (existing.running) {
      await stopRecorderDaemon(enablement.workspaceRoot, env)
      if (!await waitForSocketRelease(socketPath, 1_000)) throw new Error('previous recorder daemon did not stop within 1000ms')
    }
    const markerPath = startingPath(socketPath)
    const marker = await readJson<{ pid?: number; createdAt?: number }>(markerPath)
    if (processAlive(marker?.pid) && Date.now() - (marker?.createdAt ?? 0) <= STARTING_TTL_MS) {
      if (args.waitForReady === false) {
        return { started: false, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
      }
      const status = await waitForDaemon(enablement.workspaceRoot, env, 2_000)
      if (status) return { started: false, status }
      throw new Error('recorder daemon is still starting')
    }
    const markerPid = marker?.pid
    if (markerPid && processAlive(markerPid)) {
      try { process.kill(markerPid, 'SIGTERM') } catch {}
    }
    await rm(markerPath, { force: true })
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, [args.scriptPath, 'recorder', 'serve', '--workspace', enablement.workspaceRoot, '--socket', socketPath], {
      cwd: enablement.workspaceRoot,
      detached: true,
      env: { ...env, SCRY_RECORDER_SOCKET: socketPath },
      stdio: 'ignore'
    })
    if (child.pid) await writeJsonAtomic(markerPath, { pid: child.pid, createdAt: Date.now() }, { sync: false })
    child.unref()
    if (args.waitForReady === false) {
      return { started: true, status: { running: false, protocol: PROTOCOL_VERSION, socketPath } }
    }
    const status = await waitForDaemon(enablement.workspaceRoot, env, 2_000)
    if (!status) throw new Error('recorder daemon did not become ready within 2000ms')
    return { started: true, status }
  }, { waitMs: 3_000 })
}

export async function stopRecorderDaemon(workspace: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const socketPath = recorderSocketPath(workspace, env)
  try {
    const response = await daemonRequest(socketPath, { method: 'POST', path: '/v1/stop', timeoutMs: 1_000 })
    return response.statusCode === 200 && response.body.ok === true
  } catch {
    const markerPath = startingPath(socketPath)
    const marker = await readJson<{ pid?: number }>(markerPath)
    const markerPid = marker?.pid
    if (!markerPid || !processAlive(markerPid)) return false
    try { process.kill(markerPid, 'SIGTERM') } catch { return false }
    await rm(markerPath, { force: true })
    return true
  }
}

export async function listenRecorderDaemon(args: {
  workspace: string
  socketPath?: string
  idleMs?: number
  env?: NodeJS.ProcessEnv
}): Promise<RecorderDaemonHandle> {
  const env = args.env ?? process.env
  const enablement = await recorderEnablement(args.workspace, env)
  if (!enablement.enabled) throw new Error(`recorder is disabled: ${enablement.reason}`)
  const socketPath = args.socketPath ?? recorderSocketPath(enablement.workspaceRoot, env)
  const idleMs = args.idleMs ?? positiveInt(env.SCRY_RECORDER_IDLE_MS, DEFAULT_IDLE_MS, 1_000, MAX_IDLE_MS)
  const startedAt = new Date().toISOString()
  const daemonLog = join(dirname(socketPath), 'logs', 'daemon.log')
  let requestCount = 0
  let errorCount = 0
  let lastRequestAt: string | undefined
  let idleTimer: NodeJS.Timeout | undefined
  let closing: Promise<void> | undefined

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  try {
    await daemonRequest(socketPath, { method: 'GET', path: '/v1/status', timeoutMs: 250 })
    throw new Error(`recorder daemon socket is already active: ${socketPath}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('recorder daemon socket is already active:')) throw error
  }
  await rm(socketPath, { force: true })

  const server: Server = createServer(async (request, response) => {
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
      const payload = await readJsonBody(request)
      const result = await handleRecorderHook({ provider, event, workspace: enablement.workspaceRoot, payload, env })
      writeJson(response, 200, { ok: true, status: result.status })
    } catch (error) {
      errorCount++
      const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500
      const message = error instanceof Error ? error.message : String(error)
      await appendRotatingLog(daemonLog, `${new Date().toISOString()} ERROR ${message}`).catch(() => undefined)
      if (!response.headersSent) writeJson(response, statusCode, { ok: false, error: message })
      else response.end()
    } finally {
      if (!closing) idleTimer = setTimeout(() => void close(), idleMs)
    }
  })

  const closed = new Promise<void>((resolvePromise) => server.once('close', resolvePromise))
  const close = async (): Promise<void> => {
    if (closing) return closing
    closing = new Promise<void>((resolvePromise) => {
      if (idleTimer) clearTimeout(idleTimer)
      server.close(() => resolvePromise())
    }).finally(async () => {
      await rm(socketPath, { force: true }).catch(() => undefined)
    })
    return closing
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  await chmod(socketPath, 0o600)
  await rm(startingPath(socketPath), { force: true })
  idleTimer = setTimeout(() => void close(), idleMs)
  return { socketPath, closed, close }
}

export async function serveRecorderDaemon(args: {
  workspace: string
  socketPath?: string
  env?: NodeJS.ProcessEnv
}): Promise<void> {
  const handle = await listenRecorderDaemon(args)
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
