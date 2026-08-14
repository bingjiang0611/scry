import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
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

export function legacyArchivedTranscriptPath(userDataDir: string, cwd: string, sessionId: string): string {
  return join(userDataDir, 'transcripts', encodeCwd(cwd), nativeSessionFileStem(sessionId) + '.jsonl')
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

export function legacyTraceArchivePath(userDataDir: string, cwd: string, sessionId: string): string {
  return join(userDataDir, 'trace-archives', encodeCwd(cwd), nativeSessionFileStem(sessionId) + '.json')
}

export function legacyScopedTraceArchivePath(
  userDataDir: string,
  cwd: string,
  sessionId: string,
  providerId: ProviderId = 'claude'
): string {
  return join(userDataDir, 'trace-archives-v2', providerId, encodeCwd(cwd), nativeSessionFileStem(sessionId) + '.json')
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

export function cleanupTraceArchiveTemps(userDataDir: string): void {
  const root = join(userDataDir, 'trace-archive-turns-v1')
  const walk = (dir: string, depth: number): void => {
    let names: string[]
    try {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink()) continue
        if (depth < 3 && stat.isDirectory()) walk(path, depth + 1)
        else if (depth === 3 && stat.isFile() && /^turn-[a-f0-9]{64}\.json\.tmp$/.test(name)) unlinkSync(path)
      } catch {
        // Startup cleanup is best-effort and only touches strict Scry temp names.
      }
    }
  }
  walk(root, 0)
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

export function inferTraceArchiveProvider(archive: TraceArchive): ProviderId | undefined {
  const identities = archiveProviderIdentities(archive)
  return !identities.invalid && identities.ids.size === 1 ? [...identities.ids][0] : undefined
}

export function inferLegacyTraceArchiveProvider(archive: TraceArchive): ProviderId | undefined {
  const identities = archiveProviderIdentities(archive)
  if (identities.invalid || identities.ids.size > 1) return undefined
  return identities.ids.size === 0 ? 'claude' : [...identities.ids][0]
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

function copyToOwnedFileAtomically(userDataDir: string, source: string, filePath: string): void {
  trustedOwnedParent(userDataDir, filePath, true)
  const tmp = `${filePath}.tmp`
  try {
    try {
      unlinkSync(tmp)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    copyFileSync(source, tmp, constants.COPYFILE_EXCL)
    renameSync(tmp, filePath)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
    throw error
  }
}

type ArchiveInspection =
  | { status: 'missing' }
  | { status: 'invalid'; reason: 'untrusted' | 'corrupt' | 'identity_mismatch' | 'provider_mismatch'; error: string }
  | { status: 'valid'; archive: TraceArchive }

const PROVIDER_IDS = new Set<ProviderId>(['claude', 'codex', 'qoder', 'opencode'])
const RUNTIME_PROVIDERS = new Set<RuntimeProvider>(['claude_sdk', 'codex_cli', 'qoder_cli', 'opencode_server'])

function isArchiveShape(value: unknown): value is TraceArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const archive = value as Partial<TraceArchive>
  if (
    (archive.version !== 1 && archive.version !== 2 && archive.version !== 3) ||
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
  let parsed: TraceArchive
  try {
    const value: unknown = JSON.parse(readFileSync(fp, 'utf8'))
    if (!isArchiveShape(value)) {
      return { status: 'invalid', reason: 'corrupt', error: 'archive schema is invalid' }
    }
    parsed = value
  } catch (error) {
    return { status: 'invalid', reason: 'corrupt', error: `archive is corrupt: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (parsed.cwd !== cwd || parsed.sessionId !== sessionId) {
    return { status: 'invalid', reason: 'identity_mismatch', error: 'archive belongs to another session/cwd' }
  }
  const identities = archiveProviderIdentities(parsed)
  if (identities.invalid || identities.ids.size > 1 || (expectedProvider && identities.ids.size === 1 && !identities.ids.has(expectedProvider))) {
    return { status: 'invalid', reason: 'provider_mismatch', error: 'archive contains conflicting Provider identity' }
  }
  return { status: 'valid', archive: normalizeArchive(parsed) }
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
}): { current: ArchiveInspection; segmented: SegmentedArchiveInspection; valid: TraceArchive[] } {
  const current = inspectArchiveFile(
    args.userDataDir,
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId
  )
  const legacyScoped = inspectArchiveFile(
    args.userDataDir,
    legacyScopedTraceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    args.cwd,
    args.sessionId,
    args.providerId
  )
  const legacy = args.providerId === 'claude'
    ? inspectArchiveFile(
        args.userDataDir,
        legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId),
        args.cwd,
        args.sessionId,
        args.providerId
      )
    : { status: 'missing' as const }
  const segmented = inspectSegmentedArchives(args)
  return {
    current,
    segmented,
    valid: [legacy, legacyScoped, current]
      .filter((candidate): candidate is Extract<ArchiveInspection, { status: 'valid' }> => candidate.status === 'valid')
      .map((candidate) => candidate.archive)
      .concat(segmented.valid)
  }
}

export function readTraceArchive(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId?: ProviderId
}): TraceArchive | null {
  if (args.providerId) {
    const candidates = archiveCandidates({ ...args, providerId: args.providerId })
    return mergeArchives(candidates.valid)
  }
  const legacy = readArchiveFile(
    args.userDataDir,
    legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId),
    args.cwd,
    args.sessionId
  )
  if (!legacy) return null
  return legacy
}

export function traceArchiveRunIds(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  providerId?: ProviderId
}): string[] {
  const ids = new Set<string>()
  const archives = args.providerId
    ? (() => {
        const candidates = archiveCandidates({ ...args, providerId: args.providerId })
        return candidates.valid
      })()
    : [readArchiveFile(args.userDataDir, legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId), args.cwd, args.sessionId)]
  for (const archive of archives) {
    if (!archive) continue
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
  const legacyPaths = [
    ...(args.providerId === 'claude'
      ? [legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId)]
      : []),
    legacyScopedTraceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId),
    traceArchivePath(args.userDataDir, args.cwd, args.sessionId, args.providerId)
  ]
  for (const path of legacyPaths) {
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
  const legacy = legacyArchivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  if (legacyTranscriptIdentityMatches(args.userDataDir, legacy, args.cwd, args.sessionId)) return legacy
  return null
}

export function mirrorTranscript(args: {
  cwd: string
  sessionId: string
  userDataDir: string
  home?: string
}): boolean {
  const source = transcriptPath(args.cwd, args.sessionId, args.home)
  if (inspectTranscriptIdentity(source, args.cwd, args.sessionId).status !== 'match') return false
  const dest = archivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
  try {
    copyToOwnedFileAtomically(args.userDataDir, source, dest)
    return true
  } catch {
    return false
  }
}

type LegacyIdentityInspection = { status: 'match' | 'foreign' } | { status: 'invalid'; error: string }

function inspectTranscriptIdentity(
  filePath: string,
  cwd: string,
  sessionId: string
): LegacyIdentityInspection {
  try {
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return { status: 'invalid', error: 'transcript is not a trusted regular file' }
    const cwds = new Set<string>()
    const sessions = new Set<string>()
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as Record<string, unknown>
      if (typeof row.cwd === 'string') cwds.add(row.cwd)
      if (typeof row.sessionId === 'string') sessions.add(row.sessionId)
    }
    if (cwds.size !== 1 || sessions.size !== 1) {
      return { status: 'invalid', error: 'legacy transcript has missing or conflicting identity' }
    }
    return cwds.has(cwd) && sessions.has(sessionId) ? { status: 'match' } : { status: 'foreign' }
  } catch (error) {
    return { status: 'invalid', error: error instanceof Error ? error.message : String(error) }
  }
}

function inspectLegacyTranscriptIdentity(
  userDataDir: string,
  filePath: string,
  cwd: string,
  sessionId: string
): LegacyIdentityInspection {
  if (!trustedOwnedFile(userDataDir, filePath)) return { status: 'invalid', error: 'legacy transcript is not trusted' }
  return inspectTranscriptIdentity(filePath, cwd, sessionId)
}

function legacyTranscriptIdentityMatches(userDataDir: string, filePath: string, cwd: string, sessionId: string): boolean {
  return inspectLegacyTranscriptIdentity(userDataDir, filePath, cwd, sessionId).status === 'match'
}

type DeleteFailure = { path: string; error: string }

function inspectLegacyDeletionTarget(
  userDataDir: string,
  filePath: string,
  inspect: () => LegacyIdentityInspection
): { target?: string; failure?: DeleteFailure } {
  try {
    trustedOwnedParent(userDataDir, filePath, false)
    const stat = lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { failure: { path: filePath, error: 'legacy Scry copy is not a trusted regular file' } }
    }
    const identity = inspect()
    if (identity.status === 'foreign') return {}
    if (identity.status === 'invalid') return { failure: { path: filePath, error: identity.error } }
    return { target: filePath }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { failure: { path: filePath, error: error instanceof Error ? error.message : String(error) } }
  }
}

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
  const legacyCandidates: Array<{ path: string; inspect: () => LegacyIdentityInspection }> = []
  const legacyScoped = legacyScopedTraceArchivePath(args.userDataDir, args.cwd, args.sessionId, providerId)
  for (const path of [legacyScoped, `${legacyScoped}.tmp`]) {
    legacyCandidates.push({
      path,
      inspect: () => {
        const archive = inspectArchiveFile(args.userDataDir, path, args.cwd, args.sessionId, providerId)
        if (archive.status === 'valid') return { status: 'match' }
        if (archive.status === 'invalid' && archive.reason === 'identity_mismatch') return { status: 'foreign' }
        return { status: 'invalid', error: archive.status === 'invalid' ? archive.error : 'legacy archive disappeared' }
      }
    })
  }
  if (providerId === 'claude') {
    const legacy = legacyTraceArchivePath(args.userDataDir, args.cwd, args.sessionId)
    for (const path of [legacy, `${legacy}.tmp`]) {
      legacyCandidates.push({
        path,
        inspect: () => {
          const archive = inspectArchiveFile(args.userDataDir, path, args.cwd, args.sessionId, providerId)
          if (archive.status === 'valid') return { status: 'match' }
          if (archive.status === 'invalid' && archive.reason === 'identity_mismatch') return { status: 'foreign' }
          return { status: 'invalid', error: archive.status === 'invalid' ? archive.error : 'legacy archive disappeared' }
        }
      })
    }
    const transcript = legacyArchivedTranscriptPath(args.userDataDir, args.cwd, args.sessionId)
    for (const path of [transcript, `${transcript}.tmp`]) {
      legacyCandidates.push({
        path,
        inspect: () => inspectLegacyTranscriptIdentity(args.userDataDir, path, args.cwd, args.sessionId)
      })
    }
  }
  for (const candidate of legacyCandidates) {
    const inspected = inspectLegacyDeletionTarget(args.userDataDir, candidate.path, candidate.inspect)
    if (inspected.target) exactTargets.push(inspected.target)
    if (inspected.failure) failed.push(inspected.failure)
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
