import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import type { ActiveRun } from '../../shared/trace'
import { parseTranscriptToTurns } from '../normalize'
import { mergeSessionTurns, type LoadedSessionTurn } from '../session-history'
import { readPiDisplayHistory, readPiNativeHistoryRevision } from '../pi-native-history'
import { readTraceArchiveAsync, readTraceArchivePageAsync, readTraceArchiveVersionAsync, resolveTranscriptPath } from '../transcript-archive'
import type { RemoteHistoryScope, RemoteHistoryTurn, RemoteHistoryPreview, RemoteHistoryTurnsPage, RemoteHistoryVersion } from './remote-gateway'
import { flattenTraceItems } from './trace-output'

type HistoryContext = Parameters<typeof readTraceArchiveVersionAsync>[0] & {
  historyScope?: RemoteHistoryScope
  // Pi native history is read-only evidence. The caller supplies the fixed,
  // host-owned default root; profile-owned custom launchers are not guessed.
  piSessionRoot?: string
}
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

function historyError(code: 'history_unavailable' | 'history_profile_unavailable' | 'history_snapshot_changed' | 'invalid_history_cursor' | 'history_capacity_exceeded'): Error {
  return Object.assign(new Error(code), { code })
}

// runId is the Scry run id recorded with the archived/active turn. A device
// matches it against the `bound` ledger marker of its own run, so it can drop
// its local copy only when the host record provably contains that run.
// Transcript-only turns have no Scry run and carry no id.
function pageTurn(turn: { runId?: string; userText: string; items: Parameters<typeof flattenTraceItems>[0] }): RemoteHistoryTurnsPage['turns'][number] {
  return { ...(turn.runId ? { runId: turn.runId } : {}), userText: turn.userText, items: flattenTraceItems(turn.items) }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function sourceVersion(args: HistoryContext, run: HistoryRun | undefined): Promise<RemoteHistoryVersion> {
  const archive = await readTraceArchiveVersionAsync(args)
  let native: string | null = null
  if (!run && args.historyScope === 'session' && args.providerId === 'pi' && args.piSessionRoot) {
    try { native = await readPiNativeHistoryRevision({ sessionRoot: args.piSessionRoot, cwd: args.cwd, sessionId: args.sessionId }) }
    catch (error) {
      // A version probe is not a native-content read. The page reader applies
      // the desktop's archive-preserving recovery policy and reports its warning.
      native = `unavailable:${error instanceof Error ? error.message : String(error)}`
    }
  }
  const strictProfile = args.historyScope === 'profile' || (args.historyScope === undefined && Object.hasOwn(args, 'agentProfileId'))
  const path = args.providerId === 'claude' && !strictProfile ? resolveTranscriptPath(args) : null
  const transcript = path ? await stat(path) : null
  // These are source revisions, not a complete-history content digest. The
  // separate persistent-source prefix lets older archive pages retain their
  // frozen total while live text advances; the captured live turn stays partial.
  const transcriptVersion = hash(transcript && [path, transcript.size, transcript.mtimeMs, transcript.ctimeMs])
  const activeVersion = hash(run ? { runId: run.runId, userText: run.userText, items: run.items } : null)
  const nativeVersion = hash(native)
  const token = `${archive.version}:${transcriptVersion}:${run ? 1 : 0}:${activeVersion}:${nativeVersion}`
  return { version: `${token}:${signature(token)}`, readMode: archive.readMode }
}

function selectedActive(args: HistoryContext, active: ActiveReader): ActiveRun | undefined {
  const run = active()
  return run && (!Object.hasOwn(args, 'agentProfileId') || (run.agentProfileId ?? null) === args.agentProfileId) ? run : undefined
}

export async function readRemoteHistoryVersion(args: HistoryContext, active: ActiveReader): Promise<RemoteHistoryVersion> {
  return sourceVersion(args, selectedActive(args, active))
}

type SessionDisplay = { turns: RemoteHistoryTurn[]; source: RemoteHistoryTurnsPage['source']; sourceWarning?: 'native_unavailable' }
const MAX_SESSION_BYTES = 256 * 1024 * 1024
const sessionDisplays = new Map<string, { value: SessionDisplay; bytes: number }>()
const sessionBuilds = new Map<string, Promise<SessionDisplay>>()

async function readSessionTurns(args: HistoryContext, active: boolean): Promise<SessionDisplay> {
  let archived: Awaited<ReturnType<typeof readTraceArchiveAsync>>
  try { archived = await readTraceArchiveAsync(args, undefined, true) }
  catch (error) {
    // Unknown Profile provenance is allowed for display; corrupt canonical
    // turns must not be silently omitted from a purported complete session.
    if ((error as { code?: string }).code === 'history_profile_unavailable') throw historyError('history_unavailable')
    throw error
  }
  let nativeWarning = false
  if (args.providerId === 'pi' && args.piSessionRoot) {
    const native = await readPiDisplayHistory({
      sessionRoot: args.piSessionRoot, cwd: args.cwd, sessionId: args.sessionId, active
    }, archived ? async () => mergeSessionTurns([], archived, { userDataDir: args.userDataDir }, { hydrateAttachments: false }) : undefined)
    if (native.turns) return { turns: native.turns.map(pageTurn), source: 'pi_native' }
    nativeWarning = Boolean(native.error)
  }
  let transcript: LoadedSessionTurn[] = []
  if (args.providerId === 'claude') {
    const path = resolveTranscriptPath(args)
    if (path) {
      try {
        transcript = parseTranscriptToTurns(await readFile(path, 'utf8'), {
          runId: args.sessionId, newId: randomUUID, now: () => new Date().toISOString()
        })
      } catch (error) {
        if (!archived) throw error
        nativeWarning = true
      }
    }
  }
  const turns = mergeSessionTurns(transcript, archived, { userDataDir: args.userDataDir })
  if (!turns.length && !archived && !transcript.length && !active) throw historyError('history_unavailable')
  return { turns: turns.map(pageTurn), source: transcript.length ? 'claude_transcript' : 'monolithic',
    ...(nativeWarning ? { sourceWarning: 'native_unavailable' as const } : {}) }
}

// Native reconciliation needs the whole selected branch, as on desktop. Build
// once per persistent revision, then page the projection. At most two cached
// sessions, 256 MiB total text/object budget and two concurrent materializations.
// Larger histories need an on-disk projection index, not a larger IPC payload.
async function sessionDisplay(args: HistoryContext, parts: string[], active: boolean): Promise<SessionDisplay> {
  const key = JSON.stringify([args.cwd, args.providerId, args.sessionId, args.userDataDir,
    args.agentProfileId, args.piSessionRoot, parts[0], parts[1], parts[4], active])
  const cached = sessionDisplays.get(key)
  if (cached) {
    sessionDisplays.delete(key)
    sessionDisplays.set(key, cached)
    return cached.value
  }
  const pending = sessionBuilds.get(key)
  if (pending) return pending
  if (sessionBuilds.size >= 2) throw historyError('history_capacity_exceeded')
  const build = readSessionTurns(args, active).then(value => {
    const bytes = value.turns.reduce((sum, turn) => sum + 256 + turn.userText.length * 2 +
      turn.items.reduce((size, item) => size + 256 + item.text.length * 2, 0), 0)
    if (bytes > MAX_SESSION_BYTES) throw historyError('history_capacity_exceeded')
    let retained = [...sessionDisplays.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    while (sessionDisplays.size >= 2 || retained + bytes > MAX_SESSION_BYTES) {
      const oldest = sessionDisplays.keys().next().value!
      retained -= sessionDisplays.get(oldest)!.bytes
      sessionDisplays.delete(oldest)
    }
    sessionDisplays.set(key, { value, bytes })
    return value
  }).finally(() => sessionBuilds.delete(key))
  sessionBuilds.set(key, build)
  return build
}

// Read only the requested archive window. Claude retains the desktop's native
// transcript/archive merge authority; its host-side parse is not constant-time.
export async function readRemoteHistoryTurnsPage(
  args: HistoryContext, request: PageRequest, active: ActiveReader
): Promise<RemoteHistoryTurnsPage> {
  const current = selectedActive(args, active)
  const run = current ? { runId: current.runId, userText: current.userText, items: structuredClone(current.items) } : undefined
  const version = await sourceVersion(args, run)
  const currentParts = version.version.split(':')
  const frozenParts = request.snapshot?.split(':') ?? currentParts
  if (frozenParts.length !== 6 || ![frozenParts[0], frozenParts[1], frozenParts[3], frozenParts[4]].every(value => /^[a-f0-9]{64}$/.test(value)) ||
      !['0', '1'].includes(frozenParts[2]) || !/^[a-f0-9]{32}$/.test(frozenParts[5]) ||
      !timingSafeEqual(Buffer.from(frozenParts[5], 'hex'), Buffer.from(signature(frozenParts.slice(0, 5).join(':')), 'hex')) ||
      frozenParts[0] !== currentParts[0] || frozenParts[1] !== currentParts[1] || frozenParts[4] !== currentParts[4]) {
    throw historyError('history_snapshot_changed')
  }
  const frozenActive = frozenParts[2] === '1'
  const snapshot = request.snapshot ?? version.version
  let turns: RemoteHistoryTurnsPage['turns']
  let offset: number
  let totalTurns: number
  let source: RemoteHistoryTurnsPage['source']
  let sourceWarning: 'native_unavailable' | undefined

  if (args.historyScope === 'session') {
    const session = await sessionDisplay(args, currentParts, Boolean(run))
    sourceWarning = session.sourceWarning
    const activeIncluded = Boolean(run && session.turns.some((turn) => turn.runId === run.runId))
    const activeTail = frozenActive && !activeIncluded
    totalTurns = session.turns.length + (activeTail ? 1 : 0)
    const end = request.before ?? totalTurns
    if (end > totalTurns) throw historyError('invalid_history_cursor')
    offset = Math.max(0, end - request.limit)
    turns = session.turns.slice(offset, Math.min(end, session.turns.length))
    if (activeTail && end > session.turns.length) {
      if (!run || snapshot !== version.version) throw historyError('history_snapshot_changed')
      turns.push(pageTurn(run))
    }
    source = activeTail && end > session.turns.length ? 'active_memory' : session.source
  } else if (args.providerId === 'claude' && !Object.hasOwn(args, 'agentProfileId')) {
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
    turns = merged.slice(offset, Math.min(end, merged.length)).map(pageTurn)
    if (frozenActive && end > merged.length) {
      if (!run || snapshot !== version.version) throw historyError('history_snapshot_changed')
      turns.push(pageTurn(run))
    }
    source = frozenActive && end > merged.length ? 'active_memory' : path ? 'claude_transcript' : version.readMode === 'indexed' ? 'indexed_archive' : version.readMode
  } else {
    const page = await readTraceArchivePageAsync(args, {
      ...(Object.hasOwn(args, 'agentProfileId') ? { agentProfileId: args.agentProfileId } : {}),
      ...(request.before !== undefined ? { before: request.before } : {}),
      limit: request.before === undefined && frozenActive ? Math.max(1, request.limit - 1) : request.limit
    })
    if (!page.archive && (!run || !frozenActive)) throw historyError(Object.hasOwn(args, 'agentProfileId') ? 'history_profile_unavailable' : 'history_unavailable')
    totalTurns = page.totalTurns + (frozenActive ? 1 : 0)
    const end = request.before ?? totalTurns
    if (end > totalTurns) throw historyError('invalid_history_cursor')
    offset = Math.max(0, end - request.limit)
    const archivedEnd = Math.min(end, page.totalTurns)
    const archived = page.archive?.turns ?? []
    turns = archived.slice(Math.max(0, offset - page.offset), Math.max(0, archivedEnd - page.offset)).map(pageTurn)
    if (frozenActive && end > page.totalTurns) {
      if (!run || snapshot !== version.version) throw historyError('history_snapshot_changed')
      turns.push(pageTurn(run))
    }
    source = frozenActive && end > page.totalTurns ? 'active_memory' : page.readMode === 'indexed' ? 'indexed_archive' : page.readMode
  }

  // Cache/index creation is not an evidence change. A persistent transcript or
  // archive write during the read is; never combine bodies from two versions.
  const latest = await sourceVersion(args, run)
  const latestParts = latest.version.split(':')
  if (latestParts[0] !== currentParts[0] || latestParts[1] !== currentParts[1] || latestParts[4] !== currentParts[4]) throw historyError('history_snapshot_changed')
  const end = request.before ?? totalTurns
  return {
    turns, offset, totalTurns, hasOlder: offset > 0, snapshot, source,
    ...(sourceWarning ? { sourceWarning } : {}),
    completeness: offset === 0 && end === totalTurns && !frozenActive ? 'complete' : 'partial'
  }
}

export async function readRemoteProfileHistory(args: HistoryContext, active: ActiveReader): Promise<RemoteHistoryTurn[]> {
  const pages: RemoteHistoryTurn[][] = []
  let before: number | undefined, snapshot: string | undefined, bytes = 0
  while (true) {
    const page = await readRemoteHistoryTurnsPage(args, { before, snapshot, limit: 200 }, active)
    bytes += Buffer.byteLength(JSON.stringify(page.turns))
    if (bytes > 256 * 1024 * 1024) throw Object.assign(new Error('history_capacity_exceeded'), { code: 'history_capacity_exceeded' })
    pages.push(page.turns)
    if (!page.hasOlder) return pages.reverse().flat()
    before = page.offset; snapshot = page.snapshot
  }
}

export async function readRemoteProfilePreview(args: HistoryContext, active: ActiveReader): Promise<RemoteHistoryPreview> {
  const page = await readRemoteHistoryTurnsPage(args, { limit: 2 }, active)
  return {
    status: 'available', source: page.source === 'claude_transcript' ? 'monolithic' : page.source,
    turns: page.turns.map((turn) => ({ userText: turn.userText, userTextTruncated: false,
      items: turn.items.map((item) => ({ ...item, truncated: false })), truncated: false })),
    partial: true, truncated: page.hasOlder, bytes: 0
  }
}
