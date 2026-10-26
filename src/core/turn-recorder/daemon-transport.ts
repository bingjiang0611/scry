import { encodeHookEnvironment, decodeHookEnvironment } from './commit-environment.js'
import { createHash } from 'node:crypto'
import { type ServerResponse, type IncomingMessage, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve, join } from 'node:path'
import { type ProviderId } from '../../shared/provider.js'


export const PROTOCOL_VERSION = '2'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_SOCKET_BYTES = 100

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

interface DaemonRequestResult {
  statusCode: number
  body: Record<string, unknown>
}

export function recorderSocketPath(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCRY_RECORDER_SOCKET?.trim()
  const socketPath = configured
    ? (isAbsolute(configured) ? configured : resolve(workspace, configured))
    : join(resolve(workspace), '.scry', 'recorder-v1.sock')
  if (Buffer.byteLength(socketPath) <= MAX_SOCKET_BYTES) return socketPath
  // Hash the requested endpoint, not just cwd: explicit endpoints in one workspace stay distinct.
  // A long TMPDIR must not recreate the original sockaddr_un overflow.
  const digest = createHash('sha256').update(`${resolve(workspace)}\0${socketPath}`).digest('hex').slice(0, 32)
  const name = `scry-${process.getuid?.() ?? 'user'}-${digest}.sock`
  const temporaryPath = join(tmpdir(), name)
  return Buffer.byteLength(temporaryPath) <= MAX_SOCKET_BYTES ? temporaryPath : join('/tmp', name)
}

export function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

export async function readJsonBody(request: IncomingMessage): Promise<{ env: NodeJS.ProcessEnv; payload: Record<string, unknown> }> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += bytes.length
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('request body exceeds 8 MiB'), { statusCode: 413 })
    chunks.push(bytes)
  }
  let value: unknown
  let environment: NodeJS.ProcessEnv
  try {
    const envelope = decodeHookEnvironment(Buffer.concat(chunks).toString('utf8'))
    environment = envelope.env
    value = JSON.parse(envelope.payload) as unknown
  } catch {
    throw Object.assign(new Error('hook payload must be valid JSON'), { statusCode: 400 })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('hook payload must be a JSON object'), { statusCode: 400 })
  }
  return { env: environment, payload: value as Record<string, unknown> }
}

export function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

export async function daemonRequest(
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
      'x-scry-event': args.event,
      'content-type': 'application/octet-stream'
    },
    body: encodeHookEnvironment(args.env ?? process.env, args.payload)
  })
  if (response.statusCode < 200 || response.statusCode >= 300 || response.body.ok !== true) {
    throw new Error(`recorder daemon rejected hook (${response.statusCode}): ${String(response.body.error ?? 'missing ACK')}`)
  }
  return response.body
}
