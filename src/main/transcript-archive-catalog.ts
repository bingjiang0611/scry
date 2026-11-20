import { existsSync, unlinkSync } from 'node:fs'
import { lstat, readdir, readFile, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import {
  DEFAULT_TRACE_DISCOVERY_BUDGET,
  DISCOVERABLE_PROVIDER_IDS,
  TRACE_ARCHIVE_TURN_FILE,
  TRACE_DISCOVERY_MAX_FILE_BYTES,
  TRACE_DISCOVERY_MAX_FILES,
  TRACE_INDEX_DIRTY_FILE,
  TRACE_INDEX_FILE,
  TRACE_INDEX_MAX_BYTES,
  type TraceArchive,
  type TraceArchiveSessionSummary,
  type TraceDiscoveryBudget,
  trustedOwnedFile,
  trustedOwnedParent,
  writeOwnedFileAtomically,
  writeOwnedFileAtomicallyAsync
} from './transcript-archive-paths'

let traceArchiveCatalogWriteGeneration = 0

interface TraceArchiveCatalogIndexEntry {
  path: string
  size: number
  mtimeMs: number
  cwd: string
  sessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  firstPrompt: string
  firstTs: number
  latestRunId: string
  latestTs: number
}

interface TraceArchiveCatalogIndex {
  version: 1
  // Absent: the index covers every discoverable Provider. Present: only these Providers were scanned.
  providers?: ProviderId[]
  entries: TraceArchiveCatalogIndexEntry[]
}

function traceArchiveCatalogIndexPath(userDataDir: string): string {
  return join(userDataDir, TRACE_INDEX_FILE)
}

function traceArchiveCatalogIndexDirtyPath(userDataDir: string): string {
  return join(userDataDir, TRACE_INDEX_DIRTY_FILE)
}

function validIndexRelativePath(path: string): boolean {
  return /^(claude|codex|qoder|opencode|pi)\/(?:unbound|cwd-[a-f0-9]{64})\/sid-[a-f0-9]{64}\/turn-[a-f0-9]{64}\.json$/.test(path)
}

function indexSummaries(entries: TraceArchiveCatalogIndexEntry[]): TraceArchiveSessionSummary[] {
  const summaries = new Map<string, TraceArchiveSessionSummary & { firstTs: number }>()
  for (const entry of entries) {
    const key = `${entry.providerId}\0${entry.cwd}\0${entry.sessionId}`
    const current = summaries.get(key)
    if (!current) {
      summaries.set(key, {
        cwd: entry.cwd,
        sessionId: entry.sessionId,
        providerId: entry.providerId,
        runtimeProvider: entry.runtimeProvider,
        runId: entry.latestRunId,
        prompt: entry.firstPrompt,
        ts: entry.latestTs,
        firstTs: entry.firstTs
      })
      continue
    }
    if (entry.firstTs < current.firstTs) {
      current.firstTs = entry.firstTs
      current.prompt = entry.firstPrompt
    }
    if (entry.latestTs > current.ts) {
      current.ts = entry.latestTs
      current.runId = entry.latestRunId
      current.runtimeProvider = entry.runtimeProvider
    }
  }
  return [...summaries.values()].map(({ firstTs: _firstTs, ...summary }) => summary)
}

async function parseTraceArchiveCatalogIndexAsync(
  userDataDir: string,
  providers?: readonly ProviderId[]
): Promise<TraceArchiveCatalogIndexEntry[] | null> {
  const indexPath = traceArchiveCatalogIndexPath(userDataDir)
  try {
    if (existsSync(traceArchiveCatalogIndexDirtyPath(userDataDir))) return null
    trustedOwnedParent(userDataDir, indexPath, false)
    const indexStat = await lstat(indexPath)
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size <= 0 || indexStat.size > TRACE_INDEX_MAX_BYTES) return null
    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as Partial<TraceArchiveCatalogIndex>
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > TRACE_DISCOVERY_MAX_FILES) return null
    const scope = parsed.providers
    if (scope !== undefined) {
      if (!Array.isArray(scope) || !scope.every((id) => DISCOVERABLE_PROVIDER_IDS.has(id))) return null
      // A scoped index only answers requests inside its scope.
      if (!providers || providers.some((id) => !scope.includes(id))) return null
    }
    const seen = new Set<string>()
    const entries: TraceArchiveCatalogIndexEntry[] = []
    const archiveRoot = join(userDataDir, 'trace-archive-turns-v1')
    for (const value of parsed.entries) {
      if (!value || typeof value !== 'object') return null
      const entry = value as Partial<TraceArchiveCatalogIndexEntry>
      if (typeof entry.path !== 'string' || !validIndexRelativePath(entry.path) || seen.has(entry.path) ||
          typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > TRACE_DISCOVERY_MAX_FILE_BYTES ||
          typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs) ||
          typeof entry.cwd !== 'string' || typeof entry.sessionId !== 'string' || !entry.sessionId ||
          !DISCOVERABLE_PROVIDER_IDS.has(entry.providerId as ProviderId) || typeof entry.runtimeProvider !== 'string' ||
          typeof entry.firstPrompt !== 'string' || typeof entry.firstTs !== 'number' || !Number.isFinite(entry.firstTs) ||
          typeof entry.latestRunId !== 'string' || !entry.latestRunId || typeof entry.latestTs !== 'number' || !Number.isFinite(entry.latestTs)) return null
      if (scope && !scope.includes(entry.providerId as ProviderId)) return null
      seen.add(entry.path)
      if (providers && !providers.includes(entry.providerId as ProviderId)) continue
      const path = join(archiveRoot, entry.path)
      trustedOwnedParent(userDataDir, path, false)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) return null
      entries.push(entry as TraceArchiveCatalogIndexEntry)
    }
    return entries
  } catch {
    return null
  }
}

