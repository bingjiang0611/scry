import type { ProviderId } from '../../shared/provider'
import type { TraceArchive } from '../transcript-archive'
import type { TraceArchivePage } from '../transcript-archive'
import type { SessionHistoryPageRequest } from '../session-history'
import { readTraceArchiveAsync, readTraceArchivePageAsync } from '../transcript-archive'
import { sessionArchiveIsPageable, readSessionHistoryAfterCompletedRuns } from '../session-history'

export const DEFAULT_LOAD_SESSION_TURNS = 10

export interface SessionArchiveRead {
  archivePage: TraceArchivePage | null
  archived: TraceArchive | null
}

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
  const profile = input.providerId !== 'pi' && typeof input.agentProfileId === 'string'
    ? { agentProfileId: input.agentProfileId }
    : {}
  const paged = sessionArchiveIsPageable(input.providerId, input.transcriptPath)
  try {
    const [archivePage, archived] = await readSessionHistoryAfterCompletedRuns(input.runs, input.signal, async () => {
      const limit = input.request?.limit ?? DEFAULT_LOAD_SESSION_TURNS
      const page = paged ? await readTraceArchivePageAsync(args, { ...profile, limit }, input.signal) : null
      const archive = page?.archive ?? (paged ? null : await readTraceArchiveAsync(args, input.signal))
      return [page, archive] as const
    })
    return { archivePage, archived }
  } catch (error) {
    input.signal.throwIfAborted()
    throw error
  }
}
