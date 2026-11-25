import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { lstat, open as openFile, readdir, rename, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { ToolContentPolicy } from '../core/turn-recorder/tool-content.js'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { TraceEvent } from '../shared/trace'
import type { RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { AgentTurnRecord, TurnEvidence } from '../shared/turn-record'
import type { StoredAttachment } from './attachment-store'

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

export const DISCOVERABLE_PROVIDER_IDS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode', 'pi', 'antigravity'])
export const TRACE_DISCOVERY_MAX_FILES = 10_000
export const TRACE_DISCOVERY_MAX_FILE_BYTES = 32 * 1024 * 1024
export const TRACE_DISCOVERY_MAX_TOTAL_BYTES = 256 * 1024 * 1024

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

export const TRACE_INDEX_MAX_BYTES = 32 * 1024 * 1024
export const TRACE_INDEX_FILE = 'trace-archive-index-v1.json'
export const TRACE_INDEX_DIRTY_FILE = 'trace-archive-index-v1.dirty'
export const TRACE_ARCHIVE_INDEX_SUFFIX = '.index-v1.json'
export const TRACE_ARCHIVE_METADATA_SUFFIX = '.meta-v1.json'
export const TRACE_ARCHIVE_METADATA_FILE = /^turn-[a-f0-9]{64}\.meta-v1\.json$/
export const TRACE_ARCHIVE_PAGE_INDEX_MAX_BYTES = 32 * 1024 * 1024
export const TRACE_ARCHIVE_PAGE_INDEX_MAX_ENTRIES = 100_000
export const TRACE_ARCHIVE_TURN_FILE = /^turn-[a-f0-9]{64}\.json$/
export const TRACE_ARCHIVE_TEMP_FILE = /^turn-[a-f0-9]{64}\.json\.tmp$/
export const TRACE_ARCHIVE_METADATA_TEMP_FILE = /^turn-[a-f0-9]{64}\.meta-v1\.json\.tmp$/
export const TRACE_ARCHIVE_PROFILE_METADATA_VERSION = 1 as const

export interface TraceArchiveIndexEntry {
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

export interface TraceArchiveDirectoryStamp {
  mtimeMs: number
  ctimeMs: number
  ino: number
}

export interface TraceArchiveIndex {
  version: 1 | 2
  profileMetadataVersion?: 1
  sourceComplete?: boolean
  sourceIssue?: string
  cwd: string
  sessionId: string
  providerId: ProviderId
  directory: TraceArchiveDirectoryStamp
  entries: TraceArchiveIndexEntry[]
}

export interface TraceArchiveVersion {
  version: string
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
}

export interface TraceArchivePage {
  archive: TraceArchive | null
  sourceComplete: boolean
  sourceIssue?: string
  offset: number
  totalTurns: number
  hasOlder: boolean
  turnFilesRead: number
  readMode: 'monolithic' | 'indexed' | 'index_rebuild'
}

export interface TraceArchivePageRequest {
  agentProfileId?: string | null
  requireComplete?: boolean
  before?: number
  limit?: number
  snapshotTotalTurns?: number
}

export function traceArchivePath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId = 'claude'): string {
  return join(userDataDir, 'trace-archives-v2', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId) + '.json')
}

export function traceArchiveTurnDir(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return join(userDataDir, 'trace-archive-turns-v1', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId))
}

export function traceArchiveMetadataDir(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return join(userDataDir, 'trace-archive-metadata-v1', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId))
}

export function traceArchiveIndexPath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return `${traceArchiveTurnDir(userDataDir, cwd, sessionId, providerId)}${TRACE_ARCHIVE_INDEX_SUFFIX}`
}

export function traceArchiveMetadataPath(dir: string, file: string): string {
  return join(dir, file.replace(/\.json$/, TRACE_ARCHIVE_METADATA_SUFFIX))
}

export function trustedSegmentTempPaths(args: {
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
          try { await unlink(path) } catch {}
        }
      }
    } catch {
    }
  }
  await walk(root, 0)
}

export function traceArchiveTurnKey(turn: Pick<TraceArchiveTurn, 'runId' | 'providerTurnId'>): string {
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

export function trustedOwnedParent(userDataDir: string, filePath: string, create: boolean): string {
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

export function trustedOwnedFile(userDataDir: string, filePath: string): boolean {
  try {
    trustedOwnedParent(userDataDir, filePath, false)
    const stat = lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export async function writeOwnedFileAtomicallyAsync(userDataDir: string, filePath: string, content: string): Promise<void> {
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
    try { await unlink(tmp) } catch {}
    throw error
  }
}

export function writeOwnedFileAtomically(userDataDir: string, filePath: string, content: string): void {
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
    }
    throw error
  }
}
