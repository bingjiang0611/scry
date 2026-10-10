import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { ActiveRun } from '../../shared/trace'
import { parseTranscriptToTurns } from '../normalize'
import { mergeSessionTurns } from '../session-history'
import { readTraceArchiveAsync, readTraceArchivePageAsync, readTraceArchiveVersionAsync, resolveTranscriptPath } from '../transcript-archive'
import type { RemoteHistoryTurnsPage, RemoteHistoryVersion } from './remote-gateway'
import { flattenTraceItems } from './trace-output'

type HistoryContext = Parameters<typeof readTraceArchiveVersionAsync>[0]
type PageRequest = { before?: number; limit: number; snapshot?: string }
type ActiveReader = () => ActiveRun | undefined
type HistoryRun = Pick<ActiveRun, 'runId' | 'userText' | 'items'>

// A peer cannot invent a past live-turn count. This process-local signature
// authenticates bounded source metadata without retaining a second trace cache.
// Host restart invalidates continuation tokens; protected cached text stays readable.
const snapshotKey = randomBytes(32)

function signature(value: string): string {
  return createHmac('sha256', snapshotKey).update(value).digest('hex').slice(0, 32)
}

function historyError(code: 'history_unavailable' | 'history_snapshot_changed' | 'invalid_history_cursor'): Error {
  return Object.assign(new Error(code), { code })
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function sourceVersion(args: HistoryContext, run: HistoryRun | undefined): Promise<RemoteHistoryVersion> {
  const archive = await readTraceArchiveVersionAsync(args)
  const path = args.providerId === 'claude' ? resolveTranscriptPath(args) : null
  const transcript = path ? await stat(path) : null
  // These are source revisions, not a complete-history content digest. The
  // separate persistent-source prefix lets older archive pages retain their
  // frozen total while live text advances; the captured live turn stays partial.
  const transcriptVersion = hash(transcript && [path, transcript.size, transcript.mtimeMs, transcript.ctimeMs])
  const activeVersion = hash(run ? { runId: run.runId, userText: run.userText, items: run.items } : null)
  const token = `${archive.version}:${transcriptVersion}:${run ? 1 : 0}:${activeVersion}`
  return { version: `${token}:${signature(token)}`, readMode: archive.readMode }
}

export async function readRemoteHistoryVersion(args: HistoryContext, active: ActiveReader): Promise<RemoteHistoryVersion> {
  return sourceVersion(args, active())
}

// Read only the requested archive window. Claude retains the desktop's native
// transcript/archive merge authority; its host-side parse is not constant-time.
export async function readRemoteHistoryTurnsPage(
  args: HistoryContext, request: PageRequest, active: ActiveReader
): Promise<RemoteHistoryTurnsPage> {
  const current = active()
  const run = current ? { runId: current.runId, userText: current.userText, items: structuredClone(current.items) } : undefined
  const version = await sourceVersion(args, run)
  const currentParts = version.version.split(':')
  const frozenParts = request.snapshot?.split(':') ?? currentParts
  if (frozenParts.length !== 5 || ![frozenParts[0], frozenParts[1], frozenParts[3]].every(value => /^[a-f0-9]{64}$/.test(value)) ||
      !['0', '1'].includes(frozenParts[2]) || !/^[a-f0-9]{32}$/.test(frozenParts[4]) ||
      !timingSafeEqual(Buffer.from(frozenParts[4], 'hex'), Buffer.from(signature(frozenParts.slice(0, 4).join(':')), 'hex')) ||
      frozenParts[0] !== currentParts[0] || frozenParts[1] !== currentParts[1]) {
    throw historyError('history_snapshot_changed')
  }
  const frozenActive = frozenParts[2] === '1'
  const snapshot = request.snapshot ?? version.version
  let turns: RemoteHistoryTurnsPage['turns']
  let offset: number
  let totalTurns: number
  let source: RemoteHistoryTurnsPage['source']

  if (args.providerId === 'claude') {
    const path = resolveTranscriptPath(args)
    const transcript = path
      ? parseTranscriptToTurns(await readFile(path, 'utf8'), {
        runId: args.sessionId, newId: randomUUID, now: () => new Date().toISOString()
      })
      : []
    const archived = await readTraceArchiveAsync(args)
    if (!path && !archived && !run) throw historyError('history_unavailable')
    const merged = mergeSessionTurns(transcript, archived, { userDataDir: args.userDataDir })
    totalTurns = merged.length + (frozenActive ? 1 : 0)
    const end = request.before ?? totalTurns
    if (end > totalTurns) throw historyError('invalid_history_cursor')
    offset = Math.max(0, end - request.limit)
    turns = merged.slice(offset, Math.min(end, merged.length)).map((turn) => ({
      userText: turn.userText, items: flattenTraceItems(turn.items)
    }))
    if (frozenActive && end > merged.length) {
      if (!run || snapshot !== version.version) throw historyError('history_snapshot_changed')
      turns.push({ userText: run.userText, items: flattenTraceItems(run.items) })
    }
    source = frozenActive && end > merged.length ? 'active_memory' : path ? 'claude_transcript' : version.readMode === 'indexed' ? 'indexed_archive' : version.readMode
  } else {
    const page = await readTraceArchivePageAsync(args, {
      ...(request.before !== undefined ? { before: request.before } : {}),
      limit: request.before === undefined && frozenActive ? Math.max(1, request.limit - 1) : request.limit
    })
    if (!page.archive && (!run || !frozenActive)) throw historyError('history_unavailable')
    totalTurns = page.totalTurns + (frozenActive ? 1 : 0)
    const end = request.before ?? totalTurns
    if (end > totalTurns) throw historyError('invalid_history_cursor')
    offset = Math.max(0, end - request.limit)
    const archivedEnd = Math.min(end, page.totalTurns)
    const archived = page.archive?.turns ?? []
    turns = archived.slice(Math.max(0, offset - page.offset), Math.max(0, archivedEnd - page.offset))
      .map((turn) => ({ userText: turn.userText, items: flattenTraceItems(turn.items) }))
    if (frozenActive && end > page.totalTurns) {
      if (!run || snapshot !== version.version) throw historyError('history_snapshot_changed')
      turns.push({ userText: run.userText, items: flattenTraceItems(run.items) })
    }
    source = frozenActive && end > page.totalTurns ? 'active_memory' : page.readMode === 'indexed' ? 'indexed_archive' : page.readMode
  }

  // Cache/index creation is not an evidence change. A persistent transcript or
  // archive write during the read is; never combine bodies from two versions.
  const latest = await sourceVersion(args, run)
  const latestParts = latest.version.split(':')
  if (latestParts[0] !== currentParts[0] || latestParts[1] !== currentParts[1]) throw historyError('history_snapshot_changed')
  const end = request.before ?? totalTurns
  return {
    turns, offset, totalTurns, hasOlder: offset > 0, snapshot, source,
    completeness: offset === 0 && end === totalTurns && !frozenActive ? 'complete' : 'partial'
  }
}
