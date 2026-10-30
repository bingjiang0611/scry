import { createHash } from 'node:crypto'
import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Append-only text buffer whose resident memory is bounded.
 *
 * A single visible message may be hundreds of MiB, and its bytes are only needed in
 * order, once. Below the memory budget the text stays in memory; beyond it the spool
 * moves to a private temporary file so a huge message never becomes one JavaScript
 * string. The spool is deleted by `discard`, and callers always discard in `finally`.
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
  private spilled?: { directory: string; path: string; handle: FileHandle }

  constructor(private readonly memoryBytes = 256 * 1024, private readonly budget?: SpoolBudget) {}

  get size(): number {
    return this.bytes
  }

  get spilledToDisk(): boolean {
    return this.spilled !== undefined
  }

  async push(chunk: string): Promise<void> {
    if (chunk.length === 0) return
    const bytes = Buffer.byteLength(chunk, 'utf8')
    this.bytes += bytes
    if (!this.spilled && this.bytes <= this.capacity()) {
      this.chunks.push(chunk)
      this.charge(bytes)
      return
    }
    const file = this.spilled ?? await this.spill()
    await file.handle.appendFile(chunk, 'utf8')
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
    this.release()
    if (this.spilled) await this.spilled.handle.truncate(0)
  }

  /** Streams the content in bounded pieces; never joins it into one string. */
  async *read(): AsyncGenerator<string> {
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
    this.release()
    const file = this.spilled
    this.spilled = undefined
    if (!file) return
    await file.handle.close()
    await rm(file.directory, { recursive: true, force: true })
  }

  private async spill(): Promise<{ directory: string; path: string; handle: FileHandle }> {
    const directory = await mkdtemp(join(tmpdir(), 'scry-spool-'))
    const path = join(directory, 'text')
    const handle = await open(path, 'w+')
    const spilled = { directory, path, handle }
    this.spilled = spilled
    for (const chunk of this.chunks) await handle.appendFile(chunk, 'utf8')
    this.chunks = []
    this.release()
    return spilled
  }
}
