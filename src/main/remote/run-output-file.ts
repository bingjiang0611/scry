import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync,
  readSync, realpathSync, unlinkSync, writeSync
} from 'node:fs'
import { join } from 'node:path'
import type { OutputChunk, RunOutputPage, RunOutputStore } from './run-output-log'

const INDEX_ENTRY_BYTES = 8
const MAX_STORED_LINE_BYTES = 64 * 1024
const MAX_PAGE_BYTES = 512 * 1024
const DEFAULT_PAGE = 200

function keyOf(runId: string): string {
  return createHash('sha256').update(runId).digest('hex')
}

function writeAll(fd: number, bytes: Buffer, position: number): void {
  let written = 0
  while (written < bytes.length) {
    const count = writeSync(fd, bytes, written, bytes.length - written, position + written)
    if (count === 0) throw new Error('output_store_write_stalled')
    written += count
  }
}

function readAll(fd: number, bytes: Buffer, position: number): void {
  let read = 0
  while (read < bytes.length) {
    const count = readSync(fd, bytes, read, bytes.length - read, position + read)
    if (count === 0) throw new Error('output_store_unexpected_eof')
    read += count
  }
}

function assertPrivateFile(fd: number): void {
  const info = fstatSync(fd)
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
    throw new Error('invalid_output_store_file')
  }
}

function indexEnd(fd: number, entry: number): number {
  if (entry < 1) return 0
  const bytes = Buffer.allocUnsafe(INDEX_ENTRY_BYTES)
  readAll(fd, bytes, (entry - 1) * INDEX_ENTRY_BYTES)
  const value = bytes.readBigUInt64BE()
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('output_store_offset_overflow')
  return Number(value)
}

export class RunOutputFileStore implements RunOutputStore {
  readonly #directory: string
  readonly #lock: string
  readonly #leaseFd: number
  #closed = false

