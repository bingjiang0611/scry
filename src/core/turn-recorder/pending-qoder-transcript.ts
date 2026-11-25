import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { RecorderOpenTurnState } from './runtime-state.js'

export const PENDING_QODER_TRANSCRIPT_REASON = 'the claimed Qoder transcript did not become available as a regular file'

/** Admit a missing leaf, not a broken symlink or an unresolvable parent. */
export async function pendingQoderTranscriptPath(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return undefined
  try {
    const parent = await realpath(dirname(path))
    if (!(await lstat(parent)).isDirectory()) return undefined
    const candidate = join(parent, basename(path))
    try { await lstat(candidate) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
    }
    return undefined
  } catch {
    return undefined
  }
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
