import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { LedgerEvent, LedgerRecovery, LedgerSnapshot, LedgerStore } from './session-ledger'

const MAX_BYTES = 8 * 1024 * 1024
const COMPACT_AT_BYTES = 6 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024

interface SnapshotEnvelope {
  version: 1
  checksum: string
  snapshot: LedgerSnapshot
}

// Durable JSONL tail plus an atomic state checkpoint. The checkpoint is
// committed and directory-fsynced before the old tail is replaced, so every
// crash point recovers either the old log or checkpoint + filtered/new tail.
export class SessionLedgerFileStore implements LedgerStore {
  private readonly directory: string
  private readonly file: string
  private readonly snapshotFile: string
  private readonly lock: string
  private readonly leaseFd: number
  private closed = false

  constructor(directory: string) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('ledger_directory_not_private')
    this.directory = realpathSync(directory)
    this.file = join(this.directory, 'session-ledger.log')
    this.snapshotFile = join(this.directory, 'session-ledger.snapshot.json')
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

  loadRecovery(): LedgerRecovery {
    this.assertLease()
    const snapshot = this.loadSnapshot()
    const events = this.loadAll().filter((event) => !snapshot || event.seq > snapshot.lastSeq)
    return { ...(snapshot ? { snapshot } : {}), events }
  }

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
        committedLength = bytes.lastIndexOf(0x0a, length - 1) + 1
        ftruncateSync(fd, committedLength)
      }
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

  shouldCompact(nextEvent: LedgerEvent): boolean {
    this.assertLease()
    const nextBytes = Buffer.byteLength(JSON.stringify(nextEvent)) + 1
    try {
      const info = lstatSync(this.file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid_ledger_file')
      return info.size + nextBytes > COMPACT_AT_BYTES
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  compact(snapshot: LedgerSnapshot): void {
    this.assertLease()
    const snapshotContent = JSON.stringify(snapshot)
    const envelope: SnapshotEnvelope = {
      version: 1,
      checksum: createHash('sha256').update(snapshotContent).digest('hex'),
      snapshot
    }
    const content = `${JSON.stringify(envelope)}\n`
    if (Buffer.byteLength(content) > MAX_SNAPSHOT_BYTES) throw new Error('ledger_snapshot_too_large')
    // Commit the checkpoint first. If replacing the tail is interrupted, loadRecovery
    // ignores its events through snapshot.lastSeq and applies only a newer suffix.
    this.writeAtomic(this.snapshotFile, content)
    this.writeAtomic(this.file, '')
  }

  append(event: LedgerEvent): void {
    this.assertLease()
    const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8')
    if (line.length > MAX_BYTES) throw new Error('ledger_file_too_large')
    const fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('invalid_ledger_file')
      if (info.size + line.length > MAX_BYTES) throw new Error('ledger_file_too_large')
      let offset = 0
      while (offset < line.length) {
        const written = writeSync(fd, line, offset, line.length - offset)
        if (written === 0) throw new Error('ledger_write_stalled')
        offset += written
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
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

  private loadSnapshot(): LedgerSnapshot | undefined {
    if (!existsSync(this.snapshotFile)) return undefined
    const info = lstatSync(this.snapshotFile)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('invalid_ledger_snapshot')
    if (info.size <= 0 || info.size > MAX_SNAPSHOT_BYTES) throw new Error('ledger_snapshot_too_large')
    let envelope: SnapshotEnvelope
    try { envelope = JSON.parse(readFileSync(this.snapshotFile, 'utf8')) as SnapshotEnvelope }
    catch { throw new Error('ledger_snapshot_corrupt') }
    if (!envelope || envelope.version !== 1 || typeof envelope.checksum !== 'string' || !envelope.snapshot) throw new Error('ledger_snapshot_corrupt')
    const checksum = createHash('sha256').update(JSON.stringify(envelope.snapshot)).digest('hex')
    if (checksum !== envelope.checksum) throw new Error('ledger_snapshot_corrupt')
    return envelope.snapshot
  }

  private writeAtomic(path: string, content: string): void {
    const tmp = `${path}.tmp`
    try { unlinkSync(tmp) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let fd: number | undefined
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(fd, content)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmp, path)
      this.syncDirectory()
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(tmp) } catch { /* preserve the original failure */ }
      throw error
    }
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
