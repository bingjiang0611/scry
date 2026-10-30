import { once } from 'node:events'
import { createHash, type Hash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { parser, type Token } from 'stream-json/parser.js'

/**
 * Records of a Provider's JSONL transcript, read through the installed tokenizer.
 *
 * A raw transcript record can be hundreds of MiB because it embeds a whole tool result, so
 * these readers cannot read whole lines or call `JSON.parse`. The file is fed to
 * `stream-json`, the same tokenizer the trace-archive projection uses, and a Provider
 * specific projector tracks only the key path that Provider's records need. Everything else
 * is consumed as tokens and dropped, so a 195 MiB payload never becomes a string.
 *
 * Records end at the newline the writer emits. That is also how a parse failure is
 * classified: when the tokenizer rejects a file whose last byte is a newline, the writer
 * finished that line and it is a complete-but-invalid record; when the file does not end
 * with a newline, that line was still being written, so it is an unfinished append that is
 * dropped while the completed prefix stands.
 */

export class JsonlRecordError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonlRecordError'
  }
}

/** Evidence of the bytes this reader actually consumed. */
export interface TranscriptReadEvidence {
  bytes: number
  /**
   * Raw bytes of that span, when the caller has to prove two reads saw the same prefix.
   *
   * Hashing the bytes as they are read is the only way to compare two passes over one file:
   * a same-size rewrite changes no stat field, so inode, device and size cannot tell it apart
   * from the file the first pass measured.
   */
  digest?: Hash
}

/** Provider specific projection of one token stream. */
export interface RecordProjector<T> {
  accept(token: Token): T[]
}

export type { Token }

/**
 * Yields one projector event at a time, in document order, and never past `size` bytes.
 *
 * The generator stops normally when the file ends in an unfinished record, and throws when
 * a finished record is invalid. Nothing is published for a record that never ended.
 */
export async function* projectJsonlRecords<T>(
  handle: FileHandle,
  size: number,
  create: () => RecordProjector<T>,
  evidence: TranscriptReadEvidence
): AsyncGenerator<T> {
  const projector = create()
  const tokens = parser.asStream({ jsonStreaming: true, packStrings: false, packNumbers: false })
  const decoder = new TextDecoder('utf-8')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  // Writing runs beside the token loop: the tokenizer only produces tokens once a chunk has
  // been processed, so a single loop would starve on the first read.
  const feeding = (async (): Promise<void> => {
    let read = 0
    while (read < size) {
      const chunk = await handle.read(buffer, 0, Math.min(buffer.length, size - read), read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
      evidence.bytes = read
      evidence.digest?.update(buffer.subarray(0, chunk.bytesRead))
      if (!tokens.write(decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true }))) {
        await once(tokens, 'drain')
      }
    }
    const tail = decoder.decode()
    if (tail.length > 0 && !tokens.write(tail)) await once(tokens, 'drain')
    tokens.end()
  })()
  // Attached in this tick: a write rejected by the tokenizer must not surface as an
  // unhandled rejection after the token loop has already reported the same verdict.
  const feedingDone = feeding.catch(() => undefined)
  try {
    for await (const token of tokens as unknown as AsyncIterable<Token>) {
      for (const event of projector.accept(token)) yield event
    }
  } catch (error) {
    // A record the writer ended with a newline is a finished record that is invalid; a file
    // whose last byte is not a newline was still being written there, and nothing in that
    // unfinished line is evidence, so the completed prefix stands.
    if (await endsWithNewline(handle, size)) {
      throw new JsonlRecordError(`原生会话记录语法无效：${error instanceof Error ? error.message : String(error)}`)
    }
    return
  } finally {
    await feedingDone
  }
}

async function endsWithNewline(handle: FileHandle, size: number): Promise<boolean> {
  if (size === 0) return false
  const last = Buffer.allocUnsafe(1)
  const { bytesRead } = await handle.read(last, 0, 1, size - 1)
  return bytesRead === 1 && last[0] === 0x0a
}

/**
 * `${bytes read}:${sha256}` over `[0, bytes)` of an open handle.
 *
 * A reader that parsed a prefix can call this again over the same range and compare: a
 * rewrite that keeps the file's size changes no stat field, so only the content itself can
 * tell the reader whether what it parsed is still what the file holds. Bytes after the range
 * are ignored, which is what keeps an append-only writer legal.
 */
export async function hashFilePrefix(handle: FileHandle, bytes: number): Promise<string> {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let read = 0
  while (read < bytes) {
    const chunk = await handle.read(buffer, 0, Math.min(buffer.length, bytes - read), read)
    if (chunk.bytesRead === 0) break
    read += chunk.bytesRead
    hash.update(buffer.subarray(0, chunk.bytesRead))
  }
  return `${read}:${hash.digest('hex')}`
}
