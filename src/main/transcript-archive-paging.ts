import { createHash } from 'node:crypto'
import type { ParsedTurn } from './normalize'
import type { TraceEvent } from '../shared/trace'
import type { ProviderId } from '../shared/provider'
import type { TraceArchive, TraceArchiveTurn } from './transcript-archive'
import {
  mergeSessionTurnAt,
  sessionHistoryWindow,
  sessionMergeKey,
  sessionMergePlan,
  type LoadedSessionTurn,
  type SessionHistoryContext,
  type SessionHistoryPageRequest,
  type SessionMergePosition
} from './session-history'

/**
 * Transcript-backed history (Claude) merges the transcript with the archive by canonical user
 * text, so a turn's position depends on every turn. Positions need only user texts (the archive
 * index has them); bodies are read, persisted and merged for the positions a page shows. Without
 * attachment hydration each merged position depends only on its own inputs, so a page equals the
 * same slice of the complete merge.
 *
 * The state keeps merged (content-bounded) turns of hydrated windows and archive bodies read for
 * them; it never keeps raw transcript bodies. Older windows re-read the transcript and must find
 * the same prompts, or the caller reloads instead of mixing two transcript versions.
 */
export interface TranscriptArchivePaging {
  readonly identity: Pick<TraceArchive, 'cwd' | 'sessionId' | 'providerId'>
  /** Complete index metadata in canonical archive order. Never mutated. */
  readonly metadata: readonly TraceArchiveTurn[]
  readonly plan: readonly SessionMergePosition[]
  /** Digest of the transcript prompts the plan was built from. */
  readonly transcriptKey: string
  /** Archive bodies read (and content-persisted) for hydrated windows, keyed by runId. */
  readonly hydrated: Map<string, TraceArchiveTurn>
  /** Exact merged turns by position. */
  readonly merged: Map<number, LoadedSessionTurn>
}

export interface TranscriptArchiveWindow {
  /** Every position; only positions of hydrated windows carry merged content. */
  turns: LoadedSessionTurn[]
  /** Archive bodies read so far, for attachment hydration of the returned page. */
  archive: TraceArchive
  turnFilesRead: number
}

const UNHYDRATED: TraceEvent[] = []

export function transcriptPromptKey(transcriptTurns: readonly Pick<ParsedTurn, 'userText'>[]): string {
  const hash = createHash('sha256').update(String(transcriptTurns.length))
  for (const turn of transcriptTurns) hash.update('\0').update(sessionMergeKey(turn.userText))
  return hash.digest('hex')
}

export function createTranscriptArchivePaging(metadata: TraceArchive, transcriptTurns: readonly ParsedTurn[]): TranscriptArchivePaging {
  return {
    identity: { cwd: metadata.cwd, sessionId: metadata.sessionId, providerId: metadata.providerId },
    metadata: metadata.turns,
    plan: sessionMergePlan(transcriptTurns.map((turn) => turn.userText), metadata.turns.map((turn) => turn.userText)),
    transcriptKey: transcriptPromptKey(transcriptTurns),
    hydrated: new Map(),
    merged: new Map()
  }
}

function pagingArchive(paging: TranscriptArchivePaging): TraceArchive {
  return {
    version: 3,
    cwd: paging.identity.cwd,
    sessionId: paging.identity.sessionId,
    providerId: paging.identity.providerId as ProviderId,
    turns: paging.metadata.flatMap((turn) => paging.hydrated.get(turn.runId) ?? [])
  }
}

function pagingTurns(paging: TranscriptArchivePaging): LoadedSessionTurn[] {
  return paging.plan.map((position, index) => paging.merged.get(index) ?? {
    ...(position.archive != null ? { runId: paging.metadata[position.archive].runId } : {}),
    userText: '',
    items: UNHYDRATED
  })
}

/**
 * Makes the window `request` selects exact and returns all positions. Returns null when the sources
 * no longer match the plan (transcript prompts changed, an archive file disappeared or changed):
 * the caller must fall back to its complete read or ask for a reload, never show a guessed page.
 */
export async function hydrateTranscriptArchiveWindow(input: {
  paging: TranscriptArchivePaging
  transcriptTurns: readonly ParsedTurn[]
  request?: SessionHistoryPageRequest
  context: SessionHistoryContext
  readTurns: (runIds: readonly string[]) => Promise<TraceArchiveTurn[]>
  persistItems: (items: TraceEvent[]) => Promise<TraceEvent[]>
  signal?: AbortSignal
}): Promise<TranscriptArchiveWindow | null> {
  const { paging, transcriptTurns, context } = input
  if (transcriptPromptKey(transcriptTurns) !== paging.transcriptKey) return null
  const { offset, end } = sessionHistoryWindow(paging.plan.length, input.request)
  const pending: number[] = []
  for (let index = offset; index < end; index++) if (!paging.merged.has(index)) pending.push(index)
  if (pending.length === 0) return { turns: pagingTurns(paging), archive: pagingArchive(paging), turnFilesRead: 0 }
  const missing = pending
    .map((index) => paging.plan[index].archive)
    .filter((archive): archive is number => archive != null)
    .map((archive) => paging.metadata[archive])
    .filter((turn) => !paging.hydrated.has(turn.runId))
  let read: TraceArchiveTurn[] = []
  try {
    read = missing.length ? await input.readTurns(missing.map((turn) => turn.runId)) : []
  } catch (error) {
    input.signal?.throwIfAborted()
    // The selective reader refuses an index entry whose canonical file changed or is corrupt.
    if (error instanceof Error && error.message === 'trace archive index entry changed or is corrupt') return null
    throw error
  }
  input.signal?.throwIfAborted()
  const readByRunId = new Map(read.map((turn) => [turn.runId, turn]))
  // userText decides positions: a body that disagrees with its index entry was not planned.
  if (missing.some((turn) => readByRunId.get(turn.runId)?.userText !== turn.userText)) return null
  for (const turn of missing) {
    const body = readByRunId.get(turn.runId)!
    paging.hydrated.set(turn.runId, { ...body, items: await input.persistItems(body.items) })
    input.signal?.throwIfAborted()
  }
  for (const index of pending) {
    const position = paging.plan[index]
    const source = position.transcript != null ? transcriptTurns[position.transcript] : undefined
    const transcript = source ? { ...source, items: await input.persistItems(source.items) } : undefined
    input.signal?.throwIfAborted()
    const archived = position.archive != null ? paging.hydrated.get(paging.metadata[position.archive].runId) : undefined
    paging.merged.set(index, mergeSessionTurnAt(transcript, archived, context))
  }
  return { turns: pagingTurns(paging), archive: pagingArchive(paging), turnFilesRead: read.length }
}
