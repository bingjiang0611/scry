import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isToolContentRef, type ToolContentRef } from '../../shared/tool-content.js'
import { validateAgentTurnRecord, type AgentTurnRecord } from '../../shared/turn-record.js'
import { copyRecorderContent, readRecorderContent } from './content-store.js'
import { appendRotatingLog, exclusiveWriteTempPath, listFiles, mkdirDurable, readJson, syncDirectory, withDirectoryLock, writeFileAtomicExclusive, writeJsonAtomic } from './io.js'

export const RECORDER_VERSION = '0.2.45'

export interface RecorderHealth {
  schemaVersion: 1
  lastSuccessAt?: string
  lastError?: { at: string; message: string }
  droppedEvents: number
  orphanEvents: number
  pendingCount: number
  oldestPendingAgeMs: number
  recoveredRecords: number
}

export interface ExportPage {
  records: AgentTurnRecord[]
  nextCursor: number
  hasMore: boolean
  snapshotMaxSequence: number
}

const RECORD_PATTERN = /^(\d{20})-([a-f0-9]{32,64})\.json$/

type RecordFileEntry = { name: string; sequence: number; recordId: string }

interface RecordDirectoryStamp {
  dev: string
  ino: string
  mtimeNs: string
  ctimeNs: string
}

/** Disposable process-local projection. Canonical records remain the only persisted authority. */
interface RecordStoreIndex {
  stamp: RecordDirectoryStamp
  entries: RecordFileEntry[]
}

const RECORD_INDEX_CACHE_LIMIT = 32
const recordIndexCache = new Map<string, RecordStoreIndex>()
let recordIndexHits = 0
let recordIndexMisses = 0

export function recordStoreIndexStats(): { hits: number; misses: number; entries: number } {
  return { hits: recordIndexHits, misses: recordIndexMisses, entries: recordIndexCache.size }
}

export function resetRecordStoreIndex(): void {
  recordIndexCache.clear()
  recordIndexHits = 0
  recordIndexMisses = 0
}
const COMMIT_HOOK_TIMEOUT_MS = 10_000
const COMMIT_HOOK_KILL_GRACE_MS = 1_000
const COMMIT_HOOK_ENV_KEYS = [
  'HOME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONDONTWRITEBYTECODE',
  'CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'QODER_PROJECT_DIR',
  'OPENCODE_PROJECT_DIR', 'OPENCODE_WORKSPACE_DIR',
  'SCRY_CLI_PATH', 'SCRY_PROVIDER_ID', 'SCRY_RECORDER_MANAGED',
  'SCRY_RECORDER_REQUIRED_VERSION', 'SCRY_RECORDER_VERIFIED_VERSION',
  'SCRY_RECORDER_COMMIT_HOOK', 'SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT', 'SCRY_RECORDER_ENABLED',
  'SCRY_TURN_UPLOAD_ENABLED', 'SCRY_UPLOAD_DEADLINE_SECONDS',
  'SCRY_UPLOAD_LOCK_WAIT_SECONDS', 'SCRY_MANAGED_UPLOAD_WAIT_SECONDS',
  'SCRY_INSTALLATION_ID', 'SCRY_INSTALLATION_ID_FILE',
  'TMCP_TRACE_URL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'RATE_NATIVE_ASYNC_QUEUE_DIR'
] as const

export interface RecordCommittedNotification {
  schemaVersion: 1
  event: 'record-committed'
  workspace: string
  provider: AgentTurnRecord['provider']['id']
  sessionId: string
  recordId: string
  sequence: number
}

interface CommitHookState {
  schemaVersion: 1
  hookFingerprint: string
  ackedThrough: number
}

export function stableHash(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (!input || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]))
  }
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex')
}

export function safeKey(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'
  return `${readable}-${stableHash(value).slice(0, 12)}`
}

function parseRecordName(name: string): { sequence: number; recordId: string } | null {
  const match = RECORD_PATTERN.exec(name)
  if (!match) return null
  const sequence = Number(match[1])
  return Number.isSafeInteger(sequence) && sequence > 0 ? { sequence, recordId: match[2] } : null
}

