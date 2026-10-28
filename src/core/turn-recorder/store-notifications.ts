import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, readJson, withDirectoryLock, writeJsonAtomic } from './io.js'
import { recordFiles, readRecordFile } from './store-shared.js'

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

/** Hook-path drain budget. The budget is checked between invocations. */
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
