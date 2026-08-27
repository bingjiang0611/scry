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
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { isDiffSnapshotStage, normalizeTurnDiffSnapshot, type TraceEvent } from '../shared/trace'
import type { AgentInputAttachment } from '../shared/runtime'
import { providerIdForRuntime, type RuntimeProvider } from '../shared/runtime'
import type { ProviderId } from '../shared/provider'
import type { AgentTurnRecord, TurnEvidence } from '../shared/turn-record'
import { storeAttachmentReference, type StoredAttachment } from './attachment-store'

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
  runId: string
  providerTurnId?: string
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

export function traceArchivePath(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId = 'claude'): string {
  return join(userDataDir, 'trace-archives-v2', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId) + '.json')
}

function traceArchiveTurnDir(userDataDir: string, cwd: string, sessionId: string, providerId: ProviderId): string {
  return join(userDataDir, 'trace-archive-turns-v1', providerId, ownedCwdKey(cwd), ownedSessionFileStem(sessionId))
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
      if (!/^turn-[a-f0-9]{64}\.json\.tmp$/.test(name)) continue
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
        else if (depth === 3 && entry.isFile() && /^turn-[a-f0-9]{64}\.json\.tmp$/.test(entry.name)) {
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

const transcriptMirrorProvenance = new Map<string, { sourceDev: number; sourceIno: number; sourceSize: number; sourceMtimeMs: number }>()

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
          transcriptMirrorProvenance.set(filePath, {
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
    transcriptMirrorProvenance.set(filePath, {
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
  expectedProvider?: ProviderId
): Promise<ArchiveInspection> {
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
    return validateArchive(JSON.parse(await readFile(fp, 'utf8')), cwd, sessionId, expectedProvider)
  } catch (error) {
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function readArchiveFile(
  userDataDir: string,
  fp: string,
  cwd: string,
  sessionId: string,
  expectedProvider?: ProviderId
): TraceArchive | null {
  const inspected = inspectArchiveFile(userDataDir, fp, cwd, sessionId, expectedProvider)
  return inspected.status === 'valid' ? inspected.archive : null
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
}): Promise<SegmentedArchiveInspection> {
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
  for (const name of names) {
    const path = join(dir, name)
    const inspected = await inspectArchiveFileAsync(args.userDataDir, path, args.cwd, args.sessionId, args.providerId)
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

export async function readTraceArchiveAsync(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
}): Promise<TraceArchive | null> {
  const current = await inspectArchiveFileAsync(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId
  )
  const segmented = await inspectSegmentedArchivesAsync(args)
  return mergeArchives((current.status === 'valid' ? [current.archive] : []).concat(segmented.valid))
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

export function findTraceArchiveTurnMatches(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId: ProviderId
  runId: string
  providerTurnId?: string
}): { byRunId?: TraceArchiveTurn; byProviderTurnId?: TraceArchiveTurn } {
  const archives: TraceArchive[] = []
  for (const path of [traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)]) {
    const archive = readArchiveFile(args.userDataDir, path, args.cwd, args.sessionId, args.providerId)
    if (archive) archives.push(archive)
  }
  const exactPath = traceArchiveTurnPath(
    args.userDataDir,
    args.cwd,
    args.sessionId,
    args.providerId,
    { runId: args.runId, providerTurnId: args.providerTurnId }
  )
  const exact = readArchiveFile(args.userDataDir, exactPath, args.cwd, args.sessionId, args.providerId)
  if (exact?.turns.length === 1) archives.push(exact)
  const turns = mergeArchives(archives)?.turns ?? []
  return {
    byRunId: turns.find((turn) => turn.runId === args.runId),
    byProviderTurnId: args.providerTurnId
      ? turns.find((turn) => turn.providerTurnId === args.providerTurnId)
      : undefined
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
  const turn: TraceArchiveTurn = {
    ...args.turn,
    attachments: args.turn.attachments?.map((attachment) =>
      'storage' in attachment
        ? attachment
        : storeAttachmentReference(args.userDataDir, args.turn.runId, attachment as AgentInputAttachment)
    ),
    // capture 层已经按总字节数截断 patch；保留它才能让重启/切换后的 Review
    // 与实时会话一致，避免“有 +/- 统计但历史无 diff”的假降级。
    items: args.turn.items,
    ts: args.turn.ts ?? Date.now()
  }
  const fp = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
  const existing = inspectArchiveFile(args.userDataDir, fp, args.cwd, args.sessionId, providerId)
  if (existing.status === 'invalid') return false
  if (
    existing.status === 'valid' &&
    (existing.archive.turns.length !== 1 ||
      traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, existing.archive.turns[0]) !== fp)
  ) return false
  const archive: TraceArchive = {
    version: 3,
    cwd: args.cwd,
    sessionId: args.sessionId,
    externalSessionId: args.sessionId,
    providerId,
    runtimeProvider: args.runtimeProvider ?? (existing.status === 'valid' ? existing.archive.runtimeProvider : undefined),
    turns: [turn]
  }
  try {
    writeOwnedFileAtomically(args.userDataDir, fp, `${JSON.stringify(archive)}\n`)
    return true
  } catch {
    return false
  }
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
  const exactTargets = [
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId),
    `${traceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId)}.tmp`
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
  for (const invalid of segmented.invalid) {
    failed.push(invalid)
    if (/\/turn-[a-f0-9]{64}\.json$/.test(invalid.path)) exactTargets.push(invalid.path, `${invalid.path}.tmp`)
  }
  for (const archive of segmented.valid) {
    const turn = archive.turns[0]
    const path = traceArchiveTurnPath(args.userDataDir, args.cwd, args.sessionId, providerId, turn)
    exactTargets.push(path, `${path}.tmp`)
  }
  for (const fp of [...new Set(exactTargets)]) {
    try {
      trustedOwnedParent(args.userDataDir, fp, false)
      unlinkSync(fp)
      deleted.push(fp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failed.push({ path: fp, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { deleted, failed }
}