async function recordDirectoryStamp(path: string): Promise<RecordDirectoryStamp | null> {
  try {
    const info = await stat(path, { bigint: true })
    return {
      dev: String(info.dev),
      ino: String(info.ino),
      mtimeNs: String(info.mtimeNs),
      ctimeNs: String(info.ctimeNs)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function sameRecordStamp(left: RecordDirectoryStamp | null, right: RecordDirectoryStamp | null): boolean {
  return left === right || (!!left && !!right && left.dev === right.dev && left.ino === right.ino && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs)
}

async function scanRecordFiles(dataRoot: string): Promise<{ entries: RecordFileEntry[]; stamp: RecordDirectoryStamp | null }> {
  const recordsPath = join(dataRoot, 'records')
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await recordDirectoryStamp(recordsPath)
    const entries = (await listFiles(recordsPath)).flatMap((name) => {
      const parsed = parseRecordName(name)
      return parsed ? [{ name, ...parsed }] : []
    }).sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
    const after = await recordDirectoryStamp(recordsPath)
    if (sameRecordStamp(before, after)) return { entries, stamp: after }
  }
  throw new Error('record store changed while building derived index')
}

async function recordFiles(dataRoot: string, options: { bypassIndex?: boolean } = {}): Promise<RecordFileEntry[]> {
  if (!options.bypassIndex) {
    const stamp = await recordDirectoryStamp(join(dataRoot, 'records'))
    const cached = recordIndexCache.get(dataRoot)
    if (cached && sameRecordStamp(cached.stamp, stamp)) {
      recordIndexCache.delete(dataRoot)
      recordIndexCache.set(dataRoot, cached)
      recordIndexHits++
      return cached.entries.map((entry) => ({ ...entry }))
    }
    recordIndexMisses++
  }

  const scanned = await scanRecordFiles(dataRoot)
  if (scanned.stamp && !options.bypassIndex) {
    recordIndexCache.set(dataRoot, { stamp: scanned.stamp, entries: scanned.entries })
    while (recordIndexCache.size > RECORD_INDEX_CACHE_LIMIT) {
      const oldest = recordIndexCache.keys().next().value
      if (typeof oldest !== 'string') break
      recordIndexCache.delete(oldest)
    }
  }
  return scanned.entries
}

function invalidateRecordIndex(dataRoot: string): void {
  recordIndexCache.delete(dataRoot)
}

/**
 * 按 recordId 精确定位一条正式记录。recordId 就写在文件名里，`readRecordFile`
 * 又强校验文件名↔内容一致，所以这里只读那一个文件，不解析整个 store。
 * 语义与「全量扫描后按 recordId 过滤」等价。
 */
export async function findRecordById(dataRoot: string, recordId: string): Promise<AgentTurnRecord | undefined> {
  const match = (await recordFiles(dataRoot)).find((file) => file.recordId === recordId)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : undefined
}

/**
 * 只由文件名派生的存储指纹（不读正文）。records 是 append-only 且序号严格递增，
 * 因此任何新提交都会改变 count 或 maxSequence —— 派生缓存用它判断自己是否仍然新鲜。
 * 它不是事实源，也不能替代记录本身的校验。
 */
export async function recordStoreStamp(dataRoot: string): Promise<{ count: number; maxSequence: number }> {
  const files = await recordFiles(dataRoot)
  return { count: files.length, maxSequence: files.at(-1)?.sequence ?? 0 }
}

// Recorder 0.2.16–0.2.18 could serialize empty model events without a text field.
// Drop only that known placeholder in the read view and mark the evidence partial;
// canonical bytes and the strict commit validator stay untouched.
function legacyModelSegmentsReadView(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.recorderVersion === 'string' ? /^0\.2\.(\d+)$/.exec(record.recorderVersion) : null
  if (record.schemaVersion !== 1 || !version || Number(version[1]) < 16 || Number(version[1]) > 18) return raw
  const modelSegments = record.modelSegments
  if (!modelSegments || typeof modelSegments !== 'object' || Array.isArray(modelSegments)) return raw
  const evidence = modelSegments as Record<string, unknown>
  if (!Array.isArray(evidence.value)) return raw
  const keys = new Set(['order', 'at', 'kind', 'text', 'messageId', 'providerItemId', 'parentId', 'agentId'])
  const isLegacyEmptySegment = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const segment = value as Record<string, unknown>
    return Object.keys(segment).every((key) => keys.has(key)) &&
      Number.isSafeInteger(segment.order) && Number(segment.order) >= 0 &&
      typeof segment.at === 'string' && Number.isFinite(Date.parse(segment.at)) &&
      (segment.kind === 'text' || segment.kind === 'thinking') &&
      (segment.text === undefined || segment.text === '') &&
      ['messageId', 'providerItemId', 'parentId', 'agentId'].every(
        (key) => segment[key] === undefined || typeof segment[key] === 'string'
      )
  }
  const omitted = evidence.value.filter(isLegacyEmptySegment)
  if (omitted.length === 0) return raw
  const value = evidence.value.filter((segment) => !isLegacyEmptySegment(segment))
  return {
    ...record,
    modelSegments: {
      ...evidence,
      status: 'partial',
      value,
      omissionReason: 'legacy recorder omitted empty model segment text'
    }
  }
}

// Older aggregators wrapped an unavailable residual timing result as partial.
// Normalize only that known writer defect in the read view; canonical bytes and
// the strict commit validator stay untouched, and no timing value is invented.
function legacyModelTimingReadView(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.recorderVersion === 'string' ? /^0\.2\.(\d+)$/.exec(record.recorderVersion) : null
  if (record.schemaVersion !== 1 || !version || Number(version[1]) < 27 || Number(version[1]) > 34) return raw
  const timing = record.modelTiming
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return raw
  const evidence = timing as Record<string, unknown>
  if (evidence.status !== 'partial' || evidence.quality !== 'unavailable' ||
      evidence.omissionReason !== 'turn wall-clock is inconsistent with observed activity intervals') return raw
  const value = evidence.value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return raw
  const residual = value as Record<string, unknown>
  if (residual.method !== 'non_call_residual' || !residual.activityCoverage ||
      Object.keys(residual).some((key) => key !== 'method' && key !== 'activityCoverage')) return raw
  return { ...record, modelTiming: { ...evidence, status: 'unavailable' } }
}

export async function readRecordFile(path: string): Promise<AgentTurnRecord> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  const validation = validateAgentTurnRecord(legacyModelTimingReadView(legacyModelSegmentsReadView(raw)))
  if (!validation.ok) {
    const detail = validation.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new Error(`invalid turn record: ${path}: ${detail}`)
  }
  const record = validation.record
  const parsed = parseRecordName(basename(path))
  if (!parsed || parsed.sequence !== record.sequence || parsed.recordId !== record.recordId) {
    throw new Error(`record filename/content mismatch: ${path}`)
  }
  return record
}