export async function scanTraceArchiveCatalogIndexAsync(
  userDataDir: string,
  budget: TraceDiscoveryBudget = DEFAULT_TRACE_DISCOVERY_BUDGET,
  providers?: readonly ProviderId[]
): Promise<{ entries: TraceArchiveCatalogIndexEntry[]; complete: boolean }> {
  const root = join(userDataDir, 'trace-archive-turns-v1')
  const entries: TraceArchiveCatalogIndexEntry[] = []
  let inspectedFiles = 0
  let inspectedBytes = 0
  try {
    for (const providerEntry of await readdir(root, { withFileTypes: true })) {
      if (!providerEntry.isDirectory() || providerEntry.isSymbolicLink() ||
          !DISCOVERABLE_PROVIDER_IDS.has(providerEntry.name as ProviderId)) continue
      const providerId = providerEntry.name as ProviderId
      if (providers && !providers.includes(providerId)) continue
      const providerDir = join(root, providerEntry.name)
      for (const cwdEntry of await readdir(providerDir, { withFileTypes: true })) {
        if (!cwdEntry.isDirectory() || cwdEntry.isSymbolicLink()) continue
        const cwdDir = join(providerDir, cwdEntry.name)
        for (const sessionEntry of await readdir(cwdDir, { withFileTypes: true })) {
          if (!sessionEntry.isDirectory() || sessionEntry.isSymbolicLink()) continue
          const sessionDir = join(cwdDir, sessionEntry.name)
          for (const fileEntry of await readdir(sessionDir, { withFileTypes: true })) {
            if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || !TRACE_ARCHIVE_TURN_FILE.test(fileEntry.name)) continue
            if (++inspectedFiles > budget.maxFiles) return { entries, complete: false }
            const path = join(sessionDir, fileEntry.name)
            if (!trustedOwnedFile(userDataDir, path)) continue
            const stat = await lstat(path)
            if (stat.size <= 0 || stat.size > budget.maxFileBytes) continue
            if (inspectedBytes + stat.size > budget.maxTotalBytes) return { entries, complete: false }
            inspectedBytes += stat.size
            let archive: TraceArchive
            try { archive = JSON.parse(await readFile(path, 'utf8')) as TraceArchive } catch { continue }
            if (!archive || !Array.isArray(archive.turns) || archive.providerId !== providerId ||
                typeof archive.cwd !== 'string' || typeof archive.sessionId !== 'string' || !archive.sessionId ||
                typeof archive.runtimeProvider !== 'string') continue
            const turns = archive.turns.filter((turn) =>
              turn && typeof turn.runId === 'string' && !!turn.runId && typeof turn.userText === 'string' &&
              typeof turn.ts === 'number' && Number.isFinite(turn.ts)
            )
            if (turns.length === 0) continue
            const first = turns.reduce((left, right) => left.ts <= right.ts ? left : right)
            const latest = turns.reduce((left, right) => left.ts >= right.ts ? left : right)
            entries.push({
              path: relative(root, path).split('\\').join('/'),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              cwd: archive.cwd,
              sessionId: archive.sessionId,
              providerId,
              runtimeProvider: archive.runtimeProvider,
              firstPrompt: first.userText,
              firstTs: first.ts,
              latestRunId: latest.runId,
              latestTs: latest.ts
            })
          }
        }
      }
    }
    return { entries, complete: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[scry] async trace archive catalog recovery failed:', (error as Error).message)
      return { entries, complete: false }
    }
    return { entries: [], complete: true }
  }
}

