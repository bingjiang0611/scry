import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, unlinkSync
} from 'node:fs'
import { join } from 'node:path'

const MAX_LEASE_BYTES = 4096
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function syncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

// Trusted startup reconciliation only, not a store's implicit lock-stealing policy.
// A live/reused PID, EPERM, malformed owner, or interrupted recovery fails closed.
// Never infer process death from age, silence, or an unresponsive Provider.
export function recoverDeadRemoteLease(directory: string, name: 'pairing-state.lock' | 'session-ledger.lock' | 'run-output.lock'): void {
  const directoryInfo = lstatSync(directory)
  if (!directoryInfo.isDirectory() || (directoryInfo.mode & 0o777) !== 0o700) {
    throw new Error('remote_lease_directory_not_private')
  }
  const root = realpathSync(directory)
  const path = join(root, name)
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const held = fstatSync(fd)
    if (!held.isFile() || held.nlink !== 1 || (held.mode & 0o777) !== 0o600 || held.size > MAX_LEASE_BYTES) {
      throw new Error('remote_lease_invalid_file')
    }
    const bytes = Buffer.alloc(held.size)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length)
      if (!count) throw new Error('remote_lease_incomplete')
      length += count
    }
    let parsed: unknown
    try { parsed = JSON.parse(bytes.toString('utf8')) }
    catch { throw new Error('remote_lease_invalid_owner') }
    const owner = parsed as { pid?: unknown; lease?: unknown; createdAt?: unknown } | null
    if (!owner || !Number.isSafeInteger(owner.pid) || typeof owner.pid !== 'number' || owner.pid <= 0 ||
      typeof owner.lease !== 'string' || !UUID.test(owner.lease) ||
      typeof owner.createdAt !== 'number' || !Number.isFinite(owner.createdAt)) {
      throw new Error('remote_lease_invalid_owner')
    }
    try {
      process.kill(owner.pid, 0)
      throw new Error('remote_lease_owner_alive')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }

    // One permanent claim per old lease prevents two cooperative recoverers from
    // unlinking a successor's lock between identity-check and unlink. Do not remove
    // this fence on error: a crash here needs explicit local reconciliation.
    const claim = join(root, `.recovered-${name}-${owner.lease}`)
    mkdirSync(claim, { mode: 0o700 })
    linkSync(path, join(claim, 'owner.json'))
    const evidence = lstatSync(join(claim, 'owner.json'))
    const current = lstatSync(path)
    if (current.dev !== held.dev || current.ino !== held.ino || evidence.dev !== held.dev || evidence.ino !== held.ino ||
      current.size !== held.size || current.mtimeMs !== held.mtimeMs) {
      throw new Error('remote_lease_identity_changed')
    }
    // Retain the exact old owner as durable evidence before removing its active name.
    fsyncSync(fd)
    syncDirectory(claim)
    syncDirectory(root)
    unlinkSync(path)
    syncDirectory(root)
  } finally { closeSync(fd) }
}
