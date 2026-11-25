import { open as openFile, stat, type FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EINTR', 'EBUSY'])

export const TRANSCRIPT_READ_ATTEMPTS = 3
export const TRANSCRIPT_READ_RETRY_DELAY_MS = 20

export function isTransientTranscriptError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && TRANSIENT_FS_CODES.has(code)
}

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

export function openTranscriptRead(path: string): Promise<FileHandle> {
  return withTranscriptRetry(() => openFile(path, 'r'))
}

export function statTranscript(path: string): Promise<Stats> {
  return withTranscriptRetry(() => stat(path))
}
