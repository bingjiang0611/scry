import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { TerminalExitEvent, TerminalRecordingPage, TerminalRecordingRequest, TerminalSessionInfo } from '../shared/terminal'

interface Recording {
  version: 1
  id: string
  cwd: string
  bytes: number
  state: TerminalRecordingPage['state']
  exit?: TerminalExitEvent
}
interface Writer {
  fd: number
  record: Recording
  written: number
  timer?: ReturnType<typeof setTimeout>
  failed: boolean
}
const PAGE_BYTES = 64 * 1024
const MAX_PAGE_BYTES = 256 * 1024
const ID = /^terminal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function privateFile(fd: number): void {
  const info = fstatSync(fd)
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('terminal_recording_unsafe_file')
}

// A recording is the exact JS text exposed by node-pty, not the original undecoded PTY byte stream.
// UTF-16LE retains even surrogate pairs split across callbacks. Byte cursors are always even.
// Only fsynced bytes published in metadata are replayable; an open checkpoint after restart is partial.
export class TerminalRecordingStore {
  private readonly writers = new Map<string, Writer>()
  constructor(private readonly directory: string, private readonly onFailure: (id: string, error: unknown) => void) {}

  start(info: TerminalSessionInfo): void {
    this.assertId(info.id)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.assertDirectory()
    const fd = openSync(this.path(info.id, 'bin'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const record: Recording = { version: 1, id: info.id, cwd: info.cwd, bytes: 0, state: 'recording' }
    try {
      fsyncSync(fd)
      this.publish(record, true)
      this.writers.set(info.id, { fd, record, written: 0, failed: false })
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  append(id: string, data: string): void {
    const writer = this.writers.get(id)
    if (!writer || writer.failed || !data) return
    try {
      const bytes = Buffer.from(data, 'utf16le')
      let written = 0
      while (written < bytes.length) {
        const count = writeSync(writer.fd, bytes, written, bytes.length - written, writer.written + written)
        if (!count) throw new Error('terminal_recording_write_stalled')
        written += count
      }
      writer.written += written
      // No growing in-memory queue or fsync per token. This schedules a checkpoint,
      // not a durability deadline; a cold restart may lose the uncheckpointed tail.
      if (!writer.timer) {
        writer.timer = setTimeout(() => this.checkpoint(id), 50)
        writer.timer.unref()
      }
    } catch (error) { this.fail(id, writer, error) }
  }

  finish(event: TerminalExitEvent): void {
    const writer = this.writers.get(event.id)
    if (!writer) return
    this.checkpoint(event.id, event)
    this.writers.delete(event.id)
    if (!writer.failed) {
      try { closeSync(writer.fd) } catch (error) { this.onFailure(event.id, error) }
    }
  }

  read(request: TerminalRecordingRequest, cwd: string): TerminalRecordingPage {
    this.assertId(request?.id)
    const limit = request.limit ?? PAGE_BYTES
    if (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset % 2 ||
      !Number.isSafeInteger(limit) || limit < 4 || limit > MAX_PAGE_BYTES || limit % 2) {
      throw new Error('terminal_recording_invalid_cursor')
    }
    // Authorization precedes checkpoint writes too, not just reading the body.
    let record = this.authorized(request.id, cwd)
    if (this.writers.has(request.id)) {
      this.checkpoint(request.id)
      record = this.authorized(request.id, cwd)
    }
    if (request.offset > record.bytes) throw new Error('terminal_recording_invalid_cursor')
    const fd = openSync(this.path(request.id, 'bin'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      privateFile(fd)
      const size = fstatSync(fd).size
      if (size < record.bytes || (record.state === 'complete' && size !== record.bytes)) throw new Error('terminal_recording_incomplete_file')
      const data = Buffer.alloc(Math.min(limit, record.bytes - request.offset))
      let read = 0
      while (read < data.length) {
        const count = readSync(fd, data, read, data.length - read, request.offset + read)
        if (!count) throw new Error('terminal_recording_unexpected_eof')
        read += count
      }
      if (read >= 2 && request.offset + read < record.bytes) {
        const last = data.readUInt16LE(read - 2)
        if (last >= 0xd800 && last <= 0xdbff) read -= 2
      }
      const nextOffset = request.offset + read
      return {
        id: request.id, encoding: 'utf16le', data: data.toString('utf16le', 0, read), offset: request.offset,
        nextOffset, totalBytes: record.bytes, hasMore: nextOffset < record.bytes,
        state: record.state === 'recording' && !this.writers.has(request.id) ? 'interrupted' : record.state,
        ...(record.exit ? { exit: record.exit } : {})
      }
    } finally { closeSync(fd) }
  }

  delete(id: string, cwd: string): void {
    this.assertId(id)
    if (this.writers.has(id)) throw new Error('terminal_recording_still_active')
    this.authorized(id, cwd)
    for (const extension of ['bin', 'json']) {
      try { unlinkSync(this.path(id, extension)) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    this.syncDirectory()
  }

  private checkpoint(id: string, exit?: TerminalExitEvent): void {
    const writer = this.writers.get(id)
    if (!writer || writer.failed) return
    clearTimeout(writer.timer)
    writer.timer = undefined
    try {
      fsyncSync(writer.fd)
      const record: Recording = { ...writer.record, bytes: writer.written,
        ...(exit ? { exit, state: exit.code === null && exit.signal === null ? 'interrupted' as const : 'complete' as const } : {}) }
      this.publish(record)
      writer.record = record
    } catch (error) { this.fail(id, writer, error) }
  }

  private fail(id: string, writer: Writer, error: unknown): void {
    if (writer.failed) return
    writer.failed = true
    clearTimeout(writer.timer)
    writer.record = { ...writer.record, state: 'failed' }
    // Do not retry uncertain body writes. If the failure marker cannot be saved, cold reads
    // see the last visible checkpoint: an open prefix, or synced exit data if rename already ran.
    try { this.publish(writer.record) } catch { /* live notification remains the failure evidence */ }
    try { closeSync(writer.fd) } catch { /* never retry a close with uncertain descriptor ownership */ }
    this.onFailure(id, error)
  }

  private authorized(id: string, cwd: string): Recording {
    this.assertDirectory()
    const fd = openSync(this.path(id, 'json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      privateFile(fd)
      if (fstatSync(fd).size > 16 * 1024) throw new Error('terminal_recording_invalid_metadata')
      const record = JSON.parse(readFileSync(fd, 'utf8')) as Recording
      if (!record || record.version !== 1 || record.id !== id || typeof record.cwd !== 'string' ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes % 2 ||
        !['recording', 'complete', 'interrupted', 'failed'].includes(record.state)) throw new Error('terminal_recording_invalid_metadata')
      if ((record.state === 'complete' && !record.exit) || (record.exit &&
        (record.exit.id !== id || (record.exit.code !== null && !Number.isInteger(record.exit.code)) ||
          (record.exit.signal !== null && !Number.isInteger(record.exit.signal))))) throw new Error('terminal_recording_invalid_metadata')
      if (record.cwd !== cwd) throw new Error('terminal_recording_workspace_mismatch')
      return this.writers.get(id)?.failed ? { ...record, state: 'failed' } : record
    } finally { closeSync(fd) }
  }

  private publish(record: Recording, exclusive = false): void {
    const path = this.path(record.id, 'json')
    const target = exclusive ? path : `${path}.${randomUUID()}.tmp`
    const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeFileSync(fd, JSON.stringify(record))
      fsyncSync(fd)
    } finally { closeSync(fd) }
    try {
      if (!exclusive) renameSync(target, path)
      this.syncDirectory()
    } finally {
      if (!exclusive) {
        try { unlinkSync(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
    }
  }

  private assertId(id: string): void {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('terminal_recording_invalid_id')
  }
  private path(id: string, extension: string): string { return join(this.directory, `${id}.${extension}`) }
  private assertDirectory(): void {
    const info = lstatSync(this.directory)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('terminal_recording_unsafe_directory')
  }
  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
