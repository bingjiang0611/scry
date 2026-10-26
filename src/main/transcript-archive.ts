import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { copyFile, lstat, open as openFile, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { protectToolContent, workspaceToolContentPolicy } from '../core/turn-recorder/content-policy.js'
import type { ToolContentPolicy } from '../core/turn-recorder/tool-content.js'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDiffSnapshotStage, normalizeTurnDiffSnapshot, type TraceEvent } from '../shared/trace'
import type { AgentInputAttachment } from '../shared/runtime'
import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { AgentTurnRecord, TurnEvidence } from '../shared/turn-record'
import { storeAttachmentReferenceAsync, storeAttachmentReference, type StoredAttachment } from './attachment-store'

// Claude Code transcript 目录编码：路径里的 / . _ 都换成 -
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-')
}

export function transcriptDir(cwd: string, home = homedir()): string {
  return join(home, '.claude', 'projects', encodeCwd(cwd))
}

function nativeSessionFileStem(sessionId: string): string {
  if (
    sessionId !== '.' &&
    sessionId !== '..' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(sessionId)
  ) {
    return sessionId
  }
  return `opaque-${createHash('sha256').update(sessionId).digest('hex')}`
}

function ownedSessionFileStem(sessionId: string): string {
  return `sid-${createHash('sha256').update(sessionId).digest('hex')}`
}

export function transcriptPath(cwd: string, sessionId: string, home = homedir()): string {
  return join(transcriptDir(cwd, home), nativeSessionFileStem(sessionId) + '.jsonl')
}

function ownedCwdKey(cwd: string): string {
  if (cwd === '') return 'unbound'
  if (!isAbsolute(cwd)) throw new Error('Scry-owned cwd must be absolute')
  return `cwd-${createHash('sha256').update(cwd).digest('hex')}`
}

export function archivedTranscriptPath(userDataDir: string, cwd: string, sessionId: string): string {
  return join(userDataDir, 'transcripts', ownedCwdKey(cwd), ownedSessionFileStem(sessionId) + '.jsonl')
}

export interface TraceArchiveTurn {
  /** null = proven default runtime; absent = legacy/unknown Profile provenance. */
  agentProfileId?: string | null
  toolContentPolicy?: ToolContentPolicy
  runId: string
  providerTurnId?: string
  forkTurnId?: string
  userText: string
  attachments?: StoredAttachment[]
  items: TraceEvent[]
  done: boolean
  status?: AgentTurnRecord['status']
  error?: string
  errorHint?: string
  turnEvidence?: TurnEvidence
  startedAt?: string
  completedAt?: string
  durationMs?: number
  ts: number
}

export interface TraceArchive {
  version: 1 | 2 | 3
  cwd: string
  sessionId: string
  externalSessionId?: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  turns: TraceArchiveTurn[]
}

export interface TraceArchiveSessionSummary {
  cwd: string
  sessionId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  runId: string
  prompt: string
  ts: number
}

const DISCOVERABLE_PROVIDER_IDS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const TRACE_DISCOVERY_MAX_FILES = 10_000
const TRACE_DISCOVERY_MAX_FILE_BYTES = 32 * 1024 * 1024
/**
 * 文件数与单文件大小各自有上限，但两者相乘仍是无界的读取量。聚合预算让一次发现扫描
 * 的读取总量有硬上限：超出就带着 `complete: false` 停下，于是结果不会被当成完整索引
 * 写回缓存，也不会在启动时无限期占用磁盘 IO。
 */
const TRACE_DISCOVERY_MAX_TOTAL_BYTES = 256 * 1024 * 1024

export interface TraceDiscoveryBudget {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
}

export const DEFAULT_TRACE_DISCOVERY_BUDGET: TraceDiscoveryBudget = {
  maxFiles: TRACE_DISCOVERY_MAX_FILES,
  maxFileBytes: TRACE_DISCOVERY_MAX_FILE_BYTES,
  maxTotalBytes: TRACE_DISCOVERY_MAX_TOTAL_BYTES
}
const TRACE_INDEX_MAX_BYTES = 32 * 1024 * 1024
const TRACE_INDEX_FILE = 'trace-archive-index-v1.json'
const TRACE_INDEX_DIRTY_FILE = 'trace-archive-index-v1.dirty'
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

async function markTraceArchiveCatalogIndexDirtyAsync(userDataDir: string): Promise<void> {
  traceArchiveCatalogWriteGeneration++
  const marker = traceArchiveCatalogIndexDirtyPath(userDataDir)
  if (trustedOwnedFile(userDataDir, marker)) return
  try { await writeOwnedFileAtomicallyAsync(userDataDir, marker, 'dirty\n') } catch {
    try { await unlink(traceArchiveCatalogIndexPath(userDataDir)) } catch { /* discovery will scan */ }
  }
}

function markTraceArchiveCatalogIndexDirty(userDataDir: string): void {
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

export function traceArchivePath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId = 'claude'): string {
  return join(userDataDir, 'trace-archives-v2', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId) + '.json')
}

function traceArchiveTurnDir(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return join(userDataDir, 'trace-archive-turns-v1', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId))
}

function traceArchiveMetadataDir(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  // Rebuildable metadata must not mutate canonical-directory stamps used by remote cursors.
  return join(userDataDir, 'trace-archive-metadata-v1', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId))
}

const TRACE_ARCHIVE_INDEX_SUFFIX = '.index-v1.json'
const TRACE_ARCHIVE_METADATA_SUFFIX = '.meta-v1.json'
const TRACE_ARCHIVE_METADATA_FILE = /^turn-[a-f0-9]{64}\.meta-v1\.json$/
const TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES = 32 * 1024 * 1024
const TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES = 100_000
const TRACE_ARCHIVE_TURN_FILE = /^turn-[a-f0-9]{64}\.json$/
const TRACE_ARCHIVE_TEMP_FILE = /^turn-[a-f0-9]{64}\.json\.tmp$/
const TRACE_ARCHIVE_METADATA_TEMP_FILE = /^turn-[a-f0-9]{64}\.meta-v1\.json\.tmp$/
const TRACE_ARCHIVE_PROFILE_METADATA_VERSION = 1 as const

interface TraceArchiveIndexEntry {
  /** Distinguishes profile-aware metadata from pre-profile v2 sidecars. */
  profileMetadataVersion?: 1
  agentProfileId?: string | null
  file: string
  runId: string
  ts: number
  size?: number
  mtimeMs?: number
  ctimeMs?: number
  ino?: number
  metadata?: {
    providerTurnId?: string
    forkTurnId?: string
    userText: string
    done: boolean
    status?: AgentTurnRecord['status']
    error?: string
    errorHint?: string
    hasSuccessfulResult: boolean
    toolIds: Array<{ stage: TraceEvent['stage']; toolUseId: string }>
    acceptedSteers: Array<{ messageId: string; prompt: string }>
  }
}

interface TraceArchiveDirectoryStamp {
  mtimeMs: number
  ctimeMs: number
  ino: number
}

interface TraceArchiveIndex {
  version: 1 | 2
  /** Present on every new v2 base/delta index; absent means legacy profile provenance. */
  profileMetadataVersion?: 1
  sourceComplete?: boolean
  sourceIssue?: string
  cwd: string
  sessionId: string
  providerId: ProviderId
  directory: TraceArchiveDirectoryStamp
  entries: TraceArchiveIndexEntry[]
}

type TraceArchiveIndexCacheEntry = {
  key: string
  value: TraceArchiveIndex
}

const traceArchiveIndexCache = new Map<string, TraceArchiveIndexCacheEntry>()
const TRACE_ARCHIVE_INDEX_CACHE_LIMIT = 2

function traceArchiveIndexCacheKey(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
}

function getCachedTraceArchiveIndex(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): TraceArchiveIndex | null {
  const key = traceArchiveIndexCacheKey(path, stat)
  const cached = traceArchiveIndexCache.get(path)
  return cached?.key === key ? cached.value : null
}

function cacheTraceArchiveIndex(path: string, stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }, value: TraceArchiveIndex): TraceArchiveIndex {
  traceArchiveIndexCache.set(path, { key: traceArchiveIndexCacheKey(path, stat), value })
  while (traceArchiveIndexCache.size > TRACE_ARCHIVE_INDEX_CACHE_LIMIT) {
    traceArchiveIndexCache.delete(traceArchiveIndexCache.keys().next().value!)
  }
  return value
}

function traceArchiveIndexPath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return `${traceArchiveTurnDir(userDataDir, cwd, sessionId, providerId)}${TRACE_ARCHIVE_INDEX_SUFFIX}`
}

function traceArchiveMetadataPath(dir: string, file: string): string {
  return join(dir, file.replace(/\.json$/, TRACE_ARCHIVE_METADATA_SUFFIX))
}

