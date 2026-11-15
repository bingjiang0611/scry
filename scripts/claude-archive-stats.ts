// Read-only statistics over the Claude history evidence of a real userData directory.
//
//   vite-node scripts/claude-archive-stats.ts <realUserData> <homeDir> [out.json]
//
// Nothing here reads through the production archive readers: they rebuild and persist a page
// index, which would mutate the user's store. The script only walks directories, parses the
// already-persisted index files and stats provider transcripts, so it can run against a live
// userData directory without a snapshot.
//
// Output is aggregate plus one row per session keyed by hash: no prompts, transcript or tool
// content is read, and workspace paths are reported only as counts.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { transcriptPath } from '../src/main/transcript-archive'

const [realUserData, homeDir, outPath] = process.argv.slice(2)
if (!realUserData || !homeDir) throw new Error('usage: claude-archive-stats.ts <realUserData> <homeDir> [out.json]')

const fileBytes = (path: string): number | null => {
  try {
    const stat = statSync(path)
    return stat.isFile() ? stat.size : null
  } catch { return null }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16)

/** Catalog: what the App believes exists, per Provider. */
interface CatalogSession {
  providerId: string
  sessionId: string
  externalSessionId?: string
  cwd?: string
}
const catalogPath = join(realUserData, 'app-sessions.json')
const catalog: CatalogSession[] = existsSync(catalogPath)
  ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogSession[])
  : []
const byProvider: Record<string, number> = {}
for (const session of catalog) byProvider[session.providerId] = (byProvider[session.providerId] ?? 0) + 1

/** Segmented archive: one directory per cwd/session, one canonical file per turn. */
interface ArchiveRow {
  key: string
  bound: boolean
  turnFiles: number
  turnBytes: number
  indexFile: boolean
  indexVersion: number | null
  indexEntries: number | null
  indexSourceComplete: boolean | null
}
const rows: ArchiveRow[] = []
const archiveRoot = join(realUserData, 'trace-archive-turns-v1', 'claude')
if (existsSync(archiveRoot)) {
  for (const cwdEntry of readdirSync(archiveRoot, { withFileTypes: true })) {
    if (!cwdEntry.isDirectory()) continue
    const cwdDir = join(archiveRoot, cwdEntry.name)
    for (const sessionEntry of readdirSync(cwdDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const dir = join(cwdDir, sessionEntry.name)
      const files = readdirSync(dir).filter((name) => /^turn-.+\.json$/.test(name))
      let turnBytes = 0
      for (const name of files) turnBytes += fileBytes(join(dir, name)) ?? 0
      // The persisted base index sits beside the session directory.
      const indexPath = `${dir}.index-v1.json`
      let indexVersion: number | null = null
      let indexEntries: number | null = null
      let indexSourceComplete: boolean | null = null
      if (existsSync(indexPath)) {
        try {
          const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { version?: number; entries?: unknown[]; sourceComplete?: boolean }
          indexVersion = typeof parsed.version === 'number' ? parsed.version : null
          indexEntries = Array.isArray(parsed.entries) ? parsed.entries.length : null
          indexSourceComplete = typeof parsed.sourceComplete === 'boolean' ? parsed.sourceComplete : null
        } catch { /* an unreadable index is reported as absent evidence */ }
      }
      rows.push({
        key: hash(dir), bound: cwdEntry.name !== 'unbound', turnFiles: files.length, turnBytes,
        indexFile: existsSync(indexPath), indexVersion, indexEntries, indexSourceComplete
      })
    }
  }
}

/** Monolithic archives: the pre-paging store, one file per session. */
const monolithicRoot = join(realUserData, 'trace-archives-v2', 'claude')
let monolithicFiles = 0
let monolithicBytes = 0
if (existsSync(monolithicRoot)) {
  for (const entry of readdirSync(monolithicRoot, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const bytes = fileBytes(join(entry.parentPath ?? entry.path, entry.name)) ?? 0
    monolithicFiles += 1
    monolithicBytes += bytes
  }
}

/** Provider transcripts: only their size is needed; the App must resolve the same path. */
const claudeSessions = catalog.filter((session) => session.providerId === 'claude')
const transcripts = claudeSessions.map((session) => {
  const externalId = session.externalSessionId ?? session.sessionId
  const path = session.cwd ? transcriptPath(session.cwd, externalId, homeDir) : null
  const bytes = path ? fileBytes(path) : null
  return { externalId: hash(externalId), resolvable: bytes != null, bytes }
})
const resolvable = transcripts.filter((entry) => entry.bytes != null)
const bucket = (value: number): string =>
  value < 1 << 20 ? '<1MB' : value < 8 << 20 ? '1-8MB' : value < 32 << 20 ? '8-32MB' : '>=32MB'
const distribution = (values: readonly number[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const value of values) counts[bucket(value)] = (counts[bucket(value)] ?? 0) + 1
  return counts
}

const summary = {
  generatedAt: new Date().toISOString(),
  catalog: { total: catalog.length, byProvider },
  claude: {
    catalogSessions: claudeSessions.length,
    catalogSessionsWithCwd: claudeSessions.filter((session) => Boolean(session.cwd)).length,
    transcripts: {
      resolvable: resolvable.length,
      bytesTotal: resolvable.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
      distribution: distribution(resolvable.map((entry) => entry.bytes ?? 0)),
      over32MiB: resolvable.filter((entry) => (entry.bytes ?? 0) >= 32 * 1024 * 1024).length
    },
    segmented: {
      sessions: rows.length,
      boundToWorkspace: rows.filter((row) => row.bound).length,
      unbound: rows.filter((row) => !row.bound).length,
      turnFiles: rows.reduce((total, row) => total + row.turnFiles, 0),
      turnBytes: rows.reduce((total, row) => total + row.turnBytes, 0),
      withIndex: rows.filter((row) => row.indexFile).length,
      indexVersions: rows.filter((row) => row.indexVersion != null).map((row) => row.indexVersion),
      indexSourceComplete: rows.filter((row) => row.indexSourceComplete === true).length,
      turnCounts: rows.map((row) => ({ key: row.key, bound: row.bound, turnFiles: row.turnFiles, indexEntries: row.indexEntries }))
    },
    monolithic: { files: monolithicFiles, bytes: monolithicBytes }
  }
}
const report = { summary, transcripts: transcripts.map((entry) => ({ key: entry.externalId, resolvable: entry.resolvable, bytes: entry.bytes })), rows }
if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`SCRY_CLAUDE_ARCHIVE_STATS=${JSON.stringify(summary)}`)