export async function markTraceArchiveCatalogIndexDirtyAsync(userDataDir: string): Promise<void> {
  traceArchiveCatalogWriteGeneration++
  const marker = traceArchiveCatalogIndexDirtyPath(userDataDir)
  if (trustedOwnedFile(userDataDir, marker)) return
  try { await writeOwnedFileAtomicallyAsync(userDataDir, marker, 'dirty\n') } catch {
    try { await unlink(traceArchiveCatalogIndexPath(userDataDir)) } catch { /* discovery will scan */ }
  }
}

export function markTraceArchiveCatalogIndexDirty(userDataDir: string): void {
  traceArchiveCatalogWriteGeneration++
  const marker = traceArchiveCatalogIndexDirtyPath(userDataDir)
  // The catalog is only a recovery hint. Once dirty, leave it dirty until discovery rebuilds it;
  // rewriting and revalidating the global catalog after every canonical turn made hot writes O(N).
  if (trustedOwnedFile(userDataDir, marker)) return
  try {
    writeOwnedFileAtomically(userDataDir, marker, 'dirty\n')
  } catch {
    // If the marker cannot be committed, remove the index so discovery cannot trust stale metadata.
    try { unlinkSync(traceArchiveCatalogIndexPath(userDataDir)) } catch { /* discovery will scan */ }
  }
}

/**
 * Recover Scry-owned session catalog metadata from canonical per-turn archives. Filesystem work
 * yields between files instead of blocking Electron main. `providers` limits the scan and the published index to those Providers.
 */
export async function discoverTraceArchiveSessionsAsync(
  userDataDir: string,
  providers?: readonly ProviderId[]
): Promise<TraceArchiveSessionSummary[]> {
  const indexed = await parseTraceArchiveCatalogIndexAsync(userDataDir, providers)
  if (indexed) return indexSummaries(indexed)
  const generation = traceArchiveCatalogWriteGeneration
  const scanned = await scanTraceArchiveCatalogIndexAsync(userDataDir, DEFAULT_TRACE_DISCOVERY_BUDGET, providers)
  // A write during the scan may belong to an already-enumerated directory. Keep its durable dirty
  // marker and do not publish.
  if (scanned.complete && generation === traceArchiveCatalogWriteGeneration) {
    try {
      const content = JSON.stringify({
        version: 1,
        ...(providers ? { providers: [...providers] } : {}),
        entries: scanned.entries
      } satisfies TraceArchiveCatalogIndex)
      if (Buffer.byteLength(content) > TRACE_INDEX_MAX_BYTES) throw new Error('trace archive index capacity exceeded')
      await writeOwnedFileAtomicallyAsync(userDataDir, traceArchiveCatalogIndexPath(userDataDir), content)
      // Check the generation and clear the marker in one synchronous step. An async unlink could run
      // after a newer write saw the existing marker and skipped writing its own.
      if (generation === traceArchiveCatalogWriteGeneration) {
        try { unlinkSync(traceArchiveCatalogIndexDirtyPath(userDataDir)) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      } else {
        // A write landed while the index was being published, so the index may miss it. If that
        // write also failed to commit its marker, it removed the index before our rename. Remove
        // our copy too so discovery rescans instead of trusting stale metadata.
        try { unlinkSync(traceArchiveCatalogIndexPath(userDataDir)) } catch { /* discovery will scan */ }
      }
    } catch (error) {
      console.warn('[scry] async trace archive index rebuild failed:', (error as Error).message)
    }
  }
  return indexSummaries(scanned.entries)
}