function trustedSegmentTempPaths(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}): { paths: string[]; error?: { path: string; error: string } } {
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    const paths: string[] = []
    for (const name of readdirSync(dir)) {
      if (!TRACE_ARCHIVE_TEMP_FILE.test(name) && !TRACE_ARCHIVE_METADATA_TEMP_FILE.test(name)) continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      if (stat.isFile() && !stat.isSymbolicLink()) paths.push(path)
    }
    return { paths }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { paths: [] }
    return { paths: [], error: { path: dir, error: error instanceof Error ? error.message : String(error) } }
  }
}

export async function cleanupTraceArchiveTemps(userDataDir: string): Promise<void> {
  const root = join(userDataDir, 'trace-archive-turns-v1')
  const walk = async (dir: string, depth: number): Promise<void> => {
    try {
      const stat = await lstat(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const path = join(dir, entry.name)
        if (depth < 3 && entry.isDirectory()) await walk(path, depth + 1)
        else if (entry.isFile() && (
          (depth === 3 && (TRACE_ARCHIVE_TEMP_FILE.test(entry.name) || TRACE_ARCHIVE_METADATA_TEMP_FILE.test(entry.name))) ||
          (depth === 2 && entry.name.endsWith(`${TRACE_ARCHIVE_INDEX_SUFFIX}.tmp`))
        )) {
          try { await unlink(path) } catch { /* startup cleanup is best-effort */ }
        }
      }
    } catch {
      // Startup cleanup is best-effort and only touches strict Scry temp names.
    }
  }
  await walk(root, 0)
}

function traceArchiveTurnKey(turn: Pick<TraceArchiveTurn, 'runId' | 'providerTurnId'>): string {
  const identity = turn.providerTurnId ? `provider\0${turn.providerTurnId}` : `run\0${turn.runId}`
  return `turn-${createHash('sha256').update(identity).digest('hex')}`
}

export function traceArchiveTurnPath(
  userDataDir: string,
  cwd: string,
  sessionId: string,
  providerId: ProviderId,
  turn: Pick<TraceArchiveTurn, 'runId' | 'providerTurnId'>
): string {
  return join(traceArchiveTurnDir(userDataDir, cwd, sessionId, providerId), `${traceArchiveTurnKey(turn)}.json`)
}

function trustedOwnedParent(userDataDir: string, filePath: string, create: boolean): string {
  const root = resolve(userDataDir)
  const parent = resolve(dirname(filePath))
  const relativeParent = relative(root, parent)
  if (isAbsolute(relativeParent) || relativeParent === '..' || relativeParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Scry-owned path escapes userData')
  }
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 })
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Scry userData root is not trusted')
  const realRoot = realpathSync(root)
  let current = root
  for (const part of relativeParent.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part)
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 })
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Scry-owned parent directory is not trusted')
    const realCurrent = realpathSync(current)
    const fromRoot = relative(realRoot, realCurrent)
    if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error('Scry-owned parent directory escapes userData')
    }
  }
  return parent
}