export async function commitRecord(
  dataRoot: string,
  draft: Omit<AgentTurnRecord, 'sequence'>
): Promise<{ status: 'committed' | 'duplicate'; record: AgentTurnRecord }> {
  if (!/^[a-f0-9]{32,64}$/.test(draft.recordId)) throw new Error('recordId must be a 32-64 character lowercase hex digest')
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    if (await archiveJournal(dataRoot)) {
      throw new Error('pending archive must be resumed before committing another record')
    }
    // Allocation and duplicate detection never trust a derived projection.
    const files = await recordFiles(dataRoot, { bypassIndex: true })
    const duplicate = files.find((file) => file.recordId === draft.recordId)
    if (duplicate) {
      return { status: 'duplicate' as const, record: await readRecordFile(join(dataRoot, 'records', duplicate.name)) }
    }
    // The allocator must clear the archive floor, otherwise archiving every live record would
    // restart numbering at 1 and collide with sequences that were already issued. Duplicate
    // detection only scans live records: archiving is therefore restricted to finalized turns
    // (and, when a commit hook exists, acknowledged ones), which cannot be re-committed.
    const archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
    const sequence = Math.max(files.at(-1)?.sequence ?? 0, archivedThrough) + 1
    const record: AgentTurnRecord = { ...draft, sequence }
    const validation = validateAgentTurnRecord(record)
    if (!validation.ok) {
      const detail = validation.issues.slice(0, 4).map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      throw new Error(`refusing to commit invalid turn record: ${detail}`)
    }
    const filename = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    await writeJsonAtomic(join(dataRoot, 'records', filename), record)
    invalidateRecordIndex(dataRoot)
    return { status: 'committed' as const, record }
  })
}

function commitNotification(record: AgentTurnRecord): RecordCommittedNotification {
  return {
    schemaVersion: 1,
    event: 'record-committed',
    workspace: record.workspace.root,
    provider: record.provider.id,
    sessionId: record.sessionId,
    recordId: record.recordId,
    sequence: record.sequence
  }
}

async function configuredCommitHook(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = env.SCRY_RECORDER_COMMIT_HOOK?.trim()
  if (!path) return null
  if (!isAbsolute(path)) throw new Error('SCRY_RECORDER_COMMIT_HOOK must be an absolute executable path')
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error('SCRY_RECORDER_COMMIT_HOOK must be an absolute executable path')
  }
  return path
}

function configuredCommitHookFingerprint(env: NodeJS.ProcessEnv): string {
  const fingerprint = env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT?.trim()
  return fingerprint || 'explicit-environment-v1'
}

async function invokeCommitHook(
  path: string,
  notification: RecordCommittedNotification,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const childEnv: NodeJS.ProcessEnv = {}
    for (const key of COMMIT_HOOK_ENV_KEYS) if (env[key] !== undefined) childEnv[key] = env[key]
    const child = spawn(path, [], { env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] })
    let settled = false
    let timedOut = false
    let inputFailed = false
    let terminationRequested = false
    let killTimer: NodeJS.Timeout | undefined
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolvePromise(ok)
    }
    const terminate = (): void => {
      if (settled || terminationRequested) return
      terminationRequested = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
      }, COMMIT_HOOK_KILL_GRACE_MS)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, COMMIT_HOOK_TIMEOUT_MS)
    timer.unref()
    child.once('error', () => settle(false))
    child.once('exit', (code) => settle(!timedOut && !inputFailed && code === 0))
    child.stdin.on('error', () => {
      inputFailed = true
      terminate()
    })
    child.stdin.end(`${JSON.stringify(notification)}\n`)
  })
}

export interface CommitNotificationStatus {
  ackedThrough: number | null
  notifyBacklog: number
}

/**
 * Durable ACK cursor plus backlog for the configured commit hook. `ackedThrough` is null
 * when no state file matches the current hook fingerprint, so callers can distinguish
 * "nothing acknowledged yet" from "acknowledged through sequence 0".
 */
