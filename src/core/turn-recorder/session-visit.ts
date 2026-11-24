import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { ProviderId } from '../../shared/provider.js'
import { sessionFailureKey } from './session-failures.js'

/**
 * A quiet session re-judged every recovery pass costs the same work for the same answer. Once a
 * pass has judged a session "still open, and its own files say nothing has happened for longer than
 * the stale window", nothing but new evidence can change that verdict — more silence cannot. So the
 * session is revisited hourly instead of every pass, and at once when anything moves:
 *
 *   - any hook for that session forgets the record (`forgetSessionVisit`);
 *   - any change to a file this pass reads changes the fingerprint, so the next pass visits it.
 *
 * A session whose `open.json` records its host process is never deferred at all: that turn can be
 * closed when the recorded host exits, and no file changes when that happens. Silence plus a dead
 * host is evidence; silence alone never is.
 *
 * This is scheduling only. It never closes a turn, drops a marker, or touches evidence. It is
 * deliberately in-memory: a restart re-visits everything once, which is the safe direction. Only
 * sessions still unresolved are kept, so the map holds the quiet ones and nothing else.
 */
export const SESSION_REVISIT_MS = 60 * 60 * 1_000
/** How long a session's own files must have been still before more silence stops being interesting. */
export const SESSION_QUIET_MS = 30 * 60 * 1_000

interface SessionVisit {
  fingerprint: string
  /** How long this session's files had been still when that pass judged it. */
  quietMs: number
  at: number
}

const visits = new Map<string, Map<string, SessionVisit>>()

function visitsOf(dataRoot: string): Map<string, SessionVisit> {
  let bySession = visits.get(dataRoot)
  if (!bySession) {
    bySession = new Map()
    visits.set(dataRoot, bySession)
  }
  return bySession
}

async function statKey(path: string): Promise<{ key: string; mtimeMs: number }> {
  try {
    const info = await stat(path)
    return { key: `${info.size}:${Math.round(info.mtimeMs)}`, mtimeMs: info.mtimeMs }
  } catch {
    return { key: '-', mtimeMs: 0 }
  }
}

async function openPointers(sessionDir: string): Promise<{
  generation: number | null
  transcriptPath: string | null
  /** Whether the turn recorded the host processes that could later be proven gone. */
  hostRecorded: boolean
}> {
  try {
    const open = JSON.parse(await readFile(join(sessionDir, 'open.json'), 'utf8')) as {
      generation?: unknown
      transcriptPath?: unknown
      host?: unknown
    }
    return {
      generation: typeof open.generation === 'number' ? open.generation : null,
      transcriptPath: typeof open.transcriptPath === 'string' && open.transcriptPath ? open.transcriptPath : null,
      hostRecorded: Array.isArray(open.host) && open.host.length > 0
    }
  } catch {
    return { generation: null, transcriptPath: null, hostRecorded: false }
  }
}

/**
 * Everything this pass reacts to, plus when it last moved. Sizes and mtimes are enough: a hook that
 * rewrites a state file or queues inbox work changes one of them, a directory's own stat changes
 * when entries appear in it, and a transcript only ever grows.
 */
async function evidence(sessionDir: string, now: number): Promise<{ fingerprint: string; quietMs: number; hostRecorded: boolean }> {
  const { generation, transcriptPath, hostRecorded } = await openPointers(sessionDir)
  const turnDir = generation === null ? null : join(sessionDir, 'turns', String(generation))
  const parts = await Promise.all([
    statKey(sessionDir),
    statKey(join(sessionDir, 'open.json')),
    statKey(join(sessionDir, 'session.json')),
    statKey(join(sessionDir, 'inbox')),
    statKey(join(sessionDir, 'turns')),
    turnDir ? statKey(turnDir) : undefined,
    turnDir ? statKey(join(turnDir, 'events')) : undefined,
    turnDir ? statKey(join(turnDir, 'pending-open.json')) : undefined,
    transcriptPath ? statKey(transcriptPath) : undefined
  ])
  const lastMoved = Math.max(...parts.map((part) => part?.mtimeMs ?? 0))
  return {
    fingerprint: parts.map((part) => part?.key ?? '-').join('|'),
    quietMs: lastMoved > 0 ? Math.max(0, now - lastMoved) : 0,
    hostRecorded
  }
}

/** Drop a session's record: a new event means the next pass must look again, whatever its files show. */
export function forgetSessionVisit(dataRoot: string, provider: ProviderId, sessionKey: string): void {
  visits.get(dataRoot)?.delete(sessionFailureKey(provider, sessionKey))
}

/**
 * True when this pass can skip the session: a previous pass already judged it unresolved, its files
 * have not moved since, and they had already been still for the whole stale window back then.
 */
export async function deferQuietSession(
  dataRoot: string,
  provider: ProviderId,
  sessionDir: string,
  now = Date.now()
): Promise<boolean> {
  const previous = visits.get(dataRoot)?.get(sessionFailureKey(provider, basename(sessionDir)))
  if (!previous) return false
  if (previous.quietMs < SESSION_QUIET_MS) return false
  if (now - previous.at >= SESSION_REVISIT_MS) return false
  const current = await evidence(sessionDir, now)
  // A recorded host can be proven gone without anything on disk moving, so those wait for nothing.
  if (current.hostRecorded) return false
  return current.fingerprint === previous.fingerprint
}

/** Remember what this pass saw. Only a still-unresolved, already-quiet session becomes deferrable. */
export async function recordSessionVisit(
  dataRoot: string,
  provider: ProviderId,
  sessionDir: string,
  options: { unresolved: boolean },
  now = Date.now()
): Promise<void> {
  const key = sessionFailureKey(provider, basename(sessionDir))
  const { fingerprint, quietMs, hostRecorded } = await evidence(sessionDir, now)
  if (!options.unresolved || hostRecorded) {
    visits.get(dataRoot)?.delete(key)
    return
  }
  visitsOf(dataRoot).set(key, { fingerprint, quietMs, at: now })
}