function trustedOwnedFile(userDataDir: string, filePath: string): boolean {
  try {
    trustedOwnedParent(userDataDir, filePath, false)
    const stat = lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

async function writeOwnedFileAtomicallyAsync(userDataDir: string, filePath: string, content: string): Promise<void> {
  trustedOwnedParent(userDataDir, filePath, true)
  const tmp = `${filePath}.tmp`
  let fd: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    try { await unlink(tmp) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    fd = await openFile(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await fd.writeFile(content)
    await fd.close()
    fd = undefined
    await rename(tmp, filePath)
  } catch (error) {
    if (fd) await fd.close()
    try { await unlink(tmp) } catch { /* ignore */ }
    throw error
  }
}

function writeOwnedFileAtomically(userDataDir: string, filePath: string, content: string): void {
  trustedOwnedParent(userDataDir, filePath, true)
  const tmp = `${filePath}.tmp`
  let fd: number | undefined
  try {
    try {
      unlinkSync(tmp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fd, content)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, filePath)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw error
  }
}

async function mirrorPrefixMatches(source: string, target: string, size: number): Promise<boolean> {
  if (size === 0) return true
  const sourceFile = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const targetFile = await openFile(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const starts = [...new Set([0, Math.max(0, size - 4096)])]
    for (const start of starts) {
      const length = Math.min(4096, size - start)
      const sourceBytes = Buffer.allocUnsafe(length)
      const targetBytes = Buffer.allocUnsafe(length)
      const [sourceRead, targetRead] = await Promise.all([
        sourceFile.read(sourceBytes, 0, length, start),
        targetFile.read(targetBytes, 0, length, start)
      ])
      if (sourceRead.bytesRead !== length || targetRead.bytesRead !== length || !sourceBytes.equals(targetBytes)) return false
    }
    return true
  } finally {
    await Promise.allSettled([sourceFile.close(), targetFile.close()])
  }
}

type TranscriptMirrorProvenance = { sourceDev: number; sourceIno: number; sourceSize: number; sourceMtimeMs: number }
const transcriptMirrorProvenance = new Map<string, TranscriptMirrorProvenance>()
const rememberTranscriptMirrorProvenance = (filePath: string, value: TranscriptMirrorProvenance): void => {
  transcriptMirrorProvenance.delete(filePath)
  transcriptMirrorProvenance.set(filePath, value)
  if (transcriptMirrorProvenance.size > 128) {
    const oldest = transcriptMirrorProvenance.keys().next().value
    if (oldest !== undefined) transcriptMirrorProvenance.delete(oldest)
  }
}

async function copyToOwnedFileAtomically(userDataDir: string, source: string, filePath: string): Promise<void> {
  trustedOwnedParent(userDataDir, filePath, true)
  const sourceStat = await lstat(source)
  if (trustedOwnedFile(userDataDir, filePath)) {
    try {
      const targetStat = await lstat(filePath)
      const provenance = transcriptMirrorProvenance.get(filePath)
      const canAppend = provenance?.sourceDev === sourceStat.dev && provenance.sourceIno === sourceStat.ino &&
        provenance.sourceSize === targetStat.size && targetStat.size <= sourceStat.size
      if (canAppend && await mirrorPrefixMatches(source, filePath, targetStat.size)) {
        if (targetStat.size === sourceStat.size && provenance.sourceMtimeMs === sourceStat.mtimeMs) return
        const input = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        let output: Awaited<ReturnType<typeof openFile>> | undefined
        try {
          output = await openFile(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
          const openedTarget = await output.stat()
          if (openedTarget.dev !== targetStat.dev || openedTarget.ino !== targetStat.ino) throw new Error('transcript mirror target changed during append')
          const buffer = Buffer.allocUnsafe(64 * 1024)
          let position = targetStat.size
          while (position < sourceStat.size) {
            const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, sourceStat.size - position), position)
            if (bytesRead === 0) break
            let written = 0
            while (written < bytesRead) {
              const result = await output.write(buffer, written, bytesRead - written)
              written += result.bytesWritten
            }
            position += bytesRead
          }
          await output.sync()
          rememberTranscriptMirrorProvenance(filePath, {
            sourceDev: sourceStat.dev,
            sourceIno: sourceStat.ino,
            sourceSize: sourceStat.size,
            sourceMtimeMs: sourceStat.mtimeMs
          })
          return
        } finally {
          await Promise.allSettled([input.close(), ...(output ? [output.close()] : [])])
        }
      }
    } catch {
      // A failed incremental append falls back to a complete atomic mirror below.
    }
  }

  const tmp = `${filePath}.tmp`
  try {
    try {
      await unlink(tmp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await copyFile(source, tmp, constants.COPYFILE_EXCL)
    await rename(tmp, filePath)
    rememberTranscriptMirrorProvenance(filePath, {
      sourceDev: sourceStat.dev,
      sourceIno: sourceStat.ino,
      sourceSize: sourceStat.size,
      sourceMtimeMs: sourceStat.mtimeMs
    })
  } catch (error) {
    try { await unlink(tmp) } catch { /* ignore */ }
    throw error
  }
}

type ArchiveInspection =
  | { status: 'missing' }
  | { status: 'invalid'; reason: 'untrusted' | 'corrupt' | 'identity_mismatch' | 'provider_mismatch'; error: string }
  | { status: 'valid'; archive: TraceArchive }

const PROVIDER_IDS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi'])
const RUNTIME_PROVIDERS = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server', 'pi_rpc'])

function isArchiveShape(value: unknown): value is TraceArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const archive = value as Partial<TraceArchive>
  if (
    archive.version !== 3 ||
    typeof archive.cwd !== 'string' ||
    typeof archive.sessionId !== 'string' ||
    !Array.isArray(archive.turns)
  ) return false
  return archive.turns.every((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
    const turn = raw as Partial<TraceArchiveTurn>
    return typeof turn.runId === 'string' && turn.runId.length > 0 &&
      (turn.providerTurnId == null || typeof turn.providerTurnId === 'string') &&
      (turn.forkTurnId == null || typeof turn.forkTurnId === 'string') &&
      typeof turn.userText === 'string' &&
      Array.isArray(turn.items) && turn.items.every((item) => !!item && typeof item === 'object' && !Array.isArray(item)) &&
      (turn.attachments == null || (Array.isArray(turn.attachments) && turn.attachments.every(
        (attachment) => !!attachment && typeof attachment === 'object' && !Array.isArray(attachment)
      ))) &&
      typeof turn.done === 'boolean' &&
      typeof turn.ts === 'number' && Number.isFinite(turn.ts)
  })
}

function archiveProviderIdentities(archive: TraceArchive): { ids: Set<ProviderId>; invalid: boolean } {
  const ids = new Set<ProviderId>()
  let invalid = false
  const collect = (providerId: unknown, runtimeProvider: unknown): void => {
    if (providerId !== undefined) {
      if (typeof providerId === 'string' && PROVIDER_IDS.has(providerId as ProviderId)) ids.add(providerId as ProviderId)
      else invalid = true
    }
    if (runtimeProvider !== undefined) {
      if (typeof runtimeProvider === 'string' && RUNTIME_PROVIDERS.has(runtimeProvider as RuntimeProvider)) {
        ids.add(providerIdForRuntime(runtimeProvider as RuntimeProvider))
      } else invalid = true
    }
  }
  collect(archive.providerId, archive.runtimeProvider)
  for (const turn of archive.turns) {
    if (!Array.isArray(turn.items)) continue
    for (const item of turn.items) collect(item.providerId, item.runtimeProvider)
  }
  return { ids, invalid }
}

function normalizeArchive(archive: TraceArchive): TraceArchive {
  archive.turns = archive.turns.map((turn) => ({
    ...turn,
    items: Array.isArray(turn.items)
      ? turn.items.map((event) => {
          if (!isDiffSnapshotStage(event.stage)) return event
          const turnDiff = normalizeTurnDiffSnapshot(event.turnDiff)
          return {
            ...event,
            turnDiff:
              turnDiff ??
              {
                version: 1,
                status: 'failed',
                reason: 'git_error',
                files: [],
                beforeAt: event.ts,
                afterAt: event.ts,
                captureMs: 0,
                cleanup: 'failed'
              }
          }
        })
      : []
  }))
  return archive
}

function validateArchive(
  value: unknown,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId
): ArchiveInspection {
  if (!isArchiveShape(value)) return { status: 'invalid', reason: 'corrupt', error: 'archive schema is invalid' }
  if (value.cwd !== cwd || value.sessionId !== sessionId) {
    return { status: 'invalid', reason: 'identity_mismatch', error: 'archive belongs to another session/cwd' }
  }
  const identities = archiveProviderIdentities(value)
  if (identities.invalid || identities.ids.size > 1 || (expectedProvider && (identities.ids.size !== 1 || !identities.ids.has(expectedProvider)))) {
    return { status: 'invalid', reason: 'provider_mismatch', error: 'archive contains conflicting Provider identity' }
  }
  return { status: 'valid', archive: normalizeArchive(value) }
}

function inspectArchiveFile(
  userDataDir: string,
  fp: string,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId
): ArchiveInspection {
  try {
    trustedOwnedParent(userDataDir, fp, false)
    const stat = lstatSync(fp)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'invalid', reason: 'untrusted', error: 'archive is not a trusted regular file' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: 'untrusted', error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return validateArchive(JSON.parse(readFileSync(fp, 'utf8')), cwd, sessionId, expectedProvider)
  } catch (error) {
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

async function inspectArchiveFileAsync(
  userDataDir: string,
  fp: string,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId,
  signal?: AbortSignal
): Promise<ArchiveInspection> {
  signal?.throwIfAborted()
  try {
    trustedOwnedParent(userDataDir, fp, false)
    const stat = await lstat(fp)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { status: 'invalid', reason: 'untrusted', error: 'archive is not a trusted regular file' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', reason: 'untrusted', error: error instanceof Error ? error.message : String(error) }
  }
  try {
    return validateArchive(JSON.parse(await readFile(fp, { encoding: 'utf8', signal })), cwd, sessionId, expectedProvider)
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function isTraceArchiveIndex(value: unknown, args: {
  cwd: string
  sessionId: string
  providerId: ProviderId
}): value is TraceArchiveIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const index = value as Partial<TraceArchiveIndex>
  if ((index.version !== 1 && index.version !== 2) || index.cwd !== args.cwd || index.sessionId !== args.sessionId || index.providerId !== args.providerId ||
      (index.version === 2 && index.profileMetadataVersion !== TRACE_ARCHIVE_PROFILE_METADATA_VERSION) ||
      !index.directory || typeof index.directory.mtimeMs !== 'number' || !Number.isFinite(index.directory.mtimeMs) ||
      typeof index.directory.ctimeMs !== 'number' || !Number.isFinite(index.directory.ctimeMs) ||
      typeof index.directory.ino !== 'number' || !Number.isFinite(index.directory.ino) || !Array.isArray(index.entries) ||
      index.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) return false
  const files = new Set<string>()
  return index.entries.every((entry) => {
    if (!entry || typeof entry !== 'object' || !TRACE_ARCHIVE_TURN_FILE.test(entry.file) ||
        typeof entry.runId !== 'string' || !entry.runId || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts) ||
        (index.version === 2 && entry.profileMetadataVersion !== TRACE_ARCHIVE_PROFILE_METADATA_VERSION) ||
        files.has(entry.file) || (entry.agentProfileId !== undefined && entry.agentProfileId !== null &&
          (typeof entry.agentProfileId !== 'string' || !entry.agentProfileId))) return false
    files.add(entry.file)
    if (index.version === 2) {
      const metadata = entry.metadata
      if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size <= 0 ||
          typeof entry.mtimeMs !== 'number' || !Number.isFinite(entry.mtimeMs) ||
          typeof entry.ctimeMs !== 'number' || !Number.isFinite(entry.ctimeMs) ||
          typeof entry.ino !== 'number' || !Number.isSafeInteger(entry.ino) || entry.ino <= 0 ||
          !metadata || typeof metadata.userText !== 'string' || typeof metadata.done !== 'boolean' ||
          typeof metadata.hasSuccessfulResult !== 'boolean' || !Array.isArray(metadata.toolIds) || !Array.isArray(metadata.acceptedSteers) ||
          !metadata.toolIds.every((item) => item && typeof item.stage === 'string' && typeof item.toolUseId === 'string') ||
          !metadata.acceptedSteers.every((item) => item && typeof item.messageId === 'string' && typeof item.prompt === 'string')) return false
    }
    return true
  })
}

function archiveTurnMetadata(turn: TraceArchiveTurn): TraceArchiveIndexEntry['metadata'] {
  return {
    providerTurnId: turn.providerTurnId,
    forkTurnId: turn.forkTurnId,
    userText: turn.userText,
    done: turn.done,
    status: turn.status,
    error: turn.error,
    errorHint: turn.errorHint,
    hasSuccessfulResult: turn.items.some((event) => event.stage === 'result' && event.isError === false),
    toolIds: turn.items.filter((event): event is TraceEvent & { toolUseId: string } => !!event.toolUseId)
      .map((event) => ({ stage: event.stage, toolUseId: event.toolUseId })),
    acceptedSteers: turn.items
      .filter((event) => event.stage === 'steer' && event.steer?.status === 'accepted' && !!event.steer.messageId)
      .map((event) => ({ messageId: event.steer!.messageId, prompt: event.steer!.prompt }))
  }
}

function archiveMetadataTurn(entry: TraceArchiveIndexEntry): TraceArchiveTurn | null {
  const metadata = entry.metadata
  if (!metadata) return null
  return {
    runId: entry.runId,
    ...(entry.agentProfileId !== undefined ? { agentProfileId: entry.agentProfileId } : {}),
    providerTurnId: metadata.providerTurnId,
    forkTurnId: metadata.forkTurnId,
    userText: metadata.userText,
    done: metadata.done,
    status: metadata.status,
    error: metadata.error,
    errorHint: metadata.errorHint,
    items: [
      ...(metadata.hasSuccessfulResult ? [{
        id: `archive-index-result-${entry.runId}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'harness' as const,
        stage: 'result' as const,
        isError: false
      }] : []),
      ...metadata.toolIds.map((item, index): TraceEvent => ({
        id: `archive-index-${entry.runId}-${index}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'tool',
        stage: item.stage,
        toolUseId: item.toolUseId,
        runtimeMetadata: { source: 'scry_archive_index' }
      })),
      ...metadata.acceptedSteers.map((steer, index): TraceEvent => ({
        id: `archive-index-steer-${entry.runId}-${index}`,
        runId: entry.runId,
        ts: String(entry.ts),
        kind: 'human',
        stage: 'steer',
        steer: { messageId: steer.messageId, prompt: steer.prompt, attachments: [], status: 'accepted' }
      }))
    ],
    ts: entry.ts
  }
}

function archiveDirectoryStamp(info: { mtimeMs: number; ctimeMs: number; ino: number }): TraceArchiveDirectoryStamp {
  return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino }
}

function sameArchiveDirectoryStamp(left: TraceArchiveDirectoryStamp, right: TraceArchiveDirectoryStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.ino === right.ino
}

function sameArchiveSegmentStamp(entry: TraceArchiveIndexEntry, stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }): boolean {
  return entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ctimeMs === stat.ctimeMs && entry.ino === stat.ino
}

async function archiveIndexFromArchives(
  args: { userDataDir: string; cwd: string; sessionId: string; providerId: ProviderId },
  directory: TraceArchiveDirectoryStamp,
  archives: TraceArchive[],
  signal?: AbortSignal
): Promise<TraceArchiveIndex> {
  const turns = archives.flatMap((archive) => archive.turns).sort((left, right) => left.ts - right.ts || traceArchiveTurnKey(left).localeCompare(traceArchiveTurnKey(right)))
  const entries: TraceArchiveIndexEntry[] = []
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  for (let offset = 0; offset < turns.length; offset += 32) {
    signal?.throwIfAborted()
    const batch = await Promise.all(turns.slice(offset, offset + 32).map(async (turn) => {
      const file = `${traceArchiveTurnKey(turn)}.json`
      const stat = await lstat(join(dir, file))
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('trace archive segment is not a trusted regular file')
      return {
        file,
        profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
        ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
        runId: turn.runId,
        ts: turn.ts,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        ino: stat.ino,
        metadata: archiveTurnMetadata(turn)
      }
    }))
    entries.push(...batch)
  }
  return {
    version: 2,
    profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId: args.providerId,
    directory,
    entries
  }
}

async function writeTraceArchiveIndex(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, index: TraceArchiveIndex): Promise<void> {
  if (index.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) throw new Error('trace archive page index capacity exceeded')
  const content = `${JSON.stringify(index)}\n`
  if (Buffer.byteLength(content) > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) throw new Error('trace archive page index capacity exceeded')
  await writeOwnedFileAtomicallyAsync(
    args.userDataDir,
    traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    content
  )
}

function writeTraceArchiveMetadataSidecar(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, entry: TraceArchiveIndexEntry): void {
  const dir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  writeOwnedFileAtomically(args.userDataDir, traceArchiveMetadataPath(dir, entry.file), `${JSON.stringify(entry)}\n`)
}

async function writeTraceArchiveMetadataSidecarAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, entry: TraceArchiveIndexEntry): Promise<void> {
  const dir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  await writeOwnedFileAtomicallyAsync(args.userDataDir, traceArchiveMetadataPath(dir, entry.file), `${JSON.stringify(entry)}\n`)
}

async function readSegmentedMetadataIndexAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    const directoryStat = await lstat(dir)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    const directory = archiveDirectoryStamp(directoryStat)
    const allNames = await readdir(dir)
    const names = allNames.filter((name) => TRACE_ARCHIVE_TURN_FILE.test(name)).sort()
    const metadataDir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    trustedOwnedParent(args.userDataDir, join(metadataDir, '.identity'), false)
    const metadataNames = (await readdir(metadataDir)).filter((name) => TRACE_ARCHIVE_METADATA_FILE.test(name)).sort()
    const metadataFiles = new Set(metadataNames)
    const metadataCoverageComplete = metadataFiles.size === names.length && names.every((name) => metadataFiles.has(name.replace(/\.json$/, TRACE_ARCHIVE_METADATA_SUFFIX)))
    // metadata sidecars are disposable; canonical files remain authoritative
    const entries: TraceArchiveIndexEntry[] = []
    for (const file of names) {
      signal?.throwIfAborted()
      const segmentPath = join(dir, file)
      const metadataPath = traceArchiveMetadataPath(metadataDir, file)
      const [segmentStat, metadataStat] = await Promise.all([lstat(segmentPath), lstat(metadataPath)])
      if (!segmentStat.isFile() || segmentStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.isSymbolicLink() ||
          metadataStat.size <= 0 || metadataStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
      const value = JSON.parse(await readFile(metadataPath, { encoding: 'utf8', signal })) as TraceArchiveIndexEntry
      if (!value || value.file !== file || !isTraceArchiveIndex({
        version: 2,
        profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
        cwd: args.cwd,
        sessionId: args.sessionId,
        providerId: args.providerId,
        directory,
        entries: [value]
      }, args) || !sameArchiveSegmentStamp(value, segmentStat)) return null
      entries.push(value)
    }
    const after = archiveDirectoryStamp(await lstat(dir))
    if (!sameArchiveDirectoryStamp(directory, after)) return null
    const index: TraceArchiveIndex = { version: 2, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, cwd: args.cwd, sessionId: args.sessionId, providerId: args.providerId, directory,
      sourceComplete: metadataCoverageComplete,
      sourceIssue: metadataCoverageComplete ? undefined : 'canonical archive segment coverage changed',
      entries: entries.sort((left, right) => left.ts - right.ts || left.file.localeCompare(right.file)) }
    // A live session can have only per-turn deltas before its first history read. Publish
    // the validated base once so later pages do not reopen every metadata sidecar.
    if (metadataCoverageComplete) await writeTraceArchiveIndex(args, index)
    return index
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (signal?.aborted) throw signal.reason
    return null
  }
}

async function readTraceArchiveMetadataSidecarAsync(
  args: { userDataDir: string; cwd: string; sessionId: string; providerId: ProviderId },
  directory: TraceArchiveDirectoryStamp,
  file: string,
  stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
  signal?: AbortSignal
): Promise<TraceArchiveIndexEntry | null> {
  const metadataPath = traceArchiveMetadataPath(traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, args.providerId), file)
  try {
    trustedOwnedParent(args.userDataDir, metadataPath, false)
    const metadataStat = await lstat(metadataPath)
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.size <= 0 || metadataStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
    const value: unknown = JSON.parse(await readFile(metadataPath, { encoding: 'utf8', signal }))
    if (!value || (value as TraceArchiveIndexEntry).file !== file || !isTraceArchiveIndex({
      version: 2,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      cwd: args.cwd,
      sessionId: args.sessionId,
      providerId: args.providerId,
      directory,
      entries: [value as TraceArchiveIndexEntry]
    }, args) || !sameArchiveSegmentStamp(value as TraceArchiveIndexEntry, stat)) return null
    return value as TraceArchiveIndexEntry
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

async function readValidTraceArchiveIndex(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    const path = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    const [indexStat, directoryStat] = await Promise.all([lstat(path), lstat(dir)])
    if (!indexStat.isFile() || indexStat.isSymbolicLink() || indexStat.size <= 0 ||
        indexStat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
    const cached = getCachedTraceArchiveIndex(path, indexStat)
    const parsed = cached ?? JSON.parse(await readFile(path, { encoding: 'utf8', signal })) as unknown
    if (!isTraceArchiveIndex(parsed, args)) return null
    const value = cached ?? cacheTraceArchiveIndex(path, indexStat, parsed)
    if (value.version !== 2) {
      return sameArchiveDirectoryStamp(value.directory, archiveDirectoryStamp(directoryStat)) ? value : null
    }
    // A degraded base index is not evidence that missing canonical turns are absent. Force the
    // authoritative rebuild path so repaired source can restore complete coverage.
    if (value.sourceComplete === false) return null

    const directory = archiveDirectoryStamp(directoryStat)
    const canonicalNames = (await readdir(dir)).filter((name) => TRACE_ARCHIVE_TURN_FILE.test(name)).sort()
    const stats = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number }>()
    for (let offset = 0; offset < canonicalNames.length; offset += 32) {
      signal?.throwIfAborted()
      const batch = await Promise.all(canonicalNames.slice(offset, offset + 32).map(async (file) => {
        const stat = await lstat(join(dir, file))
        return { file, stat }
      }))
      for (const { file, stat } of batch) {
        if (!stat.isFile() || stat.isSymbolicLink()) return null
        stats.set(file, stat)
      }
    }
    const baseByFile = new Map(value.entries.map((entry) => [entry.file, entry]))
    const membershipUnchanged = canonicalNames.length === baseByFile.size && canonicalNames.every((file) => baseByFile.has(file))
    const removedCount = value.entries.filter((entry) => !stats.has(entry.file)).length
    const fingerprintsUnchanged = membershipUnchanged && canonicalNames.every((file) => sameArchiveSegmentStamp(baseByFile.get(file)!, stats.get(file)!))
    if (sameArchiveDirectoryStamp(value.directory, directory) && fingerprintsUnchanged) return value

    const entries: TraceArchiveIndexEntry[] = []
    let invalidCount = removedCount
    for (const file of canonicalNames) {
      signal?.throwIfAborted()
      const stat = stats.get(file)!
      const base = baseByFile.get(file)
      if (base && sameArchiveSegmentStamp(base, stat)) {
        entries.push(base)
        continue
      }
      const sidecar = await readTraceArchiveMetadataSidecarAsync(args, directory, file, stat, signal)
      if (sidecar) {
        entries.push(sidecar)
        continue
      }
      const inspected = await inspectArchiveFileAsync(args.userDataDir, join(dir, file), args.cwd, args.sessionId, args.providerId, signal)
      if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1 ||
          traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, inspected.archive.turns[0]) !== join(dir, file)) {
        invalidCount++
        continue
      }
      const turn = inspected.archive.turns[0]
      const finalStat = await lstat(join(dir, file))
      if (!finalStat.isFile() || finalStat.isSymbolicLink() || finalStat.size !== stat.size ||
          finalStat.mtimeMs !== stat.mtimeMs || finalStat.ctimeMs !== stat.ctimeMs || finalStat.ino !== stat.ino) {
        invalidCount++
        continue
      }
      entries.push({ file, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}), runId: turn.runId, ts: turn.ts, size: finalStat.size, mtimeMs: finalStat.mtimeMs, ctimeMs: finalStat.ctimeMs, ino: finalStat.ino, metadata: archiveTurnMetadata(turn) })
    }
    return {
      version: 2,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      cwd: args.cwd,
      sessionId: args.sessionId,
      providerId: args.providerId,
      directory,
      sourceComplete: invalidCount === 0,
      sourceIssue: invalidCount ? `${invalidCount} canonical archive segment(s) unavailable` : value.sourceIssue,
      entries: entries.sort((left, right) => left.ts - right.ts || left.file.localeCompare(right.file))
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

type SegmentedArchiveInspection = {
  valid: TraceArchive[]
  invalid: Array<{ path: string; error: string }>
}

function inspectSegmentedArchives(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): SegmentedArchiveInspection {
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[]
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    names = readdirSync(dir).filter((name) => /^turn-[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { valid: [], invalid: [] }
    return { valid: [], invalid: [{ path: dir, error: error instanceof Error ? error.message : String(error) }] }
  }
  const valid: TraceArchive[] = []
  const invalid: Array<{ path: string; error: string }> = []
  for (const name of names) {
    const path = join(dir, name)
    const inspected = inspectArchiveFile(
      args.userDataDir,
      path,
      args.cwd,
      args.sessionId,
      args.providerId
    )
    if (inspected.status !== 'valid') {
      invalid.push({
        path,
        error: inspected.status === 'invalid' ? inspected.error : 'segmented archive disappeared'
      })
      continue
    }
    if (
      inspected.archive.turns.length !== 1 ||
      traceArchiveTurnPath(
        args.userDataDir,
        args.cwd,
        args.sessionId,
        args.providerId,
        inspected.archive.turns[0]
      ) !== path
    ) {
      invalid.push({ path, error: 'segmented archive identity is invalid' })
      continue
    }
    valid.push(inspected.archive)
  }
  return { valid, invalid }
}

async function inspectSegmentedArchivesAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<SegmentedArchiveInspection> {
  signal?.throwIfAborted()
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[]
  try {
    trustedOwnedParent(args.userDataDir, join(dir, '.identity'), false)
    names = (await readdir(dir)).filter((name) => /^turn-[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { valid: [], invalid: [] }
    return { valid: [], invalid: [{ path: dir, error: error instanceof Error ? error.message : String(error) }] }
  }
  const valid: TraceArchive[] = []
  const invalid: Array<{ path: string; error: string }> = []
  const concurrency = 8
  for (let offset = 0; offset < names.length; offset += concurrency) {
    signal?.throwIfAborted()
    const batch = await Promise.all(names.slice(offset, offset + concurrency).map(async (name) => {
      const path = join(dir, name)
      const inspected = await inspectArchiveFileAsync(args.userDataDir, path, args.cwd, args.sessionId, args.providerId, signal)
      return { path, inspected }
    }))
    for (const { path, inspected } of batch) {
      if (inspected.status !== 'valid') {
        invalid.push({ path, error: inspected.status === 'invalid' ? inspected.error : 'segmented archive disappeared' })
        continue
      }
      if (
        inspected.archive.turns.length !== 1 ||
        traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, inspected.archive.turns[0]) !== path
      ) {
        invalid.push({ path, error: 'segmented archive identity is invalid' })
        continue
      }
      valid.push(inspected.archive)
    }
  }
  return { valid, invalid }
}

function mergeArchives(archives: TraceArchive[]): TraceArchive | null {
  if (archives.length === 0) return null
  const turns = new Map<string, TraceArchiveTurn>()
  for (const archive of archives) {
    for (const turn of archive.turns) if (turn.runId) turns.set(turn.runId, turn)
  }
  const newest = archives[archives.length - 1]
  return {
    ...newest,
    turns: [...turns.values()].sort((a, b) => a.ts - b.ts)
  }
}

function archiveCandidates(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): TraceArchive[] {
  const current = inspectArchiveFile(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId
  )
  return (current.status === 'valid' ? [current.archive] : []).concat(inspectSegmentedArchives(args).valid)
}

export function readTraceArchive(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): TraceArchive | null {
  return mergeArchives(archiveCandidates(args))
}

async function traceArchiveIndexVersionAsync(args: {
  userDataDir: string
  cwd: string
  sessionId: string
  providerId: ProviderId
}): Promise<1 | 2 | null> {
  try {
    const path = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES) return null
    const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown; entries?: unknown }
    if (!Array.isArray(value.entries) || value.entries.length > TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES) return null
    return value.version === 1 || value.version === 2 ? value.version : null
  } catch { return null }
}

async function upgradeTraceArchiveIndexAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, index: TraceArchiveIndex | null, signal?: AbortSignal): Promise<TraceArchiveIndex | null> {
  if (!index || index.version !== 1) return index
  const inspected = await inspectSegmentedArchivesAsync(args, signal)
  if (inspected.invalid.length > 0) return null
  try {
    const directory = archiveDirectoryStamp(await lstat(traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)))
    const upgraded = await archiveIndexFromArchives(args, directory, inspected.valid, signal)
    await writeTraceArchiveIndex(args, upgraded)
    return upgraded
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    return null
  }
}

export async function readTraceArchiveMetadataAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal): Promise<TraceArchive | null> {
  const monolith = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  // A segmented index cannot describe monolithic coverage. Force the caller's
  // complete-reader fallback instead of exposing synthetic metadata markers.
  if (monolith.status === 'valid') return null
  const validIndex = await readValidTraceArchiveIndex(args, signal)
  const storedVersion = validIndex?.version ?? await traceArchiveIndexVersionAsync(args)
  const indexed = validIndex ?? await readSegmentedMetadataIndexAsync(args, signal)
  const index = await upgradeTraceArchiveIndexAsync(args, indexed, signal)
  if (index?.version === 2 && storedVersion === 1 && (!validIndex || validIndex.version === 1)) await writeTraceArchiveIndex(args, index)
  if (!index || index.version !== 2) return null
  signal?.throwIfAborted()
  return {
    version: 3,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId: args.providerId,
    turns: index.entries.map((entry) => archiveMetadataTurn(entry)).filter((turn): turn is TraceArchiveTurn => turn != null)
  }
}

export async function readTraceArchiveTurnsAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, runIds: readonly string[], signal?: AbortSignal): Promise<TraceArchiveTurn[]> {
  signal?.throwIfAborted()
  if (runIds.length === 0) return []
  const monolith = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  if (monolith.status === 'valid') {
    const merged = await readTraceArchiveAsync(args, signal)
    return (merged?.turns ?? []).filter((turn) => runIds.includes(turn.runId))
  }
  const indexed = await readValidTraceArchiveIndex(args, signal) ?? await readSegmentedMetadataIndexAsync(args, signal)
  const index = await upgradeTraceArchiveIndexAsync(args, indexed, signal)
  if (!index || index.version !== 2) {
    const archive = await readTraceArchiveAsync(args, signal)
    return (archive?.turns ?? []).filter((turn) => runIds.includes(turn.runId))
  }
  const wanted = new Set(runIds)
  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  const turns: TraceArchiveTurn[] = []
  for (const entry of index.entries) {
    if (!wanted.has(entry.runId)) continue
    const inspected = await inspectArchiveFileAsync(args.userDataDir, join(dir, entry.file), args.cwd, args.sessionId, args.providerId, signal)
    if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1 || inspected.archive.turns[0].runId !== entry.runId) {
      throw new Error('trace archive index entry changed or is corrupt')
    }
    turns.push(inspected.archive.turns[0])
  }
  return turns
}

