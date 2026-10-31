import { createHash } from 'node:crypto'
import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Utf8ChunkNormalizer } from './utf8-chunks'

/**
 * Append-only text buffer whose resident memory is bounded.
 *
 * A single visible message may be hundreds of MiB, and its bytes are only needed in
 * order, once. Below the memory budget the text stays in memory; beyond it the spool
 * moves to a private temporary file so a huge message never becomes one JavaScript
 * string. The spool is deleted by `discard`, and callers always discard in `finally`.
 *
 * Two byte-level rules live here because both storage forms are append-only:
 * a code point split across `push` calls is held until complete, so memory and disk
 * always hold the same text as one concatenated string; and every write goes to an
 * explicit offset, so a reset that truncates the file cannot continue at the old one.
 */
/** One memory allowance shared by every spool of a capture pass. */
export interface SpoolBudget {
  available: number
}

export class TextSpool {
  private chunks: string[] = []
  /** Bytes currently charged to the shared budget. */
  private charged = 0
  private bytes = 0
  /** Bytes written to the spill file; also the offset of the next write. */
  private offset = 0
  private readonly normalizer = new Utf8ChunkNormalizer()
  private spilled?: { directory: string; path: string; handle: FileHandle }

  constructor(private readonly memoryBytes = 256 * 1024, private readonly budget?: SpoolBudget) {}

  /**
   * Complete bytes pushed so far, including a held high surrogate.
   *
   * The held unit is charged the way the platform encodes a lone surrogate, so a size
   * read before `flush` cannot under-report what the finished content will occupy.
   */
  get size(): number {
    return this.bytes + Buffer.byteLength(this.normalizer.pending(), 'utf8')
  }

  get spilledToDisk(): boolean {
    return this.spilled !== undefined
  }

  async push(chunk: string): Promise<void> {
    const text = this.normalizer.push(chunk)
    if (text.length === 0) return
    await this.accept(text)
  }

  /**
   * Emits a held high surrogate as its own unit.
   *
   * Only a genuine lone surrogate reaches this point, and it stays exactly one code
   * unit: dropping it would corrupt the content. `read` and `digest` call this because
   * they finish the content; a caller that keeps pushing afterwards starts a new run.
   */
  async flush(): Promise<void> {
    const tail = this.normalizer.flush()
    if (tail.length === 0) return
    await this.accept(tail)
  }

  private async accept(chunk: string): Promise<void> {
    const bytes = Buffer.byteLength(chunk, 'utf8')
    this.bytes += bytes
    if (!this.spilled && this.bytes <= this.capacity()) {
      this.chunks.push(chunk)
      this.charge(bytes)
      return
    }
    const file = this.spilled ?? await this.spill()
    await this.write(file, chunk, bytes)
  }

  /** Resident bytes allowed for this spool: its own bound, plus the shared allowance. */
  private capacity(): number {
    return this.budget === undefined ? this.memoryBytes : Math.min(this.memoryBytes, this.budget.available + this.charged)
  }

  private charge(bytes: number): void {
    if (this.budget === undefined) return
    this.budget.available -= bytes
    this.charged += bytes
  }

  private release(): void {
    if (this.budget === undefined) return
    this.budget.available += this.charged
    this.charged = 0
  }

  /** Drops everything pushed so far; used when a later event supersedes a streamed body. */
  async reset(): Promise<void> {
    this.chunks = []
    this.bytes = 0
    this.normalizer.flush()
    this.release()
    if (!this.spilled) return
    // Truncating does not move the write offset, so the next write must start at 0
    // explicitly; appending at the old offset would leave a sparse NUL region.
    await this.spilled.handle.truncate(0)
    this.offset = 0
  }

  /** Streams the content in bounded pieces; never joins it into one string. */
  async *read(): AsyncGenerator<string> {
    await this.flush()
    for (const chunk of this.chunks) yield chunk
    if (!this.spilled) return
    const file = this.spilled
    const page = Buffer.allocUnsafe(64 * 1024)
    // One decoder for the whole read: a page boundary may fall inside a character.
    const decoder = new TextDecoder('utf-8')
    let offset = 0
    for (;;) {
      const { bytesRead } = await file.handle.read(page, 0, page.length, offset)
      if (bytesRead === 0) break
      offset += bytesRead
      const text = decoder.decode(page.subarray(0, bytesRead), { stream: true })
      if (text.length > 0) yield text
    }
    const tail = decoder.decode()
    if (tail.length > 0) yield tail
  }

  async digest(): Promise<string> {
    const hash = createHash('sha256')
    for await (const chunk of this.read()) hash.update(chunk, 'utf8')
    return hash.digest('hex')
  }

  async discard(): Promise<void> {
    this.chunks = []
    this.bytes = 0
    this.offset = 0
    this.normalizer.flush()
    this.release()
    const file = this.spilled
    this.spilled = undefined
    if (!file) return
    await file.handle.close()
    await rm(file.directory, { recursive: true, force: true })
  }

  /** Writes at the tracked offset; a short write resumes where it stopped. */
  private async write(file: { handle: FileHandle }, chunk: string, bytes: number): Promise<void> {
    let written = 0
    while (written < bytes) {
      const result = await file.handle.write(chunk, this.offset + written, 'utf8')
      if (result.bytesWritten === 0) throw new Error('侧聊 spool 写入没有进展')
      written += result.bytesWritten
    }
    this.offset += written
  }

  private async spill(): Promise<{ directory: string; path: string; handle: FileHandle }> {
    const directory = await mkdtemp(join(tmpdir(), 'scry-spool-'))
    const path = join(directory, 'text')
    const handle = await open(path, 'w+')
    const spilled = { directory, path, handle }
    this.spilled = spilled
    const pending = this.chunks
    this.chunks = []
    this.release()
    for (const chunk of pending) await this.write(spilled, chunk, Buffer.byteLength(chunk, 'utf8'))
    return spilled
  }
}