export async function commitNotificationStatus(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<CommitNotificationStatus> {
  const fingerprint = configuredCommitHookFingerprint(env)
  const state = await readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
  const acked = state?.schemaVersion === 1 && state.hookFingerprint === fingerprint &&
    Number.isSafeInteger(state.ackedThrough) && state.ackedThrough >= 0
    ? state.ackedThrough
    : null
  const files = await recordFiles(dataRoot)
  return {
    ackedThrough: acked,
    notifyBacklog: files.filter((file) => file.sequence > (acked ?? 0)).length
  }
}

/**
 * Hook-path drain budget. The commit hook runs on the provider lifecycle critical path, so
 * a backlog must never be flushed synchronously: providers cap their hook at 10-15s and the
 * daemon client at 1-4s. The budget is checked between invocations, so COMMIT_HOOK_TIMEOUT_MS
 * remains the per-record circuit breaker, not the batch budget. Remaining records stay
 * pending and are picked up by the next hook, `recorder recover`, or `recorder notify-drain`.
 */
export const HOOK_DRAIN_MAX_RECORDS = 8
export const HOOK_DRAIN_BUDGET_MS = 1_500

export interface DrainOptions {
  maxRecords?: number
  budgetMs?: number
  now?: () => number
}

export interface DrainResult {
  delivered: number
  pending: number
  truncated: boolean
}

export async function drainCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DrainOptions = {}
): Promise<DrainResult> {
  let hook: string | null
  try {
    hook = await configuredCommitHook(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    const state = await readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
    const fingerprint = configuredCommitHookFingerprint(env)
    const ackedThrough = state?.schemaVersion === 1 && state.hookFingerprint === fingerprint ? state.ackedThrough : 0
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > ackedThrough).length, truncated: false }
  }
  if (!hook) return { delivered: 0, pending: 0, truncated: false }
  try {
    return await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
      const statePath = join(dataRoot, 'notifications', 'commit-hook-state.json')
      const state = await readJson<CommitHookState>(statePath)
      const hookFingerprint = configuredCommitHookFingerprint(env)
      const ackedThrough = state?.schemaVersion === 1 && state.hookFingerprint === hookFingerprint &&
        Number.isSafeInteger(state.ackedThrough) && state.ackedThrough >= 0
        ? state.ackedThrough
        : 0
      const pending = (await recordFiles(dataRoot)).filter((file) => file.sequence > ackedThrough)
      const now = options.now ?? Date.now
      const deadline = options.budgetMs != null ? now() + options.budgetMs : null
      let delivered = 0
      let truncated = false
      for (const file of pending) {
        if (options.maxRecords != null && delivered >= options.maxRecords) {
          truncated = true
          break
        }
        if (deadline != null && delivered > 0 && now() >= deadline) {
          truncated = true
          break
        }
        const record = await readRecordFile(join(dataRoot, 'records', file.name))
        if (!isAbsolute(record.workspace.root)) throw new Error(`record workspace root is not absolute: ${record.recordId}`)
        if (!await invokeCommitHook(hook, commitNotification(record), env)) {
          await appendRotatingLog(
            join(dataRoot, 'logs', 'recorder.log'),
            `${new Date().toISOString()} ERROR commit notification: commit hook did not ACK sequence ${record.sequence}`
          ).catch(() => undefined)
          return { delivered, pending: pending.length - delivered, truncated: false }
        }
        await writeJsonAtomic(statePath, {
          schemaVersion: 1,
          hookFingerprint,
          ackedThrough: record.sequence
        } satisfies CommitHookState)
        delivered++
      }
      return { delivered, pending: pending.length - delivered, truncated }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    const state = await readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
    const fingerprint = configuredCommitHookFingerprint(env)
    const ackedThrough = state?.schemaVersion === 1 && state.hookFingerprint === fingerprint ? state.ackedThrough : 0
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > ackedThrough).length, truncated: false }
  }
}