export async function readTraceArchiveAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}, signal?: AbortSignal, requireComplete = false): Promise<TraceArchive | null> {
  signal?.throwIfAborted()
  const current = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  const segmented = await inspectSegmentedArchivesAsync(args, signal)
  if (requireComplete && (current.status === 'invalid' || segmented.invalid.length)) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  return mergeArchives((current.status === 'valid' ? [current.archive] : []).concat(segmented.valid))
}

/** Migration must not silently omit corrupt capture files or read an unbounded session. */
export async function readTraceArchiveForMigration(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): Promise<TraceArchive | null> {
  const mono = traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  const directory = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let names: string[] = []
  try {
    trustedOwnedParent(args.userDataDir, join(directory, '.identity'), false)
    names = (await readdir(directory)).filter(name => /^turn-[a-f0-9]{64}\.json$/.test(name))
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (names.length > 2000) throw new Error('迁移超过 2000 轮读取预算')
  let bytes = 0
  for (const path of [mono, ...names.map(name => join(directory, name))]) {
    try {
      trustedOwnedParent(args.userDataDir, path, false)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移源不是受控普通文件')
      bytes += info.size
      if (bytes > 16 * 1024 * 1024) throw new Error('迁移归档超过 16 MiB 读取预算')
    } catch (error) {
      if (path !== mono || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const current = await inspectArchiveFileAsync(args.userDataDir, mono, args.cwd, args.sessionId, args.providerId)
  const segmented = await inspectSegmentedArchivesAsync(args)
  if (current.status === 'invalid' || segmented.invalid.length) throw new Error('迁移源归档损坏或身份不匹配；旧入口保留')
  const archive = mergeArchives((current.status === 'valid' ? [current.archive] : []).concat(segmented.valid))
  if (archive && archive.turns.length > 2000) throw new Error('迁移超过 2000 轮读取预算')
  return archive
}

export interface TraceArchiveVersion {
  version: string
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
}

/**
 * Return a cheap source stamp for refresh/reconciliation. This intentionally
 * reads metadata only; callers must still use a complete page read when the
 * stamp changes. Legacy monolithic archives are marked honestly because their
 * next page read may materialize the whole file.
 */
export async function readTraceArchiveVersionAsync(
  args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId; agentProfileId?: string | null }
): Promise<TraceArchiveVersion> {
  const paths = [
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    `${traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)}${TRACE_ARCHIVE_INDEX_SUFFIX}`
  ]
  const stats: string[] = []
  for (const path of paths) {
    try {
      const value = await lstat(path)
      stats.push(`${path}:${value.isDirectory() ? 'd' : 'f'}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`)
    } catch { stats.push(`${path}:missing`) }
  }
  const hasMonolithic = stats[0]?.endsWith(':missing') === false
  const hasIndex = stats[2]?.endsWith(':missing') === false
  return {
    // The index is a rebuildable cache, not source evidence. Building it during
    // the first page read must not invalidate the unchanged archive snapshot.
    version: createHash('sha256').update(JSON.stringify([stats.slice(0, 2), Object.hasOwn(args, 'agentProfileId') ? [args.agentProfileId] : []])).digest('hex'),
    readMode: hasMonolithic ? 'monolithic' : hasIndex ? 'indexed' : 'index_rebuild'
  }
}

export interface TraceArchivePage {
  archive: TraceArchive | null
  /** False means the page is a degraded projection of surviving canonical segments. */
  sourceComplete: boolean
  sourceIssue?: string
  offset: number
  totalTurns: number
  hasOlder: boolean
  /** Canonical turn bodies parsed for this request; excludes the tiny index file. */
  turnFilesRead: number
  /** Honest source cost: legacy monolithic archives are not constant-time. */
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
}

export interface TraceArchivePageRequest {
  /** Presence selects strict Profile evidence; null selects the default runtime. */
  agentProfileId?: string | null
  /** Session display permits unknown Profiles, never unreadable canonical turns. */
  requireComplete?: boolean
  before?: number
  limit?: number
  /** Freeze ordinal paging to the total observed by the initial page while later turns append. */
  snapshotTotalTurns?: number
}

function selectArchiveProfile<T extends { agentProfileId?: string | null }>(turns: T[], request: TraceArchivePageRequest): T[] {
  if (!Object.hasOwn(request, 'agentProfileId')) return turns
  if (request.agentProfileId === undefined || turns.some((turn) => turn.agentProfileId === undefined ||
      (turn.agentProfileId !== null && (typeof turn.agentProfileId !== 'string' || !turn.agentProfileId)))) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  return turns.filter((turn) => turn.agentProfileId === request.agentProfileId)
}

function profileArchive(archive: TraceArchive | null, request: TraceArchivePageRequest): TraceArchive | null {
  if (!archive) return null
  const turns = selectArchiveProfile(archive.turns, request)
  return Object.hasOwn(request, 'agentProfileId') && !turns.length ? null : { ...archive, turns }
}

function traceArchivePageBounds(availableTurns: number, request: TraceArchivePageRequest): {
  offset: number
  end: number
  totalTurns: number
} {
  const snapshot = request.snapshotTotalTurns
  const totalTurns = snapshot != null && Number.isFinite(snapshot)
    ? Math.min(availableTurns, Math.max(0, Math.floor(snapshot)))
    : availableTurns
  const limit = Math.min(200, Math.max(1, Math.floor(request.limit ?? 40)))
  const end = request.before == null ? totalTurns : Math.max(0, Math.min(Math.floor(request.before), totalTurns))
  return { offset: Math.max(0, end - limit), end, totalTurns }
}

/**
 * Read a bounded page from per-turn archives. A tiny rebuildable index keeps steady-state disk reads
 * proportional to the requested page; legacy monolithic archives transparently use the full reader.
 */
export async function readTraceArchivePageAsync(
  args: { cwd: string; sessionId: string; userDataDir: string; providerId: ProviderId },
  request: TraceArchivePageRequest = {},
  signal?: AbortSignal
): Promise<TraceArchivePage> {
  signal?.throwIfAborted()
  const strictStorage = Object.hasOwn(request, 'agentProfileId') || request.requireComplete === true
  const current = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId,
    signal
  )
  if (current.status === 'invalid' && strictStorage) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  if (current.status === 'valid') {
    const segmented = await inspectSegmentedArchivesAsync(args, signal)
    if (strictStorage && segmented.invalid.length) {
      throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    }
    const archive = profileArchive(mergeArchives([current.archive, ...segmented.valid]), request)
    const { offset, end, totalTurns } = traceArchivePageBounds(archive?.turns.length ?? 0, request)
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(offset, end) } : null,
      offset,
      totalTurns,
      hasOlder: offset > 0,
      turnFilesRead: totalTurns,
      readMode: 'monolithic',
      sourceComplete: segmented.invalid.length === 0,
      sourceIssue: segmented.invalid.length ? `${segmented.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }

  const dir = traceArchiveTurnDir(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  let index = await readValidTraceArchiveIndex(args, signal)
  if (Object.hasOwn(request, 'agentProfileId') && index?.version === 1) index = null
  if (!index) {
    const indexFileExists = trustedOwnedFile(args.userDataDir, traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, args.providerId))
    const storedIndexVersion = await traceArchiveIndexVersionAsync(args)
    if (!indexFileExists || storedIndexVersion === 2) index = await readSegmentedMetadataIndexAsync(args, signal)
  }
  if (strictStorage && index?.version === 2 && index.sourceComplete === false) {
    throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
  }
  // Index reconciliation checks every canonical member and file stamp. Reject
  // incomplete coverage above, then hydrate only the selected page's bodies.
  if (!index || index.version !== 2) {
    let before: TraceArchiveDirectoryStamp | null = null
    try { before = archiveDirectoryStamp(await lstat(dir)) } catch { /* inspection below owns absence/corruption semantics */ }
    const inspected = await inspectSegmentedArchivesAsync(args, signal)
    signal?.throwIfAborted()
    try {
      const after = archiveDirectoryStamp(await lstat(dir))
      const rebuilt = await archiveIndexFromArchives(args, after, inspected.valid, signal)
      if (before && sameArchiveDirectoryStamp(before, after) && inspected.invalid.length === 0) {
        await writeTraceArchiveIndex(args, rebuilt)
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      // A segment changed during the rebuild. The already-inspected canonical snapshot remains safe
      // for this response; a later request retries the rebuild from current files.
    }
    // A rebuild already parsed every canonical turn body, so slice that result directly instead of
    // reading the selected page twice. The next healthy request will use the persisted index.
    if (strictStorage && inspected.invalid.length) throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    const merged = mergeArchives(inspected.valid)
    const archive = profileArchive(merged, request)
    const { offset, end, totalTurns } = traceArchivePageBounds(archive?.turns.length ?? 0, request)
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(offset, end) } : null,
      offset,
      totalTurns,
      hasOlder: offset > 0,
      turnFilesRead: inspected.valid.length,
      readMode: 'index_rebuild',
      sourceComplete: inspected.invalid.length === 0,
      sourceIssue: inspected.invalid.length ? `${inspected.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }

  const scopedEntries = selectArchiveProfile(index.entries, request)
  const { offset, end, totalTurns } = traceArchivePageBounds(scopedEntries.length, request)
  const selected = scopedEntries.slice(offset, end)
  const archives = await Promise.all(selected.map(async (entry) => {
    const segmentPath = join(dir, entry.file)
    let segmentStat
    try { segmentStat = await lstat(segmentPath) } catch { return null }
    if (entry.size == null || entry.mtimeMs == null || entry.ctimeMs == null || entry.ino == null ||
        segmentStat.size !== entry.size || segmentStat.mtimeMs !== entry.mtimeMs || segmentStat.ctimeMs !== entry.ctimeMs || segmentStat.ino !== entry.ino) return null
    const inspected = await inspectArchiveFileAsync(
      args.userDataDir, segmentPath, args.cwd, args.sessionId, args.providerId, signal
    )
    if (inspected.status !== 'valid' || inspected.archive.turns.length !== 1) return null
    const turn = inspected.archive.turns[0]
    return turn.runId === entry.runId && turn.ts === entry.ts &&
      (!Object.hasOwn(request, 'agentProfileId') || turn.agentProfileId === request.agentProfileId) ? inspected.archive : null
  }))
  if (archives.some((archive) => archive == null)) {
    const rebuilt = await inspectSegmentedArchivesAsync(args, signal)
    if (strictStorage && rebuilt.invalid.length) throw Object.assign(new Error('history_profile_unavailable'), { code: 'history_profile_unavailable' })
    const merged = mergeArchives(rebuilt.valid)
    const archive = profileArchive(merged, request)
    const { offset: rebuiltOffset, end: rebuiltEnd, totalTurns: rebuiltTotal } = traceArchivePageBounds(
      archive?.turns.length ?? 0,
      request
    )
    return {
      archive: archive ? { ...archive, turns: archive.turns.slice(rebuiltOffset, rebuiltEnd) } : null,
      offset: rebuiltOffset,
      totalTurns: rebuiltTotal,
      hasOlder: rebuiltOffset > 0,
      turnFilesRead: rebuilt.valid.length,
      readMode: 'index_rebuild',
      sourceComplete: rebuilt.invalid.length === 0,
      sourceIssue: rebuilt.invalid.length ? `${rebuilt.invalid.length} canonical archive segment(s) unavailable` : undefined
    }
  }
  return {
    archive: mergeArchives(archives.filter((archive): archive is TraceArchive => archive != null)),
    offset,
    totalTurns,
    hasOlder: offset > 0,
    turnFilesRead: selected.length,
    readMode: 'indexed',
    sourceComplete: index.sourceComplete !== false,
    sourceIssue: index.sourceIssue
  }
}

export function traceArchiveRunIds(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): string[] {
  const ids = new Set<string>()
  for (const archive of archiveCandidates(args)) {
    for (const turn of archive.turns) if (turn.runId) ids.add(turn.runId)
  }
  return [...ids]
}

/** Exact, bounded history read. A corrupt canonical turn never falls back to an older copy. */
export async function readTraceArchiveTurnForHistory(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
  runId: string
  providerTurnId?: string
  maxBytes: number
}): Promise<{ turn: TraceArchiveTurn; bytesRead: number }> {
  const paths = [
    traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, args.providerId, args),
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  ]
  for (const path of paths) {
    let handle: Awaited<ReturnType<typeof openFile>>
    try {
      trustedOwnedParent(args.userDataDir, path, false)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('交接源归档不是受控普通文件')
      handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > args.maxBytes) throw new Error('交接源归档超出读取预算或不是普通文件')
      // Published archives are atomically replaced. Bound allocation even if a file is edited in place.
      const buffer = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      if (length !== info.size) throw new Error('读取交接源归档时文件发生变化')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
      const inspected = validateArchive(JSON.parse(text), args.cwd, args.sessionId, args.providerId)
      if (inspected.status !== 'valid') throw new Error('交接源归档损坏或身份不匹配')
      const turns = inspected.archive.turns.filter((turn) => turn.runId === args.runId)
      if (turns.length !== 1 || (args.providerTurnId && turns[0].providerTurnId !== args.providerTurnId)) {
        throw new Error('交接源归档缺少唯一匹配的原生轮次')
      }
      return { turn: turns[0], bytesRead: length }
    } finally {
      await handle.close()
    }
  }
  throw new Error('交接源归档不存在')
}

