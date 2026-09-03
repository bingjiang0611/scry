import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { isAgentTurnRecord, type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

export const RECORDER_VERSION = '0.2.31'

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

async function recordFiles(dataRoot: string): Promise<Array<{ name: string; sequence: number; recordId: string }>> {
  const out = (await listFiles(join(dataRoot, 'records'))).flatMap((name) => {
    const parsed = parseRecordName(name)
    return parsed ? [{ name, ...parsed }] : []
  })
  return out.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name))
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

export async function readRecordFile(path: string): Promise<AgentTurnRecord> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!isAgentTurnRecord(raw)) throw new Error(`invalid turn record: ${path}`)
  const parsed = parseRecordName(basename(path))
  if (!parsed || parsed.sequence !== raw.sequence || parsed.recordId !== raw.recordId) {
    throw new Error(`record filename/content mismatch: ${path}`)
  }
  return raw
}

export async function commitRecord(
  dataRoot: string,
  draft: Omit<AgentTurnRecord, 'sequence'>
): Promise<{ status: 'committed' | 'duplicate'; record: AgentTurnRecord }> {
  return withDirectoryLock(join(dataRoot, 'locks', 'commit.lock'), async () => {
    const files = await recordFiles(dataRoot)
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
    const filename = `${String(sequence).padStart(20, '0')}-${record.recordId}.json`
    await writeJsonAtomic(join(dataRoot, 'records', filename), record)
    // Cache only: commit recovery always trusts record files, never this value.
    await writeJsonAtomic(join(dataRoot, 'state', 'next-sequence.json'), { nextSequence: sequence + 1, rebuiltAt: new Date().toISOString() })
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

const ARCHIVE_STATE = 'archive-state.json'

export async function readArchiveState(dataRoot: string): Promise<ArchiveState | null> {
  const state = await readJson<ArchiveState>(join(dataRoot, ARCHIVE_STATE))
  if (state?.schemaVersion !== 1 || !Number.isSafeInteger(state.archivedThrough) || state.archivedThrough < 0) return null
  return { schemaVersion: 1, archivedThrough: state.archivedThrough }
}

/**
 * Move a contiguous prefix of records out of `records/` and record the floor that explains the
 * resulting gap. Only sequences at or below `throughSequence` may be archived, so the remaining
 * store still starts exactly one past the recorded floor; anything else stays a hard error.
 * Callers own the delivery question — a record that was never ACKed must not be archived.
 */
export async function archiveRecords(
  dataRoot: string,
  options: { throughSequence: number; target: string }
): Promise<{ archived: Array<{ name: string; sequence: number; recordId: string; sha256: string }>; archivedThrough: number; target: string }> {
  const state = await readArchiveState(dataRoot)
  const floor = state?.archivedThrough ?? 0
  const files = (await recordFiles(dataRoot)).filter((file) => file.sequence <= options.throughSequence)
  const archived: Array<{ name: string; sequence: number; recordId: string; sha256: string }> = []
  if (files.length === 0) return { archived, archivedThrough: floor, target: options.target }
  const recordsTarget = join(options.target, 'records')
  await mkdir(recordsTarget, { recursive: true, mode: 0o700 })
  let archivedThrough = floor
  for (const file of files) {
    const source = join(dataRoot, 'records', file.name)
    const content = await readFile(source)
    await writeFile(join(recordsTarget, file.name), content, { mode: 0o600 })
    await rm(source, { force: true })
    archivedThrough = file.sequence
    // Persist the floor after each move so a crash mid-archive still explains the gap.
    await writeJsonAtomic(join(dataRoot, ARCHIVE_STATE), { schemaVersion: 1, archivedThrough } satisfies ArchiveState)
    archived.push({
      name: file.name,
      sequence: file.sequence,
      recordId: file.recordId,
      sha256: createHash('sha256').update(content).digest('hex')
    })
  }
  await writeJsonAtomic(join(options.target, 'manifest.json'), {
    schemaVersion: 1,
    at: new Date().toISOString(),
    recorderVersion: RECORDER_VERSION,
    from: archived[0].sequence,
    to: archivedThrough,
    count: archived.length,
    records: archived
  })
  return { archived, archivedThrough, target: options.target }
}

export async function verifyStore(dataRoot: string): Promise<{ ok: boolean; records: number; errors: string[]; archivedThrough: number }> {
  const files = await recordFiles(dataRoot)
  const errors: string[] = []
  // An archived prefix is only acceptable when an archive operation recorded the floor.
  const archivedThrough = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
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
