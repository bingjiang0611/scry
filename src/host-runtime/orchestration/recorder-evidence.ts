import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative } from 'node:path'
import type Database from 'better-sqlite3'
import type { EventSink } from './event-sink'
import type { RecorderTerminalEvidence } from './recovery'

const require = createRequire(import.meta.url)

function ownedCwdKey(cwd: string): string {
  if (cwd === '') return 'unbound'
  if (!isAbsolute(cwd)) return ''
  return `cwd-${createHash('sha256').update(cwd).digest('hex')}`
}

function turnFileNameForRun(runId: string): string {
  const hash = createHash('sha256').update(`run\0${runId}`).digest('hex')
  return `turn-${hash}.json`
}

interface ArchiveTurnFile {
  turns?: Array<{
    runId?: string
    done?: boolean
    status?: string
    error?: string
    completedAt?: string
    ts?: number
  }>
}

function parseArchiveTurnEvidence(
  userDataDir: string,
  filePath: string,
  fileName: string,
  runId: string
): RecorderTerminalEvidence | undefined {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) return undefined
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ArchiveTurnFile
    const turn = parsed?.turns?.find((candidate) => candidate?.runId === runId)
    if (!turn || turn.done !== true) return undefined
    // Interrupted archive turns are NOT proven terminal completions; leave honest `interrupted`.
    if (turn.status === 'interrupted') return undefined
    const parsedCompleted = turn.completedAt ? Date.parse(turn.completedAt) : Number.NaN
    const settledAt = Number.isFinite(parsedCompleted)
      ? parsedCompleted
      : typeof turn.ts === 'number' && Number.isFinite(turn.ts)
        ? turn.ts
        : Date.now()
    const isFailed = turn.status === 'error' || turn.status === 'failed' || Boolean(turn.error)
    return {
      outcome: isFailed ? 'failed' : 'settled',
      settledAt,
      ...(isFailed && turn.error ? { reason: turn.error } : {}),
      contentRef: relative(userDataDir, filePath),
      evidence: [`trace-archive:${fileName}`]
    }
  } catch {
    return undefined
  }
}

function findInTraceArchive(
  userDataDir: string,
  runId: string,
  hint: { provider: string | null; cwd: string | null }
): RecorderTerminalEvidence | undefined {
  const root = join(userDataDir, 'trace-archive-turns-v1')
  if (!existsSync(root)) return undefined
  const fileName = turnFileNameForRun(runId)

  const searchCwdDir = (cwdDir: string): RecorderTerminalEvidence | undefined => {
    try {
      if (!lstatSync(cwdDir).isDirectory()) return undefined
      for (const sidEntry of readdirSync(cwdDir, { withFileTypes: true })) {
        if (!sidEntry.isDirectory() || sidEntry.isSymbolicLink()) continue
        const candidate = join(cwdDir, sidEntry.name, fileName)
        if (!existsSync(candidate)) continue
        const found = parseArchiveTurnEvidence(userDataDir, candidate, fileName, runId)
        if (found) return found
      }
    } catch {
      return undefined
    }
    return undefined
  }

  // Fast path when run provider + cwd are known.
  if (hint.provider && hint.cwd) {
    const key = ownedCwdKey(hint.cwd)
    if (key) {
      const direct = searchCwdDir(join(root, hint.provider, key))
      if (direct) return direct
    }
  }

  // Fallback bounded scan of exact hash filename across provider/cwd directories.
  try {
    for (const providerEntry of readdirSync(root, { withFileTypes: true })) {
      if (!providerEntry.isDirectory() || providerEntry.isSymbolicLink()) continue
      const providerDir = join(root, providerEntry.name)
      for (const cwdEntry of readdirSync(providerDir, { withFileTypes: true })) {
        if (!cwdEntry.isDirectory() || cwdEntry.isSymbolicLink()) continue
        const found = searchCwdDir(join(providerDir, cwdEntry.name))
        if (found) return found
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function findInScryDbSpans(userDataDir: string, runId: string): RecorderTerminalEvidence | undefined {
  const dbPath = join(userDataDir, 'scry.db')
  if (!existsSync(dbPath)) return undefined
  let db: Database.Database | undefined
  try {
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true })
    const row = db
      .prepare(
        "SELECT id, ts_end, ts_start, is_error FROM spans WHERE run_id = ? AND kind = 'harness' AND stage = 'result' ORDER BY ts_end DESC LIMIT 1"
      )
      .get(runId) as { id: string; ts_end: number | null; ts_start: number | null; is_error: number | null } | undefined
    if (!row) return undefined
    const settledAt = Number(row.ts_end ?? row.ts_start ?? Date.now())
    return {
      outcome: row.is_error ? 'failed' : 'settled',
      settledAt: Number.isFinite(settledAt) ? settledAt : Date.now(),
      evidence: [`scry-db:span:${row.id}`]
    }
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close error on read-only lookup
    }
  }
}

/**
 * Production recorder-evidence lookup for P4-2 startup recovery (`core §2.4`).
 * Checks committed `trace-archive-turns-v1` turn files first, then committed `scry.db` result spans.
 * Returns `undefined` when no committed terminal evidence exists so recovery honestly marks `interrupted`.
 */
export function createRecorderEvidenceFinder(
  userDataDir: string,
  sink: EventSink
): (runId: string) => RecorderTerminalEvidence | undefined {
  return (runId: string) => {
    const run = sink.getRun(runId)
    const fromArchive = findInTraceArchive(userDataDir, runId, {
      provider: run?.provider ?? null,
      cwd: run?.cwd ?? null
    })
    if (fromArchive) return fromArchive
    return findInScryDbSpans(userDataDir, runId)
  }
}