export async function findTraceArchiveTurnMatches(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
  runId: string
  providerTurnId?: string
}): Promise<{ byRunId?: TraceArchiveTurn; byProviderTurnId?: TraceArchiveTurn }> {
  const exactPath = traceArchiveTurnPath(
    args.userDataDir,
    args.cwd,
    args.sessionId,
    args.providerId,
    { runId: args.runId, providerTurnId: args.providerTurnId }
  )
  const [legacy, exact] = await Promise.all([
    inspectArchiveFileAsync(args.userDataDir, traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId), args.cwd, args.sessionId, args.providerId),
    inspectArchiveFileAsync(args.userDataDir, exactPath, args.cwd, args.sessionId, args.providerId)
  ])
  const archives: TraceArchive[] = []
  if (legacy.status === 'valid') archives.push(legacy.archive)
  if (exact.status === 'valid' && exact.archive.turns.length === 1) archives.push(exact.archive)
  const turns = mergeArchives(archives)?.turns ?? []
  return {
    byRunId: turns.find((turn) => turn.runId === args.runId),
    byProviderTurnId: args.providerTurnId
      ? turns.find((turn) => turn.providerTurnId === args.providerTurnId)
      : undefined
  }
}

type TraceArchiveUpsertInput = Parameters<typeof upsertTraceArchiveTurn>[0]

