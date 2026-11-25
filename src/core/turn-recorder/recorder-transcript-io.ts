import { openTranscriptRead, statTranscript } from './recorder-transcript-fs.js'

export interface TranscriptSnapshotIdentity {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

export function transcriptIdentity(info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): TranscriptSnapshotIdentity {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs }
}

// Process-local read counters: an increment per read call, no allocation on the hot path.
// Used to tell "parsed the whole transcript" apart from "parsed this turn's appended bytes".
let transcriptBytesRead = 0
let transcriptAnchorBytesScanned = 0

export function transcriptReadStats(): { bytesRead: number; anchorBytesScanned: number } {
  return { bytesRead: transcriptBytesRead, anchorBytesScanned: transcriptAnchorBytesScanned }
}

export function resetTranscriptReadStats(): void {
  transcriptBytesRead = 0
  transcriptAnchorBytesScanned = 0
}

/** Anchor discovery reads backwards from the end of the file; count it separately from parsing. */
export function recordTranscriptAnchorBytes(bytes: number): void {
  transcriptAnchorBytesScanned += bytes
}

function sameTranscriptIdentity(left: TranscriptSnapshotIdentity, right: TranscriptSnapshotIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

/**
 * How many bytes one turn window may materialise as a string.
 *
 * Every caller turns the window into a `string`, and a JavaScript string cannot exceed ~536 MiB of
 * UTF-8. A window larger than that used to be allocated in full and then throw
 * `ERR_STRING_TOO_LONG`, so the same turn failed the same way on every pass. 64 MiB is far inside
 * that limit, still larger than a plausible single turn (the 33 MiB turn the suite already covers),
 * and small enough that the worst case a cap can reach is a predictable allocation.
 */
export const TRANSCRIPT_WINDOW_LIMIT_BYTES = 64 * 1024 * 1024

/**
 * Why a window is shorter than requested. Dropped bytes include the unread prefix and any
 * incomplete first line removed from the retained range (`sourceCompleteness: 'partial'`).
 */
export interface TranscriptWindowTruncation {
  reason: 'window_limit'
  requestedBytes: number
  keptBytes: number
  droppedBytes: number
}

export function describeTranscriptTruncation(truncation: TranscriptWindowTruncation): string {
  const mib = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  return `window exceeded the ${mib(TRANSCRIPT_WINDOW_LIMIT_BYTES)} transcript read limit; ` +
    `kept the last ${mib(truncation.keptBytes)} of ${mib(truncation.requestedBytes)} and dropped ${mib(truncation.droppedBytes)}`
}

export async function readTranscriptWindow(
  path: string,
  endOffset: number,
  preferredStartOffset = 0,
  expectedIdentity?: TranscriptSnapshotIdentity,
  windowLimitBytes: number = TRANSCRIPT_WINDOW_LIMIT_BYTES
): Promise<{
  content: string
  startOffset: number
  endOffset: number
  identity?: TranscriptSnapshotIdentity
  truncated: boolean
  truncation?: TranscriptWindowTruncation
  consistent: boolean
}> {
  const boundedEnd = Math.max(0, endOffset)
  const limit = Number.isFinite(windowLimitBytes)
    ? Math.min(TRANSCRIPT_WINDOW_LIMIT_BYTES, Math.max(1, Math.trunc(windowLimitBytes)))
    : TRANSCRIPT_WINDOW_LIMIT_BYTES
  const requestedStart = Math.max(0, Math.min(preferredStartOffset, boundedEnd))
  const requestedBytes = boundedEnd - requestedStart
  // Keep the newest bytes of an over-limit window. The rows that can still close this turn — the
  // terminal event and the last usage frame — are at the end, so a head-keeping cap could never do
  // anything but fail to converge. The drop is named in `truncation` instead of being silent.
  const capped = requestedBytes > limit
  const start = capped ? boundedEnd - limit : requestedStart
  const length = boundedEnd - start
  const handle = await openTranscriptRead(path)
  const buffer = Buffer.allocUnsafe(length)
  let bytesRead = 0
  let before: TranscriptSnapshotIdentity | undefined
  let after: TranscriptSnapshotIdentity | undefined
  try {
    before = transcriptIdentity(await handle.stat())
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    after = transcriptIdentity(await handle.stat())
    transcriptBytesRead += bytesRead
  } finally {
    await handle.close()
  }
  let pathIdentity: TranscriptSnapshotIdentity | undefined
  try {
    pathIdentity = transcriptIdentity(await statTranscript(path))
  } catch {
    // A rotated-away path is unstable even when the already-open handle was still readable.
  }
  const consistent = bytesRead === length && !!before && !!after && !!pathIdentity &&
    (!expectedIdentity || sameTranscriptIdentity(before, expectedIdentity)) &&
    sameTranscriptIdentity(before, after) && sameTranscriptIdentity(after, pathIdentity)
  let contentStart = start
  let contentBuffer = buffer.subarray(0, bytesRead)
  let truncated = capped
  if (start > 0) {
    const firstNewline = contentBuffer.indexOf(0x0a)
    if (firstNewline >= 0) {
      contentStart += firstNewline + 1
      contentBuffer = contentBuffer.subarray(firstNewline + 1)
    } else {
      contentStart += contentBuffer.length
      contentBuffer = Buffer.alloc(0)
      truncated = true
    }
  }
  return {
    content: contentBuffer.toString('utf8'),
    startOffset: contentStart,
    endOffset: start + bytesRead,
    ...(consistent && after ? { identity: after } : {}),
    truncated,
    ...(capped
      ? { truncation: { reason: 'window_limit' as const, requestedBytes, keptBytes: contentBuffer.length, droppedBytes: requestedBytes - contentBuffer.length } }
      : {}),
    consistent
  }
}
