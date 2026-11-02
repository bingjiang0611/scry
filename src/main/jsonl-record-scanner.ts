import { createHash, type Hash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { none } from 'stream-chain'
import { jsonParser, type Token } from 'stream-json/parser.js'

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
  const parse = jsonParser({ jsonStreaming: true, packValues: false })
  // Parse each bounded input synchronously, rather than crossing the stream adapter's
  // async bridge for every escape/token. Only projected, bounded events cross yield.
  for await (const input of tokenInputs(handle, size, evidence)) {
    try {
      const parsed = parse(input)
      if (parsed === none) continue
      for (const token of coalesceStringTokens(parsed.values)) {
        for (const event of projector.accept(token)) yield event
      }
    } catch (error) {
      // Only tokenizer/projector failures get the unfinished-tail verdict. File reads run
      // outside this catch: an I/O failure is not proof of an unfinished writer append.
      if (await endsWithNewline(handle, size)) {
        throw new JsonlRecordError(`原生会话记录语法无效：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
  }
}

async function* tokenInputs(
  handle: FileHandle,
  size: number,
  evidence: TranscriptReadEvidence
): AsyncGenerator<string | typeof none> {
  const decoder = new TextDecoder('utf-8')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let read = 0
  while (read < size) {
    const chunk = await handle.read(buffer, 0, Math.min(buffer.length, size - read), read)
    if (chunk.bytesRead === 0) break
    read += chunk.bytesRead
    evidence.bytes = read
    evidence.digest?.update(buffer.subarray(0, chunk.bytesRead))
    yield decoder.decode(buffer.subarray(0, chunk.bytesRead), { stream: true })
  }
  const tail = decoder.decode()
  if (tail.length > 0) yield tail
  yield none
}

/** Adjacent pieces belong to the same scalar; never merge across a structural token. */
function* coalesceStringTokens(tokens: readonly Token[]): Generator<Token> {
  let text = ''
  for (const token of tokens) {
    if (token.name === 'stringChunk') {
      text += token.value
      while (text.length >= 16 * 1024) {
        yield { name: 'stringChunk', value: text.slice(0, 16 * 1024) }
        text = text.slice(16 * 1024)
      }
      continue
    }
    if (text) {
      yield { name: 'stringChunk', value: text }
      text = ''
    }
    yield token
  }
  if (text) yield { name: 'stringChunk', value: text }
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
