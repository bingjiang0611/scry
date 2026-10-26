import { open as openFile, stat } from 'node:fs/promises'

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

function sameTranscriptIdentity(left: TranscriptSnapshotIdentity, right: TranscriptSnapshotIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

export async function readTranscriptWindow(
  path: string,
  endOffset: number,
  preferredStartOffset = 0,
  expectedIdentity?: TranscriptSnapshotIdentity
): Promise<{
  content: string
  startOffset: number
  endOffset: number
  identity?: TranscriptSnapshotIdentity
  truncated: boolean
  consistent: boolean
}> {
  const boundedEnd = Math.max(0, endOffset)
  const preferredStart = Math.max(0, Math.min(preferredStartOffset, boundedEnd))
  // The start offset is captured when the user turn opens. A later byte cap would
  // permanently erase early events from a large turn, so read the complete bounded
  // snapshot from that authority rather than silently advancing the start cursor.
  const start = preferredStart
  const length = boundedEnd - start
  const handle = await openFile(path, 'r')
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
  } finally {
    await handle.close()
  }
  let pathIdentity: TranscriptSnapshotIdentity | undefined
  try {
    pathIdentity = transcriptIdentity(await stat(path))
  } catch {
    // A rotated-away path is unstable even when the already-open handle was still readable.
  }
  const consistent = bytesRead === length && !!before && !!after && !!pathIdentity &&
    (!expectedIdentity || sameTranscriptIdentity(before, expectedIdentity)) &&
    sameTranscriptIdentity(before, after) && sameTranscriptIdentity(after, pathIdentity)
  let contentStart = start
  let contentBuffer = buffer.subarray(0, bytesRead)
  let truncated = start > preferredStart
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
    consistent
  }
}
