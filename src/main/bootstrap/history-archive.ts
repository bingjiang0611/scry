import type { ProviderId } from '../../shared/provider'
import type { TraceArchive } from '../transcript-archive'
import type { TraceArchivePage } from '../transcript-archive'
import type { SessionHistoryPageRequest } from '../session-history'
import { readTraceArchiveAsync, readTraceArchiveMetadataAsync, readTraceArchivePageAsync } from '../transcript-archive'
import { sessionArchiveIsPageable, readSessionHistoryAfterCompletedRuns } from '../session-history'

/**
 * Turns read for a session load that does not ask for a size. Each archived turn costs one file
 * read plus a JSON parse of roughly a megabyte (measured on a 111-turn real archive: 40 turns
 * ≈ 363 ms, 10 turns ≈ 100 ms), so the first paint stays small and older turns page on demand.
 */
export const DEFAULT_LOAD_SESSION_TURNS = 10

export interface SessionArchiveRead {
  archivePage: TraceArchivePage | null
  archived: TraceArchive | null
  /**
   * Transcript-backed loads with a complete archive index: index-only turns that position the
   * transcript merge, with bodies read per history window. `archived` is then null until a caller
   * falls back to the complete read.
   */
  archiveIndex?: TraceArchive
}

/**
 * Reads the archive page a session load needs, after completed runs finished publishing.
 * Kept apart from the IPC handler so the read (and its evidence) stays one responsibility.
 */
export async function readSessionArchive(input: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
  agentProfileId?: string
  request?: SessionHistoryPageRequest
  transcriptPath: string | null
  runs: readonly { done: boolean; settled: Promise<void> }[]
  signal: AbortSignal
}): Promise<SessionArchiveRead> {
  const args = { cwd: input.cwd, sessionId: input.sessionId, providerId: input.providerId, userDataDir: input.userDataDir }
  // Pi archives are not profile-scoped; other providers keep the profile in the archive query.
  const profile = input.providerId !== 'pi' && typeof input.agentProfileId === 'string'
    ? { agentProfileId: input.agentProfileId }
    : {}
  const paged = sessionArchiveIsPageable(input.providerId, input.transcriptPath)
  try {
    const [archivePage, archived, archiveIndex] = await readSessionHistoryAfterCompletedRuns(input.runs, input.signal, async () => {
      const limit = input.request?.limit ?? DEFAULT_LOAD_SESSION_TURNS
      const page = paged ? await readTraceArchivePageAsync(args, { ...profile, limit }, input.signal) : null
      // A transcript merge positions turns by the whole archive, but only by its index: read every
      // turn body only when the index cannot describe every canonical turn.
      const metadata = !paged && input.transcriptPath
        ? await readTraceArchiveMetadataAsync(args, input.signal, { requireComplete: true })
        : null
      if (metadata) return [null, null, metadata] as const
      const archive = page?.archive ?? (paged ? null : await readTraceArchiveAsync(args, input.signal))
      return [page, archive, undefined] as const
    })
    return { archivePage, archived, ...(archiveIndex ? { archiveIndex } : {}) }
  } catch (error) {
    input.signal.throwIfAborted()
    throw error
  }
}
