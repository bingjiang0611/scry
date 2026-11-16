import { open as openFile, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

/**
 * Timed filesystem access for Provider transcripts.
 *
 * macOS returns `EPERM` for an `open` that some other component of the machine refused right now:
 * an endpoint-security/DLP file interposer, a TCC decision, or a momentarily suspended task. The
 * same path reads fine milliseconds later — the field failure this exists for was a single denied
 * `open` on `~/.qoder/projects/<project>/<session>.jsonl` while the file stayed 0600 and owned by
 * the same user. That makes `EPERM` a statement about this syscall, not about the evidence, so it
 * must not be reported as a permanent loss of the turn.
 *
 * Only codes that can honestly succeed on a retry are listed. `ENOENT` (a rotated or not yet
 * created transcript), `EACCES` (a static permission/ACL decision), `EISDIR` and the path-shape
 * errors are permanent for this call and are rethrown immediately.
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EINTR', 'EBUSY'])

export const TRANSCRIPT_READ_ATTEMPTS = 3
export const TRANSCRIPT_READ_RETRY_DELAY_MS = 20

export function isTransientTranscriptError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && TRANSIENT_FS_CODES.has(code)
}

/** Retry one filesystem call while it fails with a code that can clear on its own. */
export async function withTranscriptRetry<T>(
  operation: () => Promise<T>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? TRANSCRIPT_READ_ATTEMPTS))
  const delayMs = Math.max(0, options.delayMs ?? TRANSCRIPT_READ_RETRY_DELAY_MS)
  let failure: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isTransientTranscriptError(error)) throw error
      failure = error
      if (attempt + 1 < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)))
      }
    }
  }
  throw failure
}

/** `open` a transcript for reading, absorbing a momentary denial. */
export function openTranscriptRead(path: string): Promise<FileHandle> {
  return withTranscriptRetry(() => openFile(path, 'r'))
}

/** `stat` a transcript, absorbing a momentary denial. */
export function statTranscript(path: string): Promise<Stats> {
  return withTranscriptRetry(() => stat(path))
}
