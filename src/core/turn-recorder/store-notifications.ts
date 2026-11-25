import { recordUploadEnvironment } from './commit-environment.js'
import { createHash } from 'node:crypto'
import { type CommitHookResult, configuredCommitHook, configuredCommitHookFingerprint, invokeCommitHook } from './commit-hook-process.js'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { type AgentTurnRecord } from '../../shared/turn-record.js'
import { appendRotatingLog, withDirectoryLock } from './io.js'
import { recordFiles, parseRecordFile } from './store-index.js'
import { readArchiveState } from './store-archive.js'
import { COMMIT_NOTIFICATION_MAX_FAILURES, type CommitNotificationFailure, recordName, readCommitHookAck, pendingCommitFiles, publishDeadLetter, readDeadLetter, readDeadLetters } from './commit-delivery-state.js'

import { type RetryDiagnostic, UnresolvedDeliveryPrefixError, advanceAck, finishReplay, ledgerStatus, loadDeliveryState, loadScopedDeliveryState, nextRetryAt, outcomes, readOutcome, requeueDeadLetters, requeueLostOutcome, saveOutcome, saveProgress } from './commit-delivery-ledger.js'

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
  failure?: CommitNotificationFailure & { nextRetryAt?: string }
  retryCount?: number
  retries?: RetryDiagnostic[]
  deadLetterCount?: number
  deadLetters?: CommitNotificationFailure[]
  absentCount?: number
  absentRanges?: Array<[number, number]>
  absentTruncated?: boolean
}

