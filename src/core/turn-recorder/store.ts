import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { isAgentTurnRecord, type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, listFiles, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'

export const RECORDER_VERSION = '0.2.17'

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
    const sequence = (files.at(-1)?.sequence ?? 0) + 1
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

export async function drainCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ delivered: number; pending: number }> {
  let hook: string | null
  try {
    hook = await configuredCommitHook(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    const state = await readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
    const fingerprint = configuredCommitHookFingerprint(env)
    const ackedThrough = state?.schemaVersion === 1 && state.hookFingerprint === fingerprint ? state.ackedThrough : 0
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > ackedThrough).length }
  }
  if (!hook) return { delivered: 0, pending: 0 }
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
      let delivered = 0
      for (const file of pending) {
        const record = await readRecordFile(join(dataRoot, 'records', file.name))
        if (!isAbsolute(record.workspace.root)) throw new Error(`record workspace root is not absolute: ${record.recordId}`)
        if (!await invokeCommitHook(hook, commitNotification(record), env)) {
          await appendRotatingLog(
            join(dataRoot, 'logs', 'recorder.log'),
            `${new Date().toISOString()} ERROR commit notification: commit hook did not ACK sequence ${record.sequence}`
          ).catch(() => undefined)
          return { delivered, pending: pending.length - delivered }
        }
        await writeJsonAtomic(statePath, {
          schemaVersion: 1,
          hookFingerprint,
          ackedThrough: record.sequence
        } satisfies CommitHookState)
        delivered++
      }
      return { delivered, pending: pending.length - delivered }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    const state = await readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
    const fingerprint = configuredCommitHookFingerprint(env)
    const ackedThrough = state?.schemaVersion === 1 && state.hookFingerprint === fingerprint ? state.ackedThrough : 0
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > ackedThrough).length }
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
  const records = await listRecords(dataRoot)
  const sequence = Number(selector)
  return records.find((record) => record.recordId === selector || (Number.isSafeInteger(sequence) && record.sequence === sequence)) ?? null
}

export async function verifyStore(dataRoot: string): Promise<{ ok: boolean; records: number; errors: string[] }> {
  const files = await recordFiles(dataRoot)
  const errors: string[] = []
  let previous = 0
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
  return { ok: errors.length === 0, records: files.length, errors }
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
