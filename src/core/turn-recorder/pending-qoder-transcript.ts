import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, sep } from 'node:path'
import type { RecorderOpenTurnState } from './runtime-state.js'

export const PENDING_QODER_TRANSCRIPT_REASON = 'the claimed Qoder transcript did not become available as a regular file'

const MAX_MISSING_QODER_TRANSCRIPT_DIRECTORIES = 3

export async function pendingQoderTranscriptPath(path: string): Promise<string | undefined> {
  if (!isAbsolute(path) || path.split(sep).includes('..') || path.endsWith(sep)) return undefined
  const tail = [basename(path)]
  let directory = dirname(path)
  while (tail.length <= MAX_MISSING_QODER_TRANSCRIPT_DIRECTORIES + 1) {
    try {
      await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
      tail.unshift(basename(directory))
      directory = dirname(directory)
      continue
    }
    try {
      const ancestor = await realpath(directory)
      if (!(await lstat(ancestor)).isDirectory()) return undefined
      const candidate = join(ancestor, ...tail)
      try { await lstat(candidate) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      }
    } catch {
      return undefined
    }
    return undefined
  }
  return undefined
}

/** Use only the pinned path. Keep checking until its normal file has appeared. */
export async function observePendingQoderTranscript(open: RecorderOpenTurnState): Promise<void> {
  const path = open.pendingQoderTranscriptPath
  if (!path || open.transcriptPath) return
  const info = await lstat(path).catch(() => undefined)
  if (!info?.isFile() || await realpath(path).catch(() => undefined) !== path) return
  open.transcriptPath = path
  // The file appeared after the turn opened; the actual start offset was never observed.
  open.transcriptStartOffset = null
}
