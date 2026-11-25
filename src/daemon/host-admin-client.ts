import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { BuildIdentity } from '../shared/build-identity'
import {
  CHALLENGE_FILE_PATTERN,
  HOST_ADMIN_DIR_NAME,
  HOST_ADMIN_SOCKET_NAME,
  type HostAdminReply
} from './host-admin-socket'

const MAX_REPLY_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export function readHostAdminChallengeFile(
  adminDir: string,
  fileName: string,
  options: { expectedUid?: number } = {}
): string {
  if (!CHALLENGE_FILE_PATTERN.test(fileName)) {
    throw new Error('host_admin_challenge_invalid')
  }
  const fullPath = join(adminDir, fileName)
  let fd: number
  try {
    fd = openSync(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP') throw new Error('host_admin_challenge_symlink')
    throw new Error('host_admin_challenge_unreadable')
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error('host_admin_challenge_not_file')
    const expectedUid = options.expectedUid ?? process.getuid?.()
    if (expectedUid !== undefined && stat.uid !== expectedUid) {
      throw new Error('host_admin_challenge_owner')
    }
    if ((stat.mode & 0o777) !== 0o600) {
      throw new Error('host_admin_challenge_mode')
    }
    if (stat.size === 0 || stat.size > 256) {
      throw new Error('host_admin_challenge_invalid')
    }
    return readFileSync(fd, 'utf8').trim()
  } finally {
    closeSync(fd)
  }
}

export interface CallHostAdminOptions {
  daemonStateDirectory: string
  clientIdentity: BuildIdentity
  method: string
  args?: Record<string, unknown>
  timeoutMs?: number
  expectedUid?: number
}

export function callHostAdmin(options: CallHostAdminOptions): Promise<HostAdminReply> {
  const adminDir = join(options.daemonStateDirectory, HOST_ADMIN_DIR_NAME)
  const socketPath = join(adminDir, HOST_ADMIN_SOCKET_NAME)
  return new Promise((resolve) => {
    let settled = false
    let stage: 'challenge' | 'reply' = 'challenge'
    let buffer = Buffer.alloc(0)
    const socket = createConnection(socketPath)

    const finish = (reply: HostAdminReply): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reply)
    }

    socket.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      finish({ ok: false, error: 'host_admin_timeout' })
    })

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        finish({ ok: false, error: 'daemon_not_running' })
        return
      }
      finish({ ok: false, error: 'host_admin_connect_failed' })
    })

    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ version: 1, client: options.clientIdentity })}\n`)
    })

    socket.on('data', (chunk: Buffer) => {
      if (buffer.length + chunk.length > MAX_REPLY_BYTES) {
        finish({ ok: false, error: 'host_admin_reply_too_large' })
        return
      }
      buffer = Buffer.concat([buffer, chunk])
      while (!settled) {
        const end = buffer.indexOf(10)
        if (end < 0) break
        const rawLine = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        let msg: Record<string, unknown>
        try { msg = JSON.parse(rawLine) as Record<string, unknown> } catch {
          finish({ ok: false, error: 'host_admin_invalid_reply' })
          return
        }
        if (stage === 'challenge') {
          if (msg.ok !== true || typeof msg.challenge !== 'string') {
            finish(msg as unknown as HostAdminReply)
            return
          }
          let token: string
          try {
            token = readHostAdminChallengeFile(adminDir, msg.challenge, {
              ...(options.expectedUid !== undefined ? { expectedUid: options.expectedUid } : {})
            })
          } catch (error) {
            finish({ ok: false, error: error instanceof Error ? error.message : 'host_admin_challenge_invalid' })
            return
          }
          stage = 'reply'
          socket.write(`${JSON.stringify({
            challenge: token,
            method: options.method,
            ...(options.args ? { args: options.args } : {})
          })}\n`)
          continue
        }
        finish(msg as unknown as HostAdminReply)
      }
    })

    socket.on('close', () => {
      finish({ ok: false, error: 'host_admin_closed' })
    })
  })
}
