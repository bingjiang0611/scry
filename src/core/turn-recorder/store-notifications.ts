import { recordUploadEnvironment, UPLOAD_ENV_KEYS } from './commit-environment.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { readJson, appendRotatingLog, withDirectoryLock, writeJsonAtomic } from './io.js'
import { stableHash, recordFiles, parseRecordFile } from './store-index.js'

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
  ...UPLOAD_ENV_KEYS,
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
] as const

export interface RecordCommittedNotification {
  schemaVersion: 2
  recordPath: string
  sha256: string
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

async function commitNotification(dataRoot: string, filename: string): Promise<RecordCommittedNotification> {
  const recordPath = `records/${filename}`
  const path = join(dataRoot, recordPath)
  const bytes = await readFile(path)
  const record = parseRecordFile(path, bytes.toString('utf8'))
  if (!isAbsolute(record.workspace.root)) throw new Error(`record workspace root is not absolute: ${record.recordId}`)
  // Hash the canonical bytes, not the normalized legacy read view or re-serialized JSON.
  return {
    schemaVersion: 2,
    recordPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
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

type CommitHookResult =
  | { acknowledged: true }
  | {
    acknowledged: false
    reason: 'spawn_error' | 'timeout' | 'stdin_error' | 'signal' | 'exit'
    exitCode?: number | null
    signal?: NodeJS.Signals | null
    errorCode?: string
  }

async function invokeCommitHook(
  path: string,
  notification: RecordCommittedNotification,
  env: NodeJS.ProcessEnv
): Promise<CommitHookResult> {
  return new Promise((resolvePromise) => {
    const childEnv: NodeJS.ProcessEnv = {}
    for (const key of COMMIT_HOOK_ENV_KEYS) if (env[key] !== undefined) childEnv[key] = env[key]
    const child = spawn(path, [], { env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] })
    let settled = false
    let timedOut = false
    let inputFailed = false
    let inputErrorCode: string | undefined
    let terminationRequested = false
    let killTimer: NodeJS.Timeout | undefined
    const settle = (result: CommitHookResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolvePromise(result)
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
    child.once('error', (error: NodeJS.ErrnoException) => settle({
      acknowledged: false, reason: 'spawn_error', errorCode: error.code
    }))
    child.once('exit', (code, signal) => {
      if (!timedOut && !inputFailed && code === 0) {
        settle({ acknowledged: true })
      } else {
        settle({
          acknowledged: false,
          reason: timedOut ? 'timeout' : inputFailed ? 'stdin_error' : signal ? 'signal' : 'exit',
          exitCode: code,
          signal,
          ...(inputFailed ? { errorCode: inputErrorCode } : {})
        })
      }
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      inputFailed = true
      inputErrorCode = error.code
      terminate()
    })
    child.stdin.end(`${JSON.stringify(notification)}\n`)
  })
}

function commitHookStatePath(dataRoot: string, fingerprint: string): string {
  return join(dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
}

async function readCommitHookAck(dataRoot: string, fingerprint: string): Promise<{
  ackedThrough: number | null
  isolatedAck: number | null
}> {
  // Keep v1 read-only: an old App can still own it while a new CLI writes its own
  // checkpoint. Only the exact same identity may contribute a prior ACK.
  const [isolated, legacy] = await Promise.all([
    readJson<CommitHookState>(commitHookStatePath(dataRoot, fingerprint)),
    readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
  ])
  const validAck = (state: CommitHookState | null): number | null =>
    state?.schemaVersion === 1 && state.hookFingerprint === fingerprint &&
      Number.isSafeInteger(state.ackedThrough) && state.ackedThrough >= 0
      ? state.ackedThrough : null
  const isolatedAck = validAck(isolated)
  const legacyAck = validAck(legacy)
  const ackedThrough = isolatedAck === null ? legacyAck : Math.max(isolatedAck, legacyAck ?? 0)
  return { ackedThrough, isolatedAck }
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
  const { ackedThrough: acked } = await readCommitHookAck(dataRoot, configuredCommitHookFingerprint(env))
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
    const { ackedThrough } = await readCommitHookAck(dataRoot, configuredCommitHookFingerprint(env))
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > (ackedThrough ?? 0)).length, truncated: false }
  }
  if (!hook) return { delivered: 0, pending: 0, truncated: false }
  try {
    return await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
      const hookFingerprint = configuredCommitHookFingerprint(env)
      const statePath = commitHookStatePath(dataRoot, hookFingerprint)
      const { ackedThrough, isolatedAck } = await readCommitHookAck(dataRoot, hookFingerprint)
      if (ackedThrough !== null && ackedThrough !== isolatedAck) {
        // Persist even with no backlog, before another identity replaces the legacy file.
        await writeJsonAtomic(statePath, { schemaVersion: 1, hookFingerprint, ackedThrough } satisfies CommitHookState)
      }
      const pending = (await recordFiles(dataRoot)).filter((file) => file.sequence > (ackedThrough ?? 0))
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
        const record = await commitNotification(dataRoot, file.name)
        const result = await invokeCommitHook(hook, record, await recordUploadEnvironment(dataRoot, record.recordId, env))
        if (!result.acknowledged) {
          // Classify failure without retaining callback stderr, argv, paths or error messages.
          await appendRotatingLog(
            join(dataRoot, 'logs', 'recorder.log'),
            `${new Date().toISOString()} ERROR commit notification: commit hook did not ACK sequence ${record.sequence}; diagnostic=${JSON.stringify({ ...result, recorderPid: process.pid })}`
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
    const { ackedThrough } = await readCommitHookAck(dataRoot, configuredCommitHookFingerprint(env))
    return { delivered: 0, pending: (await recordFiles(dataRoot)).filter((file) => file.sequence > (ackedThrough ?? 0)).length, truncated: false }
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
      const record = await commitNotification(dataRoot, latest.name)
      const result = await invokeCommitHook(hook, record, await recordUploadEnvironment(dataRoot, record.recordId, env))
      const delivered = result.acknowledged
      if (!delivered) {
        await appendRotatingLog(
          join(dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ERROR latest commit redelivery: commit hook did not ACK sequence ${record.sequence}; diagnostic=${JSON.stringify({ ...result, recorderPid: process.pid })}`
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
