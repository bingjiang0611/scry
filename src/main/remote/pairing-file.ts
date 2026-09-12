import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { PairingPersistence, PairingState } from './pairing'

const MAX_BYTES = 2 * 1024 * 1024
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

// Private host-state storage, never a workspace-controlled path or IPC argument.
// Callers must hold one store per host and close the authority before closing
// this lease. Stale locks are NOT automatically removed: process-death/recovery
// policy needs a separate trusted local reconciliation, not a pid-only guess.
export class PairingFileStore implements PairingPersistence {
  private readonly directory: string
  private readonly file: string
  private readonly lock: string
  private readonly leaseFd: number
  private closed = false

  constructor(directory: string) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('pairing_directory_not_private')
    this.directory = realpathSync(directory)
    this.file = join(this.directory, 'pairing-state.json')
    this.lock = join(this.directory, 'pairing-state.lock')
    this.leaseFd = openSync(this.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(this.leaseFd, JSON.stringify({ pid: process.pid, lease: randomUUID(), createdAt: Date.now() }))
      fsyncSync(this.leaseFd)
      this.syncDirectory()
    } catch (error) {
      closeSync(this.leaseFd)
      unlinkSync(this.lock)
      throw error
    }
  }

  assertAvailable(): void { this.assertLease() }

  load(): unknown {
    this.assertLease()
    let fd: number
    try { fd = openSync(this.file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES) throw new Error('invalid_pairing_file')
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null)
        if (!count) break
        length += count
      }
      if (length > MAX_BYTES) throw new Error('pairing_file_too_large')
      const envelope: unknown = JSON.parse(bytes.toString('utf8', 0, length))
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid_pairing_file')
      const data = envelope as Record<string, unknown>
      if (Object.keys(data).sort().join(',') !== 'payload,sha256,version' || data.version !== 1 ||
          typeof data.payload !== 'string' || typeof data.sha256 !== 'string' || digest(data.payload) !== data.sha256) throw new Error('invalid_pairing_file')
      const state: unknown = JSON.parse(data.payload)
      // Reconcile the exact observed snapshot after an earlier process may have
      // lost the rename/fsync receipt. Never resurrect an older backup instead.
      fsyncSync(fd)
      this.syncDirectory()
      return state
    } finally { closeSync(fd) }
  }

  commit(state: PairingState): void {
    this.assertLease()
    const payload = JSON.stringify(state)
    const bytes = JSON.stringify({ version: 1, payload, sha256: digest(payload) })
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('pairing_file_too_large')
    const temp = join(this.directory, `.pairing-${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      this.assertLease()
      renameSync(temp, this.file)
      // Unlike preference catalogs, directory-fsync failure is not best-effort:
      // the caller must fence authority and report unknown/unavailable.
      this.syncDirectory()
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temp) } catch { /* Only this write's exclusive temp file. */ }
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.assertLease()
    this.closed = true
    closeSync(this.leaseFd)
    unlinkSync(this.lock)
    this.syncDirectory()
  }

  private assertLease(): void {
    if (this.closed) throw new Error('pairing_store_closed')
    const held = fstatSync(this.leaseFd)
    const current = lstatSync(this.lock)
    if (!current.isFile() || current.ino !== held.ino || current.dev !== held.dev) throw new Error('pairing_store_lease_lost')
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