export async function redeliverLatestCommitNotification(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ delivered: boolean; recordId?: string; sequence?: number; reason?: string }> {
  let hook: string | null
  try {
    hook = await configuredCommitHook(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR latest commit redelivery: ${message}`).catch(() => undefined)
    return { delivered: false, reason: message }
  }
  if (!hook) return { delivered: false, reason: 'commit hook is not configured' }

  try {
    return await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
      const latest = (await recordFiles(dataRoot)).at(-1)
      if (!latest) return { delivered: false, reason: 'no committed record' }
      const record = await readRecordFile(join(dataRoot, 'records', latest.name))
      if (!isAbsolute(record.workspace.root)) throw new Error(`record workspace root is not absolute: ${record.recordId}`)
      const delivered = await invokeCommitHook(hook, commitNotification(record), env)
      if (!delivered) {
        await appendRotatingLog(
          join(dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ERROR latest commit redelivery: commit hook did not ACK sequence ${record.sequence}`
        ).catch(() => undefined)
      }
      return {
        delivered,
        recordId: record.recordId,
        sequence: record.sequence,
        ...(!delivered ? { reason: 'commit hook did not ACK' } : {})
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR latest commit redelivery: ${message}`).catch(() => undefined)
    return { delivered: false, reason: message }
  }
}

export async function exportRecords(
  dataRoot: string,
  options: { after?: number; limit?: number; snapshotMaxSequence?: number } = {}
): Promise<ExportPage> {
  const after = Math.max(0, Math.floor(options.after ?? 0))
  const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 100)))
  const files = await recordFiles(dataRoot)
  const currentMax = files.at(-1)?.sequence ?? 0
  const snapshotMaxSequence = Math.min(options.snapshotMaxSequence ?? currentMax, currentMax)
  const selected = files.filter((file) => file.sequence > after && file.sequence <= snapshotMaxSequence).slice(0, limit)
  const records: AgentTurnRecord[] = []
  for (const file of selected) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  const nextCursor = records.at(-1)?.sequence ?? after
  return {
    records,
    nextCursor,
    hasMore: files.some((file) => file.sequence > nextCursor && file.sequence <= snapshotMaxSequence),
    snapshotMaxSequence
  }
}

export interface RecordExportBundle {
  target: string
  records: number
  contents: number
  snapshotMaxSequence: number
}

export async function exportRecordBundle(dataRoot: string, target: string): Promise<RecordExportBundle> {
  const canonicalRoot = resolve(dataRoot)
  const canonicalTarget = resolve(target)
  if (archivePathsOverlap(canonicalRoot, canonicalTarget)) {
    throw new Error('export target must not overlap the recorder store')
  }
  const files = await recordFiles(dataRoot)
  const snapshotMaxSequence = files.at(-1)?.sequence ?? 0
  const parent = resolve(canonicalTarget, '..')
  await mkdir(parent, { recursive: true })
  const temp = await mkdtemp(join(parent, '.scry-export-'))
  try {
    const recordsDir = join(temp, 'records')
    await mkdirDurable(recordsDir)
    const refs = new Map<string, ToolContentRef>()
    for (const file of files) {
      const record = await readRecordFile(join(dataRoot, 'records', file.name))
      await writeJsonAtomic(join(recordsDir, file.name), record)
      addContentRefs(refs, record)
    }
    for (const ref of refs.values()) await copyRecorderContent(dataRoot, temp, ref)
    await writeJsonAtomic(join(temp, 'manifest.json'), {
      schemaVersion: 1,
      kind: 'scry-recorder-export',
      createdAt: new Date().toISOString(),
      snapshotMaxSequence,
      records: files.map((file) => ({ name: file.name, sequence: file.sequence, recordId: file.recordId })),
      contents: [...refs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
    })
    await syncDirectory(temp)
    await rename(temp, canonicalTarget)
    await syncDirectory(parent)
    return { target: canonicalTarget, records: files.length, contents: refs.size, snapshotMaxSequence }
  } catch (error) {
    await rm(temp, { recursive: true, force: true })
    throw error
  }
}

export async function listRecords(dataRoot: string): Promise<AgentTurnRecord[]> {
  const files = await recordFiles(dataRoot)
  const records: AgentTurnRecord[] = []
  for (const file of files) records.push(await readRecordFile(join(dataRoot, 'records', file.name)))
  return records
}

export async function showRecord(dataRoot: string, selector: string): Promise<AgentTurnRecord | null> {
  const files = await recordFiles(dataRoot)
  const sequence = /^\d+$/.test(selector) ? Number(selector) : undefined
  const match = files.find((file) => file.recordId === selector || file.sequence === sequence)
  return match ? await readRecordFile(join(dataRoot, 'records', match.name)) : null
}

export interface ArchiveState {
  schemaVersion: 1
  /** Highest sequence intentionally moved out of `records/`. */
  archivedThrough: number
}

interface ArchiveJournalRecord {
  name: string
  sequence: number
  recordId: string
  bytes: number
  sha256: string
}

interface ArchiveJournal {
  schemaVersion: 1
  operation: 'archive'
  transactionId: string
  createdAt: string
  target: string
  throughSequence: number
  archivedThroughBefore: number
  records: ArchiveJournalRecord[]
  /** Optional only for journals created before Recorder content artifacts existed. */
  contents?: ToolContentRef[]
}

const ARCHIVE_STATE = 'archive-state.json'
const ARCHIVE_JOURNAL = 'archive-journal.json'

export async function readArchiveState(dataRoot: string): Promise<ArchiveState | null> {
  const path = join(dataRoot, ARCHIVE_STATE)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`invalid archive state: ${path}`)
  }
  const state = raw as Partial<ArchiveState> | null
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.archivedThrough) || Number(state.archivedThrough) < 0) {
    throw new Error(`invalid archive state: ${path}`)
  }
  return { schemaVersion: 1, archivedThrough: Number(state.archivedThrough) }
}

function pathContains(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
}

function archivePathsOverlap(liveRecords: string, recordsTarget: string): boolean {
  return pathContains(liveRecords, recordsTarget) || pathContains(recordsTarget, liveRecords)
}

function validArchiveJournal(value: unknown): value is ArchiveJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.schemaVersion !== 1 || raw.operation !== 'archive' || typeof raw.transactionId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.transactionId)) return false
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt)) || typeof raw.target !== 'string' || !isAbsolute(raw.target)) return false
  if (!Number.isSafeInteger(raw.throughSequence) || !Number.isSafeInteger(raw.archivedThroughBefore) || !Array.isArray(raw.records)) return false
  if (raw.contents !== undefined && (!Array.isArray(raw.contents) || !raw.contents.every(isToolContentRef) || new Set(raw.contents.map((item) => item.sha256)).size !== raw.contents.length)) return false
  let previous = Number(raw.archivedThroughBefore)
  for (const item of raw.records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    const parsed = typeof record.name === 'string' ? parseRecordName(record.name) : null
    if (!parsed || parsed.sequence !== record.sequence || parsed.recordId !== record.recordId || parsed.sequence !== previous + 1) return false
    if (!Number.isSafeInteger(record.bytes) || Number(record.bytes) < 0 || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return false
    previous = parsed.sequence
  }
  return raw.records.length > 0 && Number(raw.throughSequence) >= previous
}

async function archiveJournal(dataRoot: string): Promise<ArchiveJournal | null> {
  const path = join(dataRoot, ARCHIVE_JOURNAL)
  let journal: unknown
  try {
    journal = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`invalid archive journal: ${path}`)
  }
  if (!validArchiveJournal(journal)) throw new Error(`invalid archive journal: ${path}`)
  return journal
}

async function existingFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function existingPath(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export interface RecordContentItem {
  path: string
  ref: ToolContentRef
}

export function recordContentItems(record: AgentTurnRecord): RecordContentItem[] {
  const items: RecordContentItem[] = []
  for (const section of ['tools', 'skills', 'mcps'] as const) {
    for (const [index, call] of (record[section].value ?? []).entries()) {
      if (call.inputContent?.contentRef) items.push({ path: `${section}.${index}.input`, ref: call.inputContent.contentRef })
      if (call.outputContent?.contentRef) items.push({ path: `${section}.${index}.output`, ref: call.outputContent.contentRef })
    }
  }
  for (const [segmentIndex, segment] of (record.modelSegments?.value ?? []).entries()) {
    for (const [refIndex, ref] of (segment.contentRefs ?? []).entries()) {
      items.push({ path: `modelSegments.${segmentIndex}.${refIndex}`, ref })
    }
  }
  for (const [refIndex, ref] of (record.assistant.value?.contentRefs ?? []).entries()) {
    items.push({ path: `assistant.${refIndex}`, ref })
  }
  for (const [snapshotIndex, snapshot] of (record.diff.value ?? []).entries()) {
    for (const [fileIndex, file] of snapshot.files.entries()) {
      if (file.patchContent?.contentRef) items.push({ path: `diff.${snapshotIndex}.${fileIndex}.patch`, ref: file.patchContent.contentRef })
    }
  }
  if (record.transcript?.value?.contentRef) items.push({ path: 'transcript', ref: record.transcript.value.contentRef })
  return items
}

export function recordContentItem(record: AgentTurnRecord, path: string): RecordContentItem | undefined {
  return recordContentItems(record).find((item) => item.path === path)
}

function addContentRefs(refs: Map<string, ToolContentRef>, record: AgentTurnRecord): void {
  for (const { ref } of recordContentItems(record)) {
    const existing = refs.get(ref.sha256)
    if (existing && existing.bytes !== ref.bytes) throw new Error(`conflicting recorder content reference: ${ref.sha256}`)
    refs.set(ref.sha256, existing ?? ref)
  }
}

function collectContentRefs(records: AgentTurnRecord[]): ToolContentRef[] {
  const refs = new Map<string, ToolContentRef>()
  for (const record of records) addContentRefs(refs, record)
  return [...refs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256))
}

async function verifiedArchiveContent(path: string, expected: ArchiveJournalRecord): Promise<Buffer> {
  const content = await readFile(path)
  const digest = createHash('sha256').update(content).digest('hex')
  if (content.byteLength !== expected.bytes || digest !== expected.sha256) {
    throw new Error(`archive record does not match journal: ${path}`)
  }
  return content
}

export interface ArchiveOptions {
  throughSequence: number
  target: string
  /** Deterministic crash seam used only by recorder durability tests. */
  onStep?: (phase: 'target-published' | 'copied' | 'source-removed', sequence: number) => Promise<void> | void
  /** Deterministic fsync fault seam used only by durability tests. */
  syncDirectory?: (path: string) => Promise<void>
}

/**
 * Move a contiguous prefix through a durable journal. A retry with the same target resumes any
 * verified copy/remove/floor step; a pending journal blocks sequence allocation until reconciled.
 */
export async function archiveRecords(
  dataRoot: string,
  options: ArchiveOptions
): Promise<{ archived: ArchiveJournalRecord[]; archivedThrough: number; target: string }> {
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    const liveRecords = join(dataRoot, 'records')
    const recordsTarget = join(options.target, 'records')
    const sync = options.syncDirectory ?? syncDirectory
    if (archivePathsOverlap(resolve(liveRecords), resolve(recordsTarget))) {
      throw new Error('archive target must not overlap the live records directory')
    }
    await mkdirDurable(recordsTarget)
    if ((await lstat(recordsTarget)).isSymbolicLink()) throw new Error('archive records target must not be a symbolic link')
    const [canonicalLive, canonicalRecordsTarget, canonicalTarget] = await Promise.all([
      realpath(liveRecords), realpath(recordsTarget), realpath(options.target)
    ])
    if (archivePathsOverlap(canonicalLive, canonicalRecordsTarget)) {
      throw new Error('archive target must not overlap the live records directory')
    }

    let journal = await archiveJournal(dataRoot)
    if (journal) {
      if (journal.target !== canonicalTarget) throw new Error(`pending archive must be resumed with target ${journal.target}`)
    } else {
      const state = await readArchiveState(dataRoot)
      const floor = state?.archivedThrough ?? 0
      const liveFiles = await recordFiles(dataRoot, { bypassIndex: true })
      let expectedSequence = floor + 1
      for (const file of liveFiles) {
        if (file.sequence !== expectedSequence) throw new Error(`cannot archive a store with a sequence gap before ${file.name}`)
        expectedSequence += 1
      }
      const files = liveFiles.filter((file) => file.sequence <= options.throughSequence)
      if (files.length === 0) return { archived: [], archivedThrough: floor, target: options.target }
      if (
        (await listFiles(canonicalRecordsTarget)).length > 0 ||
        await existingFile(join(canonicalTarget, 'manifest.json')) ||
        await existingPath(join(canonicalTarget, 'content'))
      ) {
        throw Object.assign(new Error('archive target must be empty'), { code: 'EEXIST' })
      }
      const records: ArchiveJournalRecord[] = []
      const sourceRecords: AgentTurnRecord[] = []
      for (const file of files) {
        const source = join(canonicalLive, file.name)
        sourceRecords.push(await readRecordFile(source))
        const content = await readFile(source)
        records.push({
          ...file,
          bytes: content.byteLength,
          sha256: createHash('sha256').update(content).digest('hex')
        })
      }
      const contents = collectContentRefs(sourceRecords)
      // Fail before publishing a journal when a referenced source was already missing/corrupt.
      for (const ref of contents) await readRecorderContent(dataRoot, ref)
      journal = {
        schemaVersion: 1,
        operation: 'archive',
        transactionId: randomUUID(),
        createdAt: new Date().toISOString(),
        target: canonicalTarget,
        throughSequence: options.throughSequence,
        archivedThroughBefore: floor,
        records,
        contents
      }
      await writeJsonAtomic(join(dataRoot, ARCHIVE_JOURNAL), journal)
    }

    if (!journal.contents) {
      // Upgrade an interrupted pre-content journal from whichever verified record copy survived.
      const sourceRecords: AgentTurnRecord[] = []
      for (const record of journal.records) {
        const livePath = join(canonicalLive, record.name)
        const targetPath = join(canonicalRecordsTarget, record.name)
        sourceRecords.push(await readRecordFile(await existingFile(livePath) ? livePath : targetPath))
      }
      journal = { ...journal, contents: collectContentRefs(sourceRecords) }
      await writeJsonAtomic(join(dataRoot, ARCHIVE_JOURNAL), journal)
    }
    const contents = journal.contents ?? []
    const contentTarget = join(canonicalTarget, 'content')
    if (await existingPath(contentTarget) && (await lstat(contentTarget)).isSymbolicLink()) {
      throw new Error('archive content target must not be a symbolic link')
    }
    for (const ref of contents) await copyRecorderContent(dataRoot, canonicalTarget, ref)

    const expectedNames = new Set(journal.records.flatMap((record) => [
      record.name,
      basename(exclusiveWriteTempPath(join(canonicalRecordsTarget, record.name), journal.transactionId))
    ]))
    for (const name of await listFiles(canonicalRecordsTarget)) {
      if (!expectedNames.has(name)) throw new Error(`archive target contains a file outside the pending journal: ${name}`)
    }

    let archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
    if (archivedThrough < journal.archivedThroughBefore || archivedThrough > journal.records.at(-1)!.sequence) {
      throw new Error('archive floor is inconsistent with pending journal')
    }
    for (const record of journal.records) {
      const source = join(canonicalLive, record.name)
      const target = join(canonicalRecordsTarget, record.name)
      const temporary = exclusiveWriteTempPath(target, journal.transactionId)
      const sourceExists = await existingFile(source)
      let targetExists = await existingFile(target)
      const temporaryExists = await existingFile(temporary)
      // A pending journal owns both copies, but neither may be silently discarded if its content
      // differs from the bytes hashed before the archive began.
      const sourceContent = sourceExists ? await verifiedArchiveContent(source, record) : undefined
      if (targetExists) await verifiedArchiveContent(target, record)
      if (temporaryExists) await verifiedArchiveContent(temporary, record)
      if (!targetExists) {
        if (temporaryExists) {
          await link(temporary, target)
          await sync(canonicalRecordsTarget)
          targetExists = true
          await options.onStep?.('target-published', record.sequence)
        } else {
          if (!sourceContent) throw new Error(`archive source and target are both missing: ${record.name}`)
          await writeFileAtomicExclusive(target, sourceContent, {
            temporaryId: journal.transactionId,
            onPublished: () => options.onStep?.('target-published', record.sequence),
            syncDirectory: sync
          })
          targetExists = true
        }
      }
      if (temporaryExists && targetExists) {
        await rm(temporary)
        await sync(canonicalRecordsTarget)
      }
      // This barrier is deliberately unconditional: an existing target may come from a prior
      // attempt whose link publication succeeded but directory fsync failed.
      await sync(canonicalRecordsTarget)
      await options.onStep?.('copied', record.sequence)
      if (sourceExists) {
        await rm(source)
        await sync(canonicalLive)
      }
      await options.onStep?.('source-removed', record.sequence)
      if (archivedThrough < record.sequence) {
        archivedThrough = record.sequence
        await writeJsonAtomic(join(dataRoot, ARCHIVE_STATE), { schemaVersion: 1, archivedThrough } satisfies ArchiveState)
      }
    }

    await writeJsonAtomic(join(canonicalTarget, 'manifest.json'), {
      schemaVersion: 1,
      transactionId: journal.transactionId,
      at: new Date().toISOString(),
      recorderVersion: RECORDER_VERSION,
      from: journal.records[0].sequence,
      to: archivedThrough,
      count: journal.records.length,
      records: journal.records,
      contents
    })
    await rm(join(dataRoot, ARCHIVE_JOURNAL))
    await sync(dataRoot)
    invalidateRecordIndex(dataRoot)
    return { archived: journal.records, archivedThrough, target: options.target }
  })
}

/**
 * Which CLI actually wrote the newest record. A workspace can easily end up with more than one
 * install — a hook pinned through `SCRY_CLI_PATH` and whatever `scry` resolves to in a shell —
 * and then upgrading one of them silently leaves recording on the other. Reads one file.
 */
export async function lastRecordVersion(dataRoot: string): Promise<string | null> {
  const files = await recordFiles(dataRoot)
  const newest = files.at(-1)
  if (!newest) return null
  try {
    return (await readRecordFile(join(dataRoot, 'records', newest.name))).recorderVersion
  } catch {
    return null
  }
}

export async function verifyStore(dataRoot: string): Promise<{ ok: boolean; records: number; errors: string[]; archivedThrough: number }> {
  // Integrity verification always bypasses disposable projections and scans canonical filenames.
  const files = await recordFiles(dataRoot, { bypassIndex: true })
  const errors: string[] = []
  // An archived prefix is only acceptable when an archive operation recorded the floor.
  let archivedThrough = 0
  try {
    archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  try {
    const journal = await archiveJournal(dataRoot)
    if (journal) errors.push(`pending archive journal: ${journal.transactionId}`)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  let previous = archivedThrough
  const ids = new Set<string>()
  for (const file of files) {
    if (file.sequence <= previous) errors.push(`non-monotonic sequence: ${file.name}`)
    if (file.sequence !== previous + 1) errors.push(`sequence gap before: ${file.name}`)
    previous = file.sequence
    if (ids.has(file.recordId)) errors.push(`duplicate recordId: ${file.recordId}`)
    ids.add(file.recordId)
    try {
      await readRecordFile(join(dataRoot, 'records', file.name))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: errors.length === 0, records: files.length, errors, archivedThrough }
}

const EMPTY_HEALTH: RecorderHealth = {
  schemaVersion: 1,
  droppedEvents: 0,
  orphanEvents: 0,
  pendingCount: 0,
  oldestPendingAgeMs: 0,
  recoveredRecords: 0
}

export async function readHealth(dataRoot: string): Promise<RecorderHealth> {
  return await readJson<RecorderHealth>(join(dataRoot, 'health.json')) ?? { ...EMPTY_HEALTH }
}

export async function updateHealth(
  dataRoot: string,
  update: Partial<Omit<RecorderHealth, 'schemaVersion'>> & {
    increment?: Partial<Pick<RecorderHealth, 'droppedEvents' | 'orphanEvents' | 'recoveredRecords'>>
  }
): Promise<RecorderHealth> {
  return withDirectoryLock(join(dataRoot, 'locks', 'health.lock'), async () => {
    const current = await readHealth(dataRoot)
    const next: RecorderHealth = {
      ...current,
      ...update,
      schemaVersion: 1,
      droppedEvents: current.droppedEvents + (update.increment?.droppedEvents ?? 0),
      orphanEvents: current.orphanEvents + (update.increment?.orphanEvents ?? 0),
      recoveredRecords: current.recoveredRecords + (update.increment?.recoveredRecords ?? 0)
    }
    delete (next as RecorderHealth & { increment?: unknown }).increment
    await writeJsonAtomic(join(dataRoot, 'health.json'), next)
    return next
  })
}

export async function recordError(dataRoot: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  const at = new Date().toISOString()
  await updateHealth(dataRoot, { lastError: { at, message }, increment: { droppedEvents: 1 } }).catch(() => undefined)
  await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${at} ERROR ${message}`).catch(() => undefined)
}

export async function clearRuntimeTurn(dataRoot: string, path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
  await mkdir(join(dataRoot, 'runtime'), { recursive: true, mode: 0o700 })
}