// Archive pages order turns by `ts`; ties fall back to the hashed file key, which
// is stable but not chronological. Two turns archived within one millisecond would
// then page out of order, so locally assigned stamps are strictly increasing.
let lastTraceArchiveTs = 0
function nextTraceArchiveTs(): number {
  lastTraceArchiveTs = Math.max(Date.now(), lastTraceArchiveTs + 1)
  return lastTraceArchiveTs
}

function prepareArchiveUpdate(
  args: TraceArchiveUpsertInput,
  providerId: ProviderId,
  turn: TraceArchiveTurn,
  existing: ReturnType<typeof inspectArchiveFile>,
  fp: string
): TraceArchive | boolean {
  if (existing.status === 'invalid') return false
  if (
    existing.status === 'valid' &&
    (existing.archive.turns.length !== 1 ||
      traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, existing.archive.turns[0]) !== fp)
  ) return false
  try {
    const policy = existing.status === 'valid' ? existing.archive.turns[0]?.toolContentPolicy : undefined
    turn = protectToolContent({ ...turn, ...(policy ? { toolContentPolicy: policy } : {}) }, args.cwd)
  } catch { return false }
  // Managed commit retries can present the same immutable turn more than once. Avoid touching
  // the canonical segment and its growing page index when the durable body is unchanged.
  if (existing.status === 'valid' && existing.archive.turns.length === 1 &&
      JSON.stringify(existing.archive.turns[0]) === JSON.stringify(turn)) return true
  return {
    version: 3,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId,
    runtimeProvider: args.runtimeProvider ?? (existing.status === 'valid' ? existing.archive.runtimeProvider : undefined),
    turns: [turn]
  }
}

export function upsertTraceArchiveTurn(args: {
  cwd: string
  sessionId: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  userDataDir: string
  turn: Omit<TraceArchiveTurn, 'ts'> & { ts?: number }
}): boolean {
  if (!args.sessionId) return false
  const providerId = args.providerId ?? 'claude'
  let turn: TraceArchiveTurn = {
    ...args.turn,
    attachments: args.turn.attachments?.map((attachment) =>
      'storage' in attachment
        ? attachment
        : storeAttachmentReference(args.userDataDir, args.turn.runId, attachment as AgentInputAttachment)
    ),
    // capture 层已经按总字节数截断 patch；保留它才能让重启/切换后的 Review
    // 与实时会话一致，避免“有 +/- 统计但历史无 diff”的假降级。
    items: args.turn.items,
    ts: args.turn.ts ?? nextTraceArchiveTs()
  }
  const fp = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
  const existing = inspectArchiveFile(args.userDataDir, fp, args.cwd, args.sessionId, providerId)
  const archive = prepareArchiveUpdate(args, providerId, turn, existing, fp)
  if (typeof archive === 'boolean') return archive
  turn = archive.turns[0]
  const indexArgs = {
    userDataDir: args.userDataDir,
    cwd: args.cwd,
    sessionId: args.sessionId,
    providerId
  }
  try {
    markTraceArchiveCatalogIndexDirty(args.userDataDir)
    writeOwnedFileAtomically(args.userDataDir, fp, `${JSON.stringify(archive)}\n`)
    const stat = lstatSync(fp)
    writeTraceArchiveMetadataSidecar(indexArgs, {
      file: `${traceArchiveTurnKey(turn)}.json`,
      profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION,
      runId: turn.runId,
      ts: turn.ts,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
      ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
      metadata: archiveTurnMetadata(turn)
    })
    return true
  } catch {
    return false
  }
}