  constructor(directory: string) {
    const info = lstatSync(directory)
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new Error('output_directory_not_private')
    this.#directory = realpathSync(directory)
    this.#lock = join(this.#directory, 'run-output.lock')
    this.#leaseFd = openSync(
      this.#lock,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      writeSync(this.#leaseFd, JSON.stringify({ pid: process.pid, lease: randomUUID(), createdAt: Date.now() }))
      fsyncSync(this.#leaseFd)
      this.#syncDirectory()
    } catch (error) {
      closeSync(this.#leaseFd)
      unlinkSync(this.#lock)
      throw error
    }
  }

  append(input: Omit<OutputChunk, 'seq'>): OutputChunk {
    return this.appendBatch([input])[0]
  }

  appendBatch(inputs: Array<Omit<OutputChunk, 'seq'>>): OutputChunk[] {
    this.#assertLease()
    if (inputs.length === 0) return []
    const runId = inputs[0].runId
    for (const input of inputs) {
      if (!input.runId || input.runId !== runId || input.runId.length > 128 || !Number.isFinite(input.at) || typeof input.text !== 'string') {
        throw new Error('invalid_output_chunk')
      }
      if (!['output', 'reasoning', 'tool', 'tool_result', 'truncated'].includes(input.kind)) throw new Error('invalid_output_chunk')
    }
    const key = keyOf(runId)
    const dataPath = join(this.#directory, `${key}.jsonl`)
    const indexPath = join(this.#directory, `${key}.idx`)
    const dataFd = openSync(dataPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    let indexFd: number
    try {
      indexFd = openSync(indexPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      closeSync(dataFd)
      throw error
    }
    try {
      assertPrivateFile(dataFd)
      assertPrivateFile(indexFd)
      const indexInfo = fstatSync(indexFd)
      const committedIndexBytes = Math.floor(indexInfo.size / INDEX_ENTRY_BYTES) * INDEX_ENTRY_BYTES
      if (indexInfo.size !== committedIndexBytes) {
        ftruncateSync(indexFd, committedIndexBytes)
        fsyncSync(indexFd)
      }
      const count = committedIndexBytes / INDEX_ENTRY_BYTES
      const committedEnd = indexEnd(indexFd, count)
      const dataInfo = fstatSync(dataFd)
      if (committedEnd > dataInfo.size) throw new Error('output_store_index_ahead_of_data')
      if (dataInfo.size !== committedEnd) {
        ftruncateSync(dataFd, committedEnd)
        fsyncSync(dataFd)
      }
      const events = inputs.map((input, index): OutputChunk => ({ ...input, seq: count + index + 1 }))
      const lines = events.map((event) => Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))
      if (lines.some((line) => line.length > MAX_STORED_LINE_BYTES)) throw new Error('output_store_record_too_large')
      writeAll(dataFd, Buffer.concat(lines), committedEnd)
      fsyncSync(dataFd)
      const ends = Buffer.allocUnsafe(INDEX_ENTRY_BYTES * lines.length)
      let endOffset = committedEnd
      for (let index = 0; index < lines.length; index++) {
        endOffset += lines[index].length
        ends.writeBigUInt64BE(BigInt(endOffset), index * INDEX_ENTRY_BYTES)
      }
      writeAll(indexFd, ends, committedIndexBytes)
      fsyncSync(indexFd)
      this.#syncDirectory()
      return events
    } finally {
      closeSync(indexFd)
      closeSync(dataFd)
    }
  }

  since(runId: string, cursor: number, pageSize = DEFAULT_PAGE): RunOutputPage {
    this.#assertLease()
    const start = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
    const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, DEFAULT_PAGE) : DEFAULT_PAGE
    const key = keyOf(runId)
    let indexFd: number
    try {
      indexFd = openSync(join(this.#directory, `${key}.idx`), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        const data = lstatSync(join(this.#directory, `${key}.jsonl`))
        if (data) throw new Error('output_store_pair_incomplete')
      } catch (dataError) {
        if ((dataError as NodeJS.ErrnoException).code !== 'ENOENT') throw dataError
      }
      return { chunks: [], cursor: start }
    }
    let dataFd: number
    try {
      dataFd = openSync(join(this.#directory, `${key}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      closeSync(indexFd)
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('output_store_pair_incomplete')
      throw error
    }
    try {
      assertPrivateFile(indexFd)
      assertPrivateFile(dataFd)
      const indexInfo = fstatSync(indexFd)
      const count = Math.floor(indexInfo.size / INDEX_ENTRY_BYTES)
      if (start >= count) return { chunks: [], cursor: start }
      const chunks: OutputChunk[] = []
      let bytes = 0
      let previousEnd = indexEnd(indexFd, start)
      for (let seq = start + 1; seq <= count && chunks.length < size; seq++) {
        const end = indexEnd(indexFd, seq)
        const length = end - previousEnd
        if (length < 2 || length > MAX_STORED_LINE_BYTES || bytes + length > MAX_PAGE_BYTES && chunks.length > 0) break
        const line = Buffer.allocUnsafe(length)
        readAll(dataFd, line, previousEnd)
        if (line[line.length - 1] !== 0x0a) throw new Error('output_store_record_incomplete')
        let event: OutputChunk
        try { event = JSON.parse(line.toString('utf8', 0, line.length - 1)) as OutputChunk }
        catch { throw new Error('output_store_record_corrupt') }
        if (event.seq !== seq || event.runId !== runId || !['output', 'reasoning', 'tool', 'tool_result', 'truncated'].includes(event.kind) || typeof event.text !== 'string') {
          throw new Error('output_store_record_corrupt')
        }
        chunks.push(event)
        bytes += length
        previousEnd = end
      }
      return { chunks, cursor: chunks.at(-1)?.seq ?? start }
    } finally {
      closeSync(dataFd)
      closeSync(indexFd)
    }
  }

  close(): void {
    if (this.#closed) return
    this.#assertLease()
    this.#closed = true
    closeSync(this.#leaseFd)
    unlinkSync(this.#lock)
    this.#syncDirectory()
  }

  #assertLease(): void {
    if (this.#closed) throw new Error('output_store_closed')
    const held = fstatSync(this.#leaseFd)
    const current = lstatSync(this.#lock)
    if (!current.isFile() || current.ino !== held.ino || current.dev !== held.dev) throw new Error('output_store_lease_lost')
  }

  #syncDirectory(): void {
    const fd = openSync(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(fd) } finally { closeSync(fd) }
  }
}
