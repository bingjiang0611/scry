import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { available, unavailable, type Evidence } from '../../shared/turn-record'

const READ_CHUNK_BYTES = 64 * 1024
const MAX_RESOLVED_BYTES = 32 * 1024 * 1024

/** The host resolves path within the owning Provider's roots before reading. */
export interface TranscriptSource {
  provider: 'claude' | 'pi'
  nativeSessionId: string
  path: string
}

export interface TranscriptExtent {
  device: bigint
  inode: bigint
  size: number
  mtimeNs: bigint
  ctimeNs?: bigint
  birthtimeNs: bigint
}

export const catalogFrontierKey = (sessionKey: string): string => `catalog_transcript:${sessionKey}`

function extent(stat: BigIntStats): TranscriptExtent | undefined {
  if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return { device: stat.dev, inode: stat.ino, size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP'
}

export async function readTranscriptExtent(source: TranscriptSource): Promise<TranscriptExtent | undefined> {
  try {
    return extent(await lstat(source.path, { bigint: true }))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function referencePrefix(source: TranscriptSource): string {
  return `transcript:${source.provider}:${source.nativeSessionId}#bytes=`
}

async function openTranscript(source: TranscriptSource): Promise<FileHandle | undefined> {
  try {
    return await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

async function hashRange(
  file: FileHandle, start: number, end: number, bytes?: Buffer, acceptPrefix?: (prefix: Buffer) => boolean
): Promise<string | undefined> {
  const hash = createHash('sha256')
  const chunk = bytes ?? Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - start))
  for (let position = start; position < end;) {
    const offset = bytes ? position - start : 0
    const { bytesRead } = await file.read(chunk, offset, Math.min(READ_CHUNK_BYTES, end - position), position)
    if (bytesRead === 0) return undefined
    const read = chunk.subarray(offset, offset + bytesRead)
    if (position === start && acceptPrefix && !acceptPrefix(read)) return undefined
    hash.update(read)
    position += bytesRead
  }
  return hash.digest('hex')
}

// Call only with the prefix bytes about to be hashed for the reference.
function hasNewNativeStart(bytes: Buffer, startedAt: bigint, mtimeNs: bigint): boolean {
  const prefix = bytes.subarray(0, 16 * 1024)
  const lineEnd = prefix.indexOf(0x0a)
  if (lineEnd < 0) return false
  let timestamp: unknown
  try { timestamp = (JSON.parse(prefix.toString('utf8', 0, lineEnd)) as { timestamp?: unknown } | null)?.timestamp }
  catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
  if (typeof timestamp !== 'string') return false
  const milliseconds = Date.parse(timestamp)
  if (!Number.isFinite(milliseconds)) return false
  const firstAt = BigInt(milliseconds) * 1_000_000n
  return firstAt > startedAt && firstAt <= mtimeNs
}

export async function captureTranscriptInterval(
  source: TranscriptSource,
  before?: TranscriptExtent,
  through?: TranscriptExtent,
  verifyStartAfter?: bigint
): Promise<Evidence<string>> {
  const file = await openTranscript(source)
  if (!file) return unavailable('source_removed')
  try {
    const opened = await file.stat({ bigint: true })
    const after = extent(opened)
    const start = before?.size ?? 0
    const end = through?.size ?? after?.size ?? 0
    if (!after || after.size < end || end < start ||
        (before && (after.device !== before.device || after.inode !== before.inode)) ||
        (through && (after.device !== through.device || after.inode !== through.inode))) {
      return unavailable('source_removed')
    }
    if (end === start) return unavailable('no_new_transcript_bytes')
    if (end - start > MAX_RESOLVED_BYTES) return unavailable('transcript_interval_too_large')
    const verifiedStart = verifyStartAfter !== undefined
    if (verifiedStart && (!through || start !== 0 || after.inode <= 0n ||
        after.size !== through.size || after.mtimeNs !== through.mtimeNs || after.ctimeNs !== through.ctimeNs)) {
      return unavailable('transcript_frontier_unavailable')
    }
    const digest = await hashRange(file, start, end, undefined,
      verifiedStart ? prefix => hasNewNativeStart(prefix, verifyStartAfter, after.mtimeNs) : undefined)
    if (!digest) return unavailable(verifiedStart ? 'transcript_frontier_unavailable' : 'source_removed')
    if (verifiedStart) {
      const finished = await file.stat({ bigint: true })
      if (finished.size !== opened.size || finished.mtimeNs !== opened.mtimeNs || finished.ctimeNs !== opened.ctimeNs) {
        return unavailable('transcript_frontier_unavailable')
      }
    }
    const reference = `${referencePrefix(source)}${start}-${end},sha256=${digest}`
    return available(reference, [reference])
  } finally {
    await file.close()
  }
}

export async function resolveTranscriptInterval(source: TranscriptSource, reference: string): Promise<Evidence<Buffer>> {
  const prefix = referencePrefix(source)
  const match = reference.startsWith(prefix) && /^(\d+)-(\d+),sha256=([a-f0-9]{64})$/.exec(reference.slice(prefix.length))
  if (!match) return unavailable('invalid_transcript_reference')
  const start = Number(match[1])
  const end = Number(match[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    return unavailable('invalid_transcript_reference')
  }
  const file = await openTranscript(source)
  if (!file) return unavailable('source_removed', [reference])
  try {
    const current = extent(await file.stat({ bigint: true }))
    if (!current || current.size < end) return unavailable('source_removed', [reference])
    if (end - start > MAX_RESOLVED_BYTES) return unavailable('transcript_interval_too_large', [reference])
    const bytes = Buffer.allocUnsafe(end - start)
    const digest = await hashRange(file, start, end, bytes)
    if (!digest) return unavailable('source_removed', [reference])
    if (digest !== match[3]) return unavailable('source_changed', [reference])
    return available(bytes, [reference])
  } finally {
    await file.close()
  }
}
