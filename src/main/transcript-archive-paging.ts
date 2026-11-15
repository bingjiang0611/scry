import type { ParsedTurn } from './normalize'
import type { TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'
import { mergeSessionTurns, sessionHistoryPage, type LoadedSessionTurn, type SessionHistoryContext, type SessionHistoryPageRequest } from './session-history'

/**
 * Transcript-backed history (Claude) merges the whole transcript with the whole archive by
 * canonical user text, so a turn's position depends on every turn. Positions only need the
 * archive index (runId, userText, order), not turn bodies; bodies are read for the turns a page
 * shows. A page built this way equals the same slice of the complete merge: matching never looks
 * at bodies, each turn's items merge independently, and per-event content persistence is per event.
 */
export interface TranscriptArchivePaging {
  readonly identity: Pick<TraceArchive, 'cwd' | 'sessionId' | 'providerId'>
  /** Complete index metadata in canonical archive order. Never mutated. */
  readonly metadata: readonly TraceArchiveTurn[]
  /** Archive turns whose canonical bodies were read and persisted, keyed by runId. */
  readonly hydrated: Map<string, TraceArchiveTurn>
  /** Transcript indices whose tool content was persisted. */
  readonly persistedTranscript: Set<number>
}

export interface TranscriptArchiveWindow {
  turns: LoadedSessionTurn[]
  archive: TraceArchive
  turnFilesRead: number
}

export function createTranscriptArchivePaging(metadata: TraceArchive): TranscriptArchivePaging {
  return {
    identity: { cwd: metadata.cwd, sessionId: metadata.sessionId, providerId: metadata.providerId },
    metadata: metadata.turns,
    hydrated: new Map(),
    persistedTranscript: new Set()
  }
}

/** Index turns with every hydrated body substituted in place; order and membership are the index's. */
export function transcriptPagingArchive(paging: TranscriptArchivePaging): TraceArchive {
  return {
    version: 3,
    cwd: paging.identity.cwd,
    sessionId: paging.identity.sessionId,
    providerId: paging.identity.providerId as ProviderId,
    turns: paging.metadata.map((turn) => paging.hydrated.get(turn.runId) ?? turn)
  }
}

/**
 * Hydrates the archive bodies and transcript tool content behind one history window and returns
 * the complete merged list, exact inside the window. Positions outside it may still carry index-only
 * items; callers must only expose turns from a window this function hydrated.
 *
 * Returns null when the canonical bodies no longer match the index (a file disappeared or changed):
 * the caller must fall back to its complete read rather than show a guessed page.
 */
export async function hydrateTranscriptArchiveWindow(input: {
  paging: TranscriptArchivePaging
  transcriptTurns: ParsedTurn[]
  request?: SessionHistoryPageRequest
  context: SessionHistoryContext
  readTurns: (runIds: readonly string[]) => Promise<TraceArchiveTurn[]>
  persistItems: (items: TraceEvent[]) => Promise<TraceEvent[]>
  signal?: AbortSignal
}): Promise<TranscriptArchiveWindow | null> {
  const { paging, transcriptTurns, context } = input
  const merge = (): LoadedSessionTurn[] =>
    mergeSessionTurns(transcriptTurns, transcriptPagingArchive(paging), context, { hydrateAttachments: false })
  const positioned = merge()
  const window = sessionHistoryPage(positioned, input.request)
  const end = window.offset + window.turns.length
  const missing = window.turns
    .map((turn) => turn.runId)
    .filter((runId): runId is string => typeof runId === 'string' && !paging.hydrated.has(runId))
  const transcriptIndices: number[] = []
  for (let index = window.offset; index < Math.min(end, transcriptTurns.length); index++) {
    if (!paging.persistedTranscript.has(index)) transcriptIndices.push(index)
  }
  if (missing.length === 0 && transcriptIndices.length === 0) {
    return { turns: positioned, archive: transcriptPagingArchive(paging), turnFilesRead: 0 }
  }
  let read: TraceArchiveTurn[] = []
  try {
    read = missing.length ? await input.readTurns(missing) : []
  } catch (error) {
    input.signal?.throwIfAborted()
    // The selective reader refuses an index entry whose canonical file changed or is corrupt.
    if (error instanceof Error && error.message === 'trace archive index entry changed or is corrupt') return null
    throw error
  }
  input.signal?.throwIfAborted()
  const readByRunId = new Map(read.map((turn) => [turn.runId, turn]))
  const expected = new Map(paging.metadata.map((turn) => [turn.runId, turn]))
  for (const runId of missing) {
    const body = readByRunId.get(runId)
    // userText decides positions. A body that disagrees with its index entry means the page we
    // positioned is not the page the complete merge would produce.
    if (!body || body.userText !== expected.get(runId)?.userText) return null
  }
  for (const runId of missing) {
    const body = readByRunId.get(runId)!
    body.items = await input.persistItems(body.items)
    input.signal?.throwIfAborted()
    paging.hydrated.set(runId, body)
  }
  for (const index of transcriptIndices) {
    const turn = transcriptTurns[index]
    turn.items = await input.persistItems(turn.items)
    input.signal?.throwIfAborted()
    paging.persistedTranscript.add(index)
  }
  return { turns: merge(), archive: transcriptPagingArchive(paging), turnFilesRead: read.length }
}
