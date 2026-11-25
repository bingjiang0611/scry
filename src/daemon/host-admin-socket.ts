import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { sameBuild, type BuildIdentity } from '../shared/build-identity'
import { trackConnections } from './socket-server-close'


export const HOST_ADMIN_DIR_NAME = 'host-admin'
export const HOST_ADMIN_SOCKET_NAME = 'host-admin.sock'
export const CHALLENGE_FILE_PATTERN = /^challenge-[0-9a-f]{32}$/
const MAX_SOCKET_PATH = 100
const MAX_FRAME_BYTES = 16_384
const SOCKET_TIMEOUT_MS = 10_000

export type HostAdminReply =
  | { ok: true; result: unknown }
  | {
    ok: false
    error: string
    daemon?: BuildIdentity
    retryAfterMs?: number
    nextAllowedAt?: number
  }

export interface HostAdminSocket {
  readonly directory: string
  readonly socketPath: string
  close(): Promise<void>
}

export interface HostAdminSocketOptions {
  daemonStateDirectory: string
  daemonIdentity: BuildIdentity
  handle(method: string, args: Record<string, unknown>): Promise<HostAdminReply>
}

const CHINESE_ERROR_MAP: ReadonlyArray<[string, string]> = [
  ['远程访问未启用', 'remote_host_disabled'],
  ['无效的配对确认参数', 'invalid_arguments'],
  ['无效的配对标识', 'invalid_arguments'],
  ['无效的设备标识', 'invalid_arguments'],
  ['这是本机 App 与后台服务的连接，不是已配对设备，不能在这里撤销', 'local_grant_not_revocable']
]

export function mapHostAdminError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  for (const [text, code] of CHINESE_ERROR_MAP) {
    if (message === text) return code
  }
  if (/^[a-z0-9_:-]{1,64}$/.test(message)) return message
  return 'host_admin_request_failed'
}

function parseBuildIdentity(raw: unknown): BuildIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (typeof value.version !== 'string' || value.version.length === 0 || value.version.length > 128) return null
  if (value.build !== undefined && (typeof value.build !== 'string' || value.build.length > 128)) return null
  return { version: value.version, ...(value.build !== undefined ? { build: value.build } : {}) }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function createChallengeFile(adminDir: string): { fileName: string; filePath: string; token: string } {
  const fileName = `challenge-${randomBytes(16).toString('hex')}`
  const filePath = join(adminDir, fileName)
  const token = randomBytes(32).toString('hex')
  const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    fchmodSync(fd, 0o600)
    writeSync(fd, token, 0, 'utf8')
  } finally {
    closeSync(fd)
  }
  return { fileName, filePath, token }
}

function timingSafeTokenEqual(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function openHostAdminSocket(options: HostAdminSocketOptions): Promise<HostAdminSocket> {
  mkdirSync(options.daemonStateDirectory, { recursive: true, mode: 0o700 })
  chmodSync(options.daemonStateDirectory, 0o700)
  const adminDir = join(options.daemonStateDirectory, HOST_ADMIN_DIR_NAME)
  mkdirSync(adminDir, { recursive: true, mode: 0o700 })
  const dirStat = lstatSync(adminDir)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error('host_admin_dir_invalid')
  }
  chmodSync(adminDir, 0o700)
  for (const entry of readdirSync(adminDir)) {
    if (CHALLENGE_FILE_PATTERN.test(entry)) rmSync(join(adminDir, entry), { force: true })
  }

  const socketPath = join(adminDir, HOST_ADMIN_SOCKET_NAME)
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error('host_admin_socket_path_too_long')
  }
  rmSync(socketPath, { force: true })

  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let stage: 'hello' | 'request' | 'done' = 'hello'
    let activeChallenge: { filePath: string; token: string } | null = null

    const cleanupChallenge = (): void => {
      if (!activeChallenge) return
      const path = activeChallenge.filePath
      activeChallenge = null
      try { rmSync(path, { force: true }) } catch {}
    }

    const replyAndClose = (payload: HostAdminReply): void => {
      stage = 'done'
      cleanupChallenge()
      try { socket.end(`${JSON.stringify(payload)}\n`) } catch { socket.destroy() }
    }

    socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
      cleanupChallenge()
      socket.destroy()
    })
    socket.on('error', () => { cleanupChallenge() })
    socket.on('close', () => { cleanupChallenge() })

    const handleLine = (rawLine: string): void => {
      let parsed: unknown
      try { parsed = JSON.parse(rawLine) } catch {
        replyAndClose({ ok: false, error: 'invalid_request' })
        return
      }
      if (!isPlainRecord(parsed)) {
        replyAndClose({ ok: false, error: 'invalid_request' })
        return
      }

      if (stage === 'hello') {
        if (parsed.version !== 1) {
          replyAndClose({ ok: false, error: 'invalid_request' })
          return
        }
        const client = parseBuildIdentity(parsed.client)
        if (!client) {
          replyAndClose({ ok: false, error: 'invalid_request' })
          return
        }
        if (!sameBuild(options.daemonIdentity, client)) {
          replyAndClose({ ok: false, error: 'daemon_version_mismatch', daemon: options.daemonIdentity })
          return
        }
        let challenge: { fileName: string; filePath: string; token: string }
        try {
          challenge = createChallengeFile(adminDir)
        } catch {
          replyAndClose({ ok: false, error: 'host_admin_challenge_create_failed' })
          return
        }
        activeChallenge = { filePath: challenge.filePath, token: challenge.token }
        stage = 'request'
        socket.write(`${JSON.stringify({ ok: true, challenge: challenge.fileName })}\n`)
        return
      }

      if (stage === 'request') {
        stage = 'done'
        const expectedToken = activeChallenge?.token
        cleanupChallenge()
        if (!expectedToken || !timingSafeTokenEqual(expectedToken, parsed.challenge)) {
          replyAndClose({ ok: false, error: 'host_admin_auth_failed' })
          return
        }
        const method = parsed.method
        if (typeof method !== 'string' || method.length === 0 || method.length > 64) {
          replyAndClose({ ok: false, error: 'invalid_request' })
          return
        }
        const args = parsed.args === undefined ? {} : parsed.args
        if (!isPlainRecord(args)) {
          replyAndClose({ ok: false, error: 'invalid_arguments' })
          return
        }
        void options.handle(method, args)
          .then((reply) => replyAndClose(reply))
          .catch((error) => replyAndClose({ ok: false, error: mapHostAdminError(error) }))
      }
    }

    socket.on('data', (bytes: Buffer) => {
      if (stage === 'done') { socket.destroy(); return }
      if (buffer.length + bytes.length > MAX_FRAME_BYTES) {
        cleanupChallenge()
        socket.destroy()
        return
      }
      buffer = Buffer.concat([buffer, bytes])
      while ((stage as string) !== 'done') {
        const end = buffer.indexOf(10)
        if (end < 0) break
        const line = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        handleLine(line)
      }
    })
  })

  const tracked = trackConnections(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    const previousUmask = process.umask(0o177)
    try {
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    } finally {
      process.umask(previousUmask)
    }
  })

  const sockStat = lstatSync(socketPath)
  const mode = sockStat.mode & 0o777
  if (!sockStat.isSocket() || mode !== 0o600) {
    await tracked.close()
    rmSync(socketPath, { force: true })
    throw new Error(`host_admin_socket_mode_${mode.toString(8)}`)
  }

  return {
    directory: adminDir,
    socketPath,
    close: async () => {
      const closing = tracked.close()
      rmSync(socketPath, { force: true })
      await closing
    }
  }
}