export async function commitNotificationStatus(dataRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<CommitNotificationStatus> {
  const fingerprint = configuredCommitHookFingerprint(env)
  const state = await readCommitHookAck(dataRoot, fingerprint)
  const ledger = await ledgerStatus(dataRoot, fingerprint, state)
  if (state.queueVersion === 2 || ledger.outcomeCount) {
    const { outcomeCount: _count, absent, ...detail } = ledger
    const hasGap = state.processedThrough > (state.ackedThrough ?? 0) || detail.retryCount > 0 || detail.deadLetterCount > 0
    return { ackedThrough: state.ackedThrough, notifyBacklog: detail.notifyBacklog,
      ...(hasGap ? { processedThrough: state.processedThrough, ...detail } : {}),
      ...(absent ? { absentCount: absent.count, absentRanges: absent.ranges, absentTruncated: absent.truncated } : {}) }
  }
  const [pending, dead] = await Promise.all([pendingCommitFiles(dataRoot, state), readDeadLetters(dataRoot, fingerprint)])
  if (state.processedThrough > (state.ackedThrough ?? 0) && dead.deadLetterCount === 0) throw new Error('commit notification state is missing dead-letter evidence')
  return { ackedThrough: state.ackedThrough, notifyBacklog: pending.length,
    ...(state.failure ? { failure: { ...state.failure, nextRetryAt: nextRetryAt(state.failure) } } : {}),
    ...(dead.deadLetterCount ? { processedThrough: state.processedThrough, ...dead } : {}) }
}

export const HOOK_DRAIN_MAX_RECORDS = 8
export const HOOK_DRAIN_BUDGET_MS = 1_500

export interface CommitNotificationScope {
  provider: AgentTurnRecord['provider']['id']
  sessionId: string
}

export interface DrainOptions {
  maxRecords?: number
  budgetMs?: number
  now?: () => number
  scope?: CommitNotificationScope
}

export interface DrainResult {
  delivered: number
  pending: number | null
  truncated: boolean
  hookConfigured?: boolean
}

export async function drainCommitNotifications(
  dataRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  options: DrainOptions = {}
): Promise<DrainResult> {
  const fingerprint = configuredCommitHookFingerprint(env)
  const pendingCount = async () => (await commitNotificationStatus(dataRoot, env)).notifyBacklog
  let delivered = 0
  try {
    const hook = await configuredCommitHook(env)
    if (!hook) {
      const pending = await pendingCount().catch(() => null)
      return { delivered: 0, pending, truncated: false, hookConfigured: false }
    }
    return await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
      const state = options.scope
        ? await loadScopedDeliveryState(dataRoot, fingerprint)
        : await loadDeliveryState(dataRoot, fingerprint)
      let savedAck = state.ackedThrough
      let savedProgress = state.processedThrough
      const persistProgress = async () => {
        if (state.ackedThrough === savedAck && state.processedThrough === savedProgress) return
        await saveProgress(dataRoot, state)
        savedAck = state.ackedThrough
        savedProgress = state.processedThrough
      }
      const archiveFloor = (await readArchiveState(dataRoot))?.archivedThrough ?? 0
      if (!options.scope) await advanceAck(dataRoot, state, archiveFloor)
      const initialProgress = state.processedThrough ?? state.ackedThrough
      const fresh = (await recordFiles(dataRoot)).filter(file => file.sequence > initialProgress)
      const now = options.now ?? Date.now
      const deadline = options.budgetMs != null ? now() + options.budgetMs : null
      let attempted = 0
      let truncated = false
      let firstUnresolved = Number.POSITIVE_INFINITY
      let highestVisited = initialProgress
      const overBudget = () => (options.maxRecords != null && attempted >= options.maxRecords) ||
        (deadline != null && attempted > 0 && now() >= deadline)

      const processFile = async (candidate: { sequence: number; recordId: string }, freshFile: boolean): Promise<void> => {
        const file = { sequence: candidate.sequence, recordId: candidate.recordId }
        if (options.scope) {
          const notification = await commitNotification(dataRoot, recordName(file))
          if (notification.provider !== options.scope.provider || notification.sessionId !== options.scope.sessionId) return
        }
        let outcome = await readOutcome(dataRoot, fingerprint, file.sequence)
        if (outcome && outcome.recordId !== file.recordId) throw new Error('delivery outcome does not match record identity')
        if (outcome?.status === 'retry' && outcome.failure.attempts === COMMIT_NOTIFICATION_MAX_FAILURES) {
          if (!await readDeadLetter(dataRoot, fingerprint, recordName(file))) await publishDeadLetter(dataRoot, fingerprint, outcome.failure)
          outcome = { ...file, status: 'dead', failure: outcome.failure }
          await saveOutcome(dataRoot, fingerprint, outcome)
        }
        const retryAt = outcome?.status === 'retry' ? nextRetryAt(outcome.failure) : undefined
        const deferred = retryAt !== undefined && Date.now() < Date.parse(retryAt)
        if (outcome?.status !== 'delivered' && outcome?.status !== 'dead' && !deferred) {
          await finishReplay(dataRoot, fingerprint, outcome ?? { ...file, status: 'delivered' })
          const result = await attemptCommitNotification(hook, dataRoot, recordName(file), env)
          attempted++
          if (result.acknowledged) {
            delivered++
            outcome = { ...file, status: 'delivered' }
            if (options.scope || !freshFile || state.ackedThrough < (state.processedThrough ?? 0) || file.sequence >= firstUnresolved) {
              await saveOutcome(dataRoot, fingerprint, outcome)
            }
          } else {
            const { acknowledged: _ack, ...diagnostic } = result
            const failure: CommitNotificationFailure = { ...file, attempts: (outcome?.status === 'retry' ? outcome.failure.attempts : 0) + 1,
              lastFailureAt: new Date(Date.now()).toISOString(), ...diagnostic }
            outcome = { ...file, status: 'retry', failure }
            await saveOutcome(dataRoot, fingerprint, outcome)
            await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
              `${failure.lastFailureAt} ERROR commit notification: sequence ${file.sequence}; diagnostic=${JSON.stringify({ acknowledged: false, ...failure, recorderPid: process.pid })}`
            ).catch(() => undefined)
            if (failure.attempts === COMMIT_NOTIFICATION_MAX_FAILURES) {
              await publishDeadLetter(dataRoot, fingerprint, failure)
              outcome = { ...file, status: 'dead', failure }
              await saveOutcome(dataRoot, fingerprint, outcome)
            }
          }
        }
        if (outcome?.status !== 'delivered') firstUnresolved = Math.min(firstUnresolved, file.sequence)
        highestVisited = Math.max(highestVisited, file.sequence)
        if (freshFile && !options.scope) {
          if (outcome?.status === 'delivered' && state.ackedThrough === state.processedThrough && file.sequence < firstUnresolved) {
            state.ackedThrough = file.sequence
          }
          state.processedThrough = file.sequence
          await persistProgress()
        }
      }

      for await (const outcome of outcomes(dataRoot, fingerprint, state.ackedThrough)) {
        if (outcome.status === 'delivered') continue
        if (outcome.status === 'dead') {
          firstUnresolved = Math.min(firstUnresolved, outcome.sequence)
          continue
        }
        if (overBudget()) {
          truncated = true
          break
        }
        await processFile(outcome, false)
      }
      if (!truncated) for (const file of fresh) {
        if (overBudget()) {
          truncated = true
          break
        }
        await processFile(file, true)
      }
      if (!options.scope) {
        if (!truncated) state.processedThrough = Math.max(state.processedThrough ?? 0, highestVisited)
        try {
          await advanceAck(dataRoot, state, archiveFloor)
        } catch (error) {
          await persistProgress()
          throw error
        }
        await persistProgress()
      }
      return { delivered, pending: await pendingCount(), truncated }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR commit notification: ${message}`).catch(() => undefined)
    if (options.scope && !(error instanceof UnresolvedDeliveryPrefixError)) throw error
    let pending: number | null = null
    try { pending = await pendingCount() } catch {
      if (!(error instanceof UnresolvedDeliveryPrefixError)) throw error
      pending = null
    }
    return { delivered, pending, truncated: false }
  }
}

export async function retryCommitNotifications(dataRoot: string, env: NodeJS.ProcessEnv, sequence?: number): Promise<{ requeued: number } & DrainResult> {
  if (!await configuredCommitHook(env)) throw new Error('no activated commit hook')
  const fingerprint = configuredCommitHookFingerprint(env)
  const requeued = await withDirectoryLock(join(dataRoot, 'locks', 'commit-notification.lock'), async () => {
    await loadDeliveryState(dataRoot, fingerprint)
    if (sequence === undefined) return requeueDeadLetters(dataRoot, fingerprint)
    const dead = await requeueDeadLetters(dataRoot, fingerprint, sequence)
    if (dead > 0) return dead
    if (await requeueLostOutcome(dataRoot, fingerprint, sequence)) return 1
    throw new Error(`sequence ${sequence} is neither an active dead letter nor a record whose delivery outcome is missing`)
  })
  return { requeued, ...await drainCommitNotifications(dataRoot, env) }
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
      const checkpoint = await loadDeliveryState(dataRoot, fingerprint)
      const outcome = await readOutcome(dataRoot, fingerprint, latest.sequence)
      if (outcome && outcome.status !== 'delivered') {
        return { delivered: false, recordId: latest.recordId, sequence: latest.sequence,
          reason: outcome.status === 'dead' || (outcome.status === 'retry' && outcome.failure.attempts === COMMIT_NOTIFICATION_MAX_FAILURES)
            ? 'recorder dead letter; automatic redelivery disabled' : 'scheduled retry; use normal notification drain' }
      }
      const result = await attemptCommitNotification(hook, dataRoot, latest.name, env)
      const delivered = result.acknowledged
      if (!delivered) {
        if (latest.sequence > checkpoint.ackedThrough) {
          const { acknowledged: _ack, ...diagnostic } = result
          const failure: CommitNotificationFailure = { sequence: latest.sequence, recordId: latest.recordId, attempts: 1,
            lastFailureAt: new Date(Date.now()).toISOString(), ...diagnostic }
          await saveOutcome(dataRoot, fingerprint, { sequence: latest.sequence, recordId: latest.recordId, status: 'retry', failure })
        }
        await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'),
          `${new Date().toISOString()} ERROR latest commit redelivery: commit hook did not ACK sequence ${latest.sequence}; diagnostic=${JSON.stringify({ ...result, recorderPid: process.pid })}`
        ).catch(() => undefined)
      }
      return {
        delivered,
        recordId: latest.recordId,
        sequence: latest.sequence,
        ...(!delivered ? { reason: 'commit hook did not ACK' } : {})
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await appendRotatingLog(join(dataRoot, 'logs', 'recorder.log'), `${new Date().toISOString()} ERROR latest commit redelivery: ${message}`).catch(() => undefined)
    return { delivered: false, reason: message }
  }
}