export async function upsertTraceArchiveTurnAsync(args: {
  cwd: string
  sessionId: string
  providerId?: ProviderId
  runtimeProvider?: RuntimeProvider
  userDataDir: string
  turn: Omit<TraceArchiveTurn, 'ts'> & { ts?: number }
}): Promise<boolean> {
  if (!args.sessionId) return false
  const providerId = args.providerId ?? 'claude'
  const attachments = args.turn.attachments
    ? await Promise.all(args.turn.attachments.map((attachment) =>
        'storage' in attachment ? attachment : storeAttachmentReferenceAsync(args.userDataDir, args.turn.runId, attachment as AgentInputAttachment)))
    : undefined
  let turn: TraceArchiveTurn = {
    ...args.turn,
    attachments,
    items: args.turn.items,
    ts: args.turn.ts ?? nextTraceArchiveTs()
  }
  const fp = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
  const existing = await inspectArchiveFileAsync(args.userDataDir, fp, args.cwd, args.sessionId, providerId)
  const archive = prepareArchiveUpdate(args, providerId, turn, existing, fp)
  if (typeof archive === 'boolean') return archive
  turn = archive.turns[0]
  const indexArgs = { userDataDir: args.userDataDir, cwd: args.cwd, sessionId: args.sessionId, providerId }
  try {
    await markTraceArchiveCatalogIndexDirtyAsync(args.userDataDir)
    await writeOwnedFileAtomicallyAsync(args.userDataDir, fp, `${JSON.stringify(archive)}\n`)
    const stat = await lstat(fp)
    await writeTraceArchiveMetadataSidecarAsync(indexArgs, {
      file: `${traceArchiveTurnKey(turn)}.json`, profileMetadataVersion: TRACE_ARCHIVE_PROFILE_METADATA_VERSION, runId: turn.runId, ts: turn.ts,
      size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino,
      ...(turn.agentProfileId !== undefined ? { agentProfileId: turn.agentProfileId } : {}),
      metadata: archiveTurnMetadata(turn)
    })
    return true
  } catch { return false }
}

export function resolveTranscriptPath(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): string | null {
  const primary = transcriptPath(args.cwd, args.sessionId, args.home)
  if (inspectTranscriptIdentity(primary, args.cwd, args.sessionId).status === 'match') return primary
  const archived = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  if (trustedOwnedFile(args.userDataDir, archived)) return archived
  return null
}

const transcriptMirrorTasks = new Map<string, Promise<boolean>>()

export function mirrorTranscript(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): Promise<boolean> {
  const source = transcriptPath(args.cwd, args.sessionId, args.home)
  const dest = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  const previous = transcriptMirrorTasks.get(dest) ?? Promise.resolve(true)
  const task = previous.then(async () => {
    // Validate capture configuration without suppressing raw mirrors in full mode.
    // Historical mirrors and Provider-owned transcripts are not rewritten or deleted here.
    try { workspaceToolContentPolicy(args.cwd) } catch { return false }
    if (inspectTranscriptIdentity(source, args.cwd, args.sessionId).status !== 'match') return false
    try {
      await copyToOwnedFileAtomically(args.userDataDir, source, dest)
      return true
    } catch {
      return false
    }
  })
  transcriptMirrorTasks.set(dest, task)
  void task.finally(() => {
    if (transcriptMirrorTasks.get(dest) === task) transcriptMirrorTasks.delete(dest)
  })
  return task
}

type TranscriptIdentityInspection = { status: 'match' | 'foreign' } | { status: 'invalid'; error: string }
interface TranscriptIdentityCache {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  cwd: string
  sessionId: string
  endedWithNewline: boolean
  prefixHash: string
  cwds: Set<string>
  sessions: Set<string>
}
const transcriptIdentityCache = new Map<string, TranscriptIdentityCache>()

function transcriptIdentityResult(
  state: Pick<TranscriptIdentityCache, 'cwds' | 'sessions' | 'cwd' | 'sessionId'>
): TranscriptIdentityInspection {
  if (state.cwds.size !== 1 || state.sessions.size !== 1) {
    return { status: 'invalid', error: 'transcript has missing or conflicting identity' }
  }
  return state.cwds.has(state.cwd) && state.sessions.has(state.sessionId) ? { status: 'match' } : { status: 'foreign' }
}

function readUtf8Range(filePath: string, start: number, end: number): string {
  const buffer = Buffer.alloc(Math.max(0, end - start))
  const fd = openSync(filePath, 'r')
  let offset = 0
  try {
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, start + offset)
      if (read === 0) break
      offset += read
    }
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8', 0, offset)
}

function transcriptPrefixHash(filePath: string, size: number): string {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.allocUnsafe(Math.min(4096, size))
    const bytesRead = buffer.length ? readSync(fd, buffer, 0, buffer.length, 0) : 0
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

function inspectTranscriptIdentity(
  filePath: string,
  cwd: string,
  sessionId: string
): TranscriptIdentityInspection {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'invalid', error: 'transcript is not a trusted regular file' }
    const prefixHash = transcriptPrefixHash(filePath, stat.size)
    const cached = transcriptIdentityCache.get(filePath)
    if (
      cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.cwd === cwd && cached.sessionId === sessionId &&
      cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.prefixHash === prefixHash
    ) return transcriptIdentityResult(cached)

    const append = cached && cached.dev === stat.dev && cached.ino === stat.ino && cached.cwd === cwd &&
      cached.sessionId === sessionId && cached.endedWithNewline && cached.prefixHash === prefixHash &&
      stat.mtimeMs >= cached.mtimeMs && stat.size > cached.size
    const start = append ? cached.size : 0
    const cwds = append ? new Set(cached.cwds) : new Set<string>()
    const sessions = append ? new Set(cached.sessions) : new Set<string>()
    const content = readUtf8Range(filePath, start, stat.size)
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as Record<string, unknown>
      if (typeof row.cwd === 'string') cwds.add(row.cwd)
      if (typeof row.sessionId === 'string') sessions.add(row.sessionId)
    }
    const state: TranscriptIdentityCache = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      cwd,
      sessionId,
      endedWithNewline: content.endsWith('\n'),
      prefixHash,
      cwds,
      sessions
    }
    transcriptIdentityCache.delete(filePath)
    transcriptIdentityCache.set(filePath, state)
    if (transcriptIdentityCache.size > 128) transcriptIdentityCache.delete(transcriptIdentityCache.keys().next().value!)
    return transcriptIdentityResult(state)
  } catch (error) {
    transcriptIdentityCache.delete(filePath)
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

type DeleteFailure = { path: string; error: string }

export function deleteTranscriptCopies(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
  providerId?: ProviderId
}): { deleted: string[]; failed: Array<{ path: string; error: string }> } {
  const providerId = args.providerId ?? 'claude'
  const indexPath = traceArchiveIndexPath(args.userDataDir, args.cwd, args.sessionId, providerId)
  const exactTargets = [
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId),
    `${traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId)}.tmp`,
    indexPath,
    `${indexPath}.tmp`
  ]
  if (providerId === 'claude') {
    // The Provider-native ~/.claude transcript is not owned by Scry. Keeping it
    // preserves Claude Code history/resume; this operation removes only Scry copies.
    const archived = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
    exactTargets.push(archived, `${archived}.tmp`)
  }
  const deleted: string[] = []
  const failed: DeleteFailure[] = []
  const segmented = inspectSegmentedArchives({
    cwd: args.cwd,
    sessionId: args.sessionId,
    userDataDir: args.userDataDir,
    providerId
  })
  const segmentTemps = trustedSegmentTempPaths({
    cwd: args.cwd,
    sessionId: args.sessionId,
    userDataDir: args.userDataDir,
    providerId
  })
  exactTargets.push(...segmentTemps.paths)
  if (segmentTemps.error) failed.push(segmentTemps.error)
  const metadataDir = traceArchiveMetadataDir(args.userDataDir, args.cwd, args.sessionId, providerId)
  try {
    trustedOwnedParent(args.userDataDir, join(metadataDir, '.identity'), false)
    for (const name of readdirSync(metadataDir)) {
      if (TRACE_ARCHIVE_METADATA_FILE.test(name) || TRACE_ARCHIVE_METADATA_TEMP_FILE.test(name)) {
        exactTargets.push(join(metadataDir, name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      failed.push({ path: metadataDir, error: error instanceof Error ? error.message : String(error) })
    }
  }
  for (const invalid of segmented.invalid) {
    failed.push(invalid)
    if (/\/turn-[a-f0-9]{64}\.json$/.test(invalid.path)) exactTargets.push(invalid.path, `${invalid.path}.tmp`)
  }
  for (const archive of segmented.valid) {
    const turn = archive.turns[0]
    const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
    exactTargets.push(path, `${path}.tmp`)
  }
  markTraceArchiveCatalogIndexDirty(args.userDataDir)
  for (const fp of [...new Set(exactTargets)]) {
    try {
      trustedOwnedParent(args.userDataDir, fp, false)
      unlinkSync(fp)
      transcriptMirrorProvenance.delete(fp)
      transcriptIdentityCache.delete(fp)
      deleted.push(fp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push({ path: fp, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  // The dirty marker above keeps the catalog untrusted; the next background discovery rescans
  // instead of this deletion synchronously rescanning and rewriting the whole catalog.
  return { deleted, failed }
}
