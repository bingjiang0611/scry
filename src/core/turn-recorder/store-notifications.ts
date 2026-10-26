import { recordUploadEnvironment } from './commit-environment.js'
import { createHash } from 'node:crypto'
import { type CommitHookResult, configuredCommitHook, configuredCommitHookFingerprint, invokeCommitHook } from './commit-hook-process.js'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, withDirectoryLock, writeJsonAtomic } from './io.js'
import { recordFiles, parseRecordFile } from './store-index.js'
import { COMMIT_NOTIFICATION_MAX_FAILURES, type CommitHookState, type CommitNotificationFailure, commitHookStatePath, readCommitHookAck, pendingCommitFiles, publishDeadLetter, readDeadLetter, readDeadLetters } from './commit-delivery-state.js'

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

export interface CommitNotificationStatus {
  ackedThrough: number | null
  notifyBacklog: number
  processedThrough?: number
  failure?: CommitNotificationFailure
  deadLetterCount?: number
  /** Latest twenty diagnostics; deadLetterCount can be larger. */
  deadLetters?: CommitNotificationFailure[]
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
  const state = await readCommitHookAck(dataRoot, fingerprint)
  const [pending, dead] = await Promise.all([pendingCommitFiles(dataRoot, state), readDeadLetters(dataRoot, fingerprint)])
  if (state.processedThrough > (state.ackedThrough ?? 0) && dead.deadLetterCount === 0) {
    throw new Error('commit notification state is missing dead-letter evidence')
  }
  return {
    ackedThrough: state.ackedThrough,
    notifyBacklog: pending.length,
    ...(state.failure ? { failure: state.failure } : {}),
    ...(dead.deadLetterCount ? { processedThrough: state.processedThrough, ...dead } : {})
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
  const fingerprint = configuredCommitHookFingerprint(env)
  const pendingCount = async () => (await pendingCommitFiles(dataRoot, await readCommitHookAck(dataRoot, fingerprint))).length
  try {
    hook = await configuredCommitHook(env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    return { delivered: 0, pending: await pendingCount(), truncated: false }
  }
  if (!hook) return { delivered: 0, pending: 0, truncated: false }
  try {
    return await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
      const checkpoint = await readCommitHookAck(dataRoot, fingerprint)
      const statePath = commitHookStatePath(dataRoot, fingerprint)
      const state: CommitHookState = {
        schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: checkpoint.ackedThrough ?? 0,
        processedThrough: checkpoint.processedThrough, failure: checkpoint.failure
      }
      if (checkpoint.ackedThrough !== null && checkpoint.ackedThrough !== checkpoint.isolatedAck) {
        // Persist even with no backlog, before another identity replaces the legacy file.
        await writeJsonAtomic(statePath, state)
      }
      const pending = await pendingCommitFiles(dataRoot, checkpoint)
      const now = options.now ?? Date.now
      const deadline = options.budgetMs != null ? now() + options.budgetMs : null
      let delivered = 0
      let processed = 0
      let truncated = false
      for (const file of pending) {
        if ((options.maxRecords != null && processed >= options.maxRecords) ||
          (deadline != null && processed > 0 && now() >= deadline)) {
          truncated = true
          break
        }
        if (state.failure && (state.failure.sequence !== file.sequence || state.failure.recordId !== file.recordId)) {
          throw new Error('commit notification state does not match pending head')
        }
        // A durable fifth failure is sufficient to finish quarantine after a crash.
        // Never invoke this poison record a sixth time merely because cursor publication failed.
        if (!state.failure || state.failure.attempts < COMMIT_NOTIFICATION_MAX_FAILURES) {
          const result = await attemptCommitNotification(hook, dataRoot, file.name, env)
          if (!result.acknowledged) {
            // Classify failure without retaining callback stderr, argv, paths or error messages.
            const { acknowledged: _acknowledged, ...diagnostic } = result
            state.failure = {
              sequence: file.sequence, recordId: file.recordId,
              attempts: (state.failure?.attempts ?? 0) + 1,
              lastFailureAt: new Date().toISOString(), ...diagnostic
            }
            // Persist the attempt before the dead letter, and the dead letter before progress.
            await writeJsonAtomic(statePath, state)
            await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
              `${state.failure.lastFailureAt} ERROR commit notification: sequence ${file.sequence}; diagnostic=${JSON.stringify({ acknowledged: false, ...state.failure, recorderPid: process.pid })}`
            ).catch(() => undefined)
            if (state.failure.attempts < COMMIT_NOTIFICATION_MAX_FAILURES) {
              return { delivered, pending: pending.length - processed, truncated: false }
            }
          } else {
            // A later success cannot turn a dead predecessor into an ACK.
            if (state.ackedThrough === state.processedThrough) state.ackedThrough = file.sequence
            state.processedThrough = file.sequence
            delete state.failure
            await writeJsonAtomic(statePath, state)
            delivered++
            processed++
            continue
          }
        }
        await publishDeadLetter(dataRoot, fingerprint, state.failure)
        state.processedThrough = file.sequence
        delete state.failure
        await writeJsonAtomic(statePath, state)
        processed++
      }
      return { delivered, pending: pending.length - processed, truncated }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    return { delivered: 0, pending: await pendingCount(), truncated: false }
  }
}

async function attemptCommitNotification(
  hook: string, dataRoot: string, filename: string, env: NodeJS.ProcessEnv
): Promise<CommitHookResult | { acknowledged: false; reason: 'record_unavailable' | 'environment_unavailable' }> {
  let notification: RecordCommittedNotification
  try { notification = await commitNotification(dataRoot, filename) } catch {
    return { acknowledged: false, reason: 'record_unavailable' }
  }
  let deliveryEnv: NodeJS.ProcessEnv
  try { deliveryEnv = await recordUploadEnvironment(dataRoot, notification.recordId, env) } catch {
    return { acknowledged: false, reason: 'environment_unavailable' }
  }
  try { return await invokeCommitHook(hook, notification, deliveryEnv) } catch (error) {
    return { acknowledged: false, reason: 'spawn_error', errorCode: (error as NodeJS.ErrnoException).code }
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
      const fingerprint = configuredCommitHookFingerprint(env)
      const checkpoint = await readCommitHookAck(dataRoot, fingerprint)
      const exhausted = checkpoint.failure?.sequence === latest.sequence &&
        checkpoint.failure.attempts === COMMIT_NOTIFICATION_MAX_FAILURES
      if (exhausted || await readDeadLetter(dataRoot, fingerprint, latest.name)) {
        return { delivered: false, recordId: latest.recordId, sequence: latest.sequence,
          reason: 'recorder dead letter; automatic redelivery disabled' }
      }
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
