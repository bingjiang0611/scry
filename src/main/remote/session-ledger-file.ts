import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readSync, realpathSync, unlinkSync, writeSync
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LedgerEvent, LedgerStore } from './session-ledger'

const MAX_BYTES = 8 * 1024 * 1024

// Durable append-only log for the session ledger, one JSON event per line.
// Same isolation contract as PairingFileStore: private 0700 dir, 0600 file, an
// exclusive lock lease, and directory fsync treated as authoritative (its
// failure is not best-effort). Append returns only after the record and its
// newline are fsynced, so a torn trailing line is an append the caller was
// never told succeeded and is dropped on load; any non-final unparseable line
// means real corruption and fails closed.
export class SessionLedgerFileStore implements LedgerStore {
  private readonly directory: string
  private readonly file: string
  private readonly lock: string
  private readonly leaseFd: number
  private closed = false

  constructor(directory: string) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('ledger_directory_not_private')
    this.directory = realpathSync(directory)
    this.file = join(this.directory, 'session-ledger.log')
    this.lock = join(this.directory, 'session-ledger.lock')
    this.leaseFd = openSync(this.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(this.leaseFd, JSON.stringify({ pid: process.pid, lease: randomUUID(), createdAt: Date.now() }))
      fsyncSync(this.leaseFd)
      this.syncDirectory()
    } catch (error) {
      closeSync(this.leaseFd)
      unlinkSync(this.lock)
      throw error
    }
  }

  assertAvailable(): void { this.assertLease() }

  loadAll(): LedgerEvent[] {
    this.assertLease()
    let fd: number
    try { fd = openSync(this.file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('invalid_ledger_file')
      if (info.size > MAX_BYTES) throw new Error('ledger_file_too_large')
      const bytes = Buffer.alloc(info.size)
      let length = 0
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null)
        if (!count) break
        length += count
      }
      const complete = length === 0 || bytes[length - 1] === 0x0a
      let committedLength = length
      if (!complete) {
        // Recovery is durable, not merely an in-memory omission. If the torn
        // bytes remained on disk, the next O_APPEND would concatenate a valid
        // event onto the fragment and turn a recoverable crash into permanent
        // corruption. Keep only bytes through the last committed newline.
        committedLength = bytes.lastIndexOf(0x0a, length - 1) + 1
        ftruncateSync(fd, committedLength)
      }
      // Reconcile the exact persisted bytes after a possible lost receipt or
      // tail repair before accepting another append.
      fsyncSync(fd)
      this.syncDirectory()
      if (committedLength === 0) return []
      const lines = bytes.toString('utf8', 0, committedLength).split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      const events: LedgerEvent[] = []
      for (const line of lines) {
        try { events.push(JSON.parse(line) as LedgerEvent) }
        catch { throw new Error('ledger_file_corrupt') }
      }
      return events
    } finally { closeSync(fd) }
  }

  append(event: LedgerEvent): void {
    this.assertLease()
    const line = JSON.stringify(event) + '\n'
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error('ledger_file_too_large')
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, line)
      fsyncSync(fd)
    } finally { closeSync(fd) }
    // The appended record's containing directory metadata must also be durable.
    this.syncDirectory()
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
    if (this.closed) throw new Error('ledger_store_closed')
    const held = fstatSync(this.leaseFd)
    const current = lstatSync(this.lock)
    if (!current.isFile() || current.ino !== held.ino || current.dev !== held.dev) throw new Error('ledger_store_lease_lost')
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
