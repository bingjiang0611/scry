import { opendir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { syncDirectory, writeJsonAtomic } from './io.js'
import { parseRecordName, recordFiles, stableHash } from './store-index.js'
import { readArchiveState } from './store-archive.js'
import { COMMIT_NOTIFICATION_MAX_FAILURES, type CommitHookState, type CommitNotificationFailure, commitHookStatePath, deadLetterDirectory, readCommitHookAck, readDeadLetter, readNotificationObject, recordName, validFailure } from './commit-delivery-state.js'

const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000]
const DETAILS_LIMIT = 20

type Identity = { sequence: number; recordId: string }
export type DeliveryOutcome = Identity & (
  { status: 'retry'; failure: CommitNotificationFailure } |
  { status: 'dead'; failure: CommitNotificationFailure } |
  { status: 'delivered' } |
  { status: 'replay'; historyKey: string; requestedAt: string }
)

export function nextRetryAt(failure: CommitNotificationFailure): string | undefined {
  const delay = RETRY_DELAYS_MS[failure.attempts - 1]
  return delay === undefined ? undefined : new Date(Date.parse(failure.lastFailureAt) + delay).toISOString()
}

function directory(dataRoot: string, fingerprint: string) {
  return join(dataRoot, 'notifications', 'delivery-outcomes', stableHash(fingerprint))
}
function outcomePath(dataRoot: string, fingerprint: string, sequence: number) {
  return join(directory(dataRoot, fingerprint), `${String(sequence).padStart(20, '0')}.json`)
}
function historyPath(dataRoot: string, fingerprint: string, key: string) {
  return join(dataRoot, 'notifications', 'dead-letter-history', stableHash(fingerprint), `${key}.json`)
}

export async function readOutcome(dataRoot: string, fingerprint: string, sequence: number): Promise<DeliveryOutcome | null> {
  const raw = await readNotificationObject<DeliveryOutcome & { schemaVersion: number; hookFingerprint: string }>(outcomePath(dataRoot, fingerprint, sequence))
  if (!raw) return null
  const parsed = typeof raw.recordId === 'string' ? parseRecordName(recordName(raw)) : null
  if (raw.schemaVersion !== 1 || raw.hookFingerprint !== fingerprint || raw.sequence !== sequence || !parsed || parsed.sequence !== sequence ||
    !['retry', 'dead', 'delivered', 'replay'].includes(raw.status)) throw new Error('invalid delivery outcome')
  if ((raw.status === 'retry' || raw.status === 'dead') && (!validFailure(raw.failure) ||
    raw.failure.sequence !== sequence || raw.failure.recordId !== raw.recordId || (raw.status === 'dead' && raw.failure.attempts !== COMMIT_NOTIFICATION_MAX_FAILURES))) {
    throw new Error('invalid delivery failure outcome')
  }
  if (raw.status === 'replay') {
    if (typeof raw.historyKey !== 'string' || !/^[a-f0-9]{64}$/.test(raw.historyKey) || typeof raw.requestedAt !== 'string' || !Number.isFinite(Date.parse(raw.requestedAt))) throw new Error('invalid replay outcome')
    const history = await readNotificationObject<CommitNotificationFailure>(historyPath(dataRoot, fingerprint, raw.historyKey))
    if (!validFailure(history) || history.attempts !== COMMIT_NOTIFICATION_MAX_FAILURES || history.sequence !== sequence || history.recordId !== raw.recordId || stableHash(history) !== raw.historyKey) {
      throw new Error('missing or invalid replay history')
    }
  }
  const { schemaVersion: _schema, hookFingerprint: _fingerprint, ...outcome } = raw
  return outcome as DeliveryOutcome
}

export async function saveOutcome(dataRoot: string, fingerprint: string, outcome: DeliveryOutcome): Promise<void> {
  await writeJsonAtomic(outcomePath(dataRoot, fingerprint, outcome.sequence), { schemaVersion: 1, hookFingerprint: fingerprint, ...outcome })
}

export async function* outcomes(dataRoot: string, fingerprint: string, after = 0): AsyncGenerator<DeliveryOutcome> {
  let entries
  try { entries = await opendir(directory(dataRoot, fingerprint)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for await (const entry of entries) {
    if (!entry.isFile() || !/^\d{20}\.json$/.test(entry.name)) continue
    const sequence = Number(entry.name.slice(0, 20))
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('invalid delivery outcome filename')
    if (sequence <= after) continue
    const outcome = await readOutcome(dataRoot, fingerprint, sequence)
    if (!outcome) throw new Error('delivery outcome disappeared')
    yield outcome
  }
}

export async function* deadLetters(dataRoot: string, fingerprint: string): AsyncGenerator<CommitNotificationFailure> {
  let entries
  try { entries = await opendir(deadLetterDirectory(dataRoot, fingerprint)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for await (const entry of entries) {
    if (!entry.isFile() || !parseRecordName(entry.name)) continue
    const failure = await readDeadLetter(dataRoot, fingerprint, entry.name)
    if (!failure) throw new Error('dead letter disappeared')
    yield failure
  }
}

export async function saveProgress(dataRoot: string, state: CommitHookState): Promise<void> {
  await writeJsonAtomic(commitHookStatePath(dataRoot, state.hookFingerprint), state)
}

/** One-time migration under the delivery lock. Legacy processed progress proves success
 * except for its retained dead letters; new progress always needs per-sequence receipts. */
export async function loadDeliveryState(dataRoot: string, fingerprint: string): Promise<CommitHookState> {
  const old = await readCommitHookAck(dataRoot, fingerprint)
  const state: CommitHookState = { schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: old.ackedThrough ?? 0,
    processedThrough: old.processedThrough, queueVersion: 2 }
  if (old.queueVersion !== 2) {
    if (old.failure && !await readOutcome(dataRoot, fingerprint, old.failure.sequence)) {
      await saveOutcome(dataRoot, fingerprint, { sequence: old.failure.sequence, recordId: old.failure.recordId, status: 'retry', failure: old.failure })
    }
    for await (const failure of deadLetters(dataRoot, fingerprint)) {
      if (!await readOutcome(dataRoot, fingerprint, failure.sequence)) await saveOutcome(dataRoot, fingerprint, {
        sequence: failure.sequence, recordId: failure.recordId, status: 'dead', failure
      })
    }
    for (const file of await recordFiles(dataRoot)) {
      if (file.sequence > state.ackedThrough && file.sequence <= old.processedThrough && !await readOutcome(dataRoot, fingerprint, file.sequence)) {
        await saveOutcome(dataRoot, fingerprint, { sequence: file.sequence, recordId: file.recordId, status: 'delivered' })
      }
    }
  }
  if ((old.queueVersion !== 2 && (old.ackedThrough !== null || old.failure)) || old.ackedThrough !== old.isolatedAck) await saveProgress(dataRoot, state)
  return state
}

/** ACK can only cross positively persisted success receipts, not an absent retry file. */
export async function advanceAck(dataRoot: string, state: CommitHookState, floor: number): Promise<void> {
  for (let sequence = Math.max(state.ackedThrough, floor) + 1; sequence <= (state.processedThrough ?? state.ackedThrough); sequence++) {
    const outcome = await readOutcome(dataRoot, state.hookFingerprint, sequence)
    if (!outcome) throw new Error('missing delivery outcome in visited prefix')
    if (outcome.status !== 'delivered') break
    state.ackedThrough = sequence
  }
}

export async function finishReplay(dataRoot: string, fingerprint: string, outcome: DeliveryOutcome): Promise<void> {
  if (outcome.status !== 'replay') return
  const name = recordName(outcome)
  const dead = await readDeadLetter(dataRoot, fingerprint, name)
  if (!dead) return
  if (stableHash(dead) !== outcome.historyKey) throw new Error('replay does not match the active dead letter')
  await rm(join(deadLetterDirectory(dataRoot, fingerprint), name))
  await syncDirectory(deadLetterDirectory(dataRoot, fingerprint))
}

export async function requeueDeadLetters(dataRoot: string, fingerprint: string, sequence?: number): Promise<number> {
  let requeued = 0
  for await (const failure of deadLetters(dataRoot, fingerprint)) {
    if (sequence !== undefined && failure.sequence !== sequence) continue
    const historyKey = stableHash(failure)
    // History first, then a durable authorized replay marker, then remove active quarantine.
    // A crash between these steps never erases the gap or requires guessing user intent.
    await writeJsonAtomic(historyPath(dataRoot, fingerprint, historyKey), failure)
    const replay: DeliveryOutcome = { sequence: failure.sequence, recordId: failure.recordId, status: 'replay', historyKey, requestedAt: new Date(Date.now()).toISOString() }
    await saveOutcome(dataRoot, fingerprint, replay)
    await finishReplay(dataRoot, fingerprint, replay)
    requeued++
  }
  if (sequence !== undefined && requeued === 0) throw new Error(`sequence ${sequence} is not an active dead letter`)
  return requeued
}

export interface RetryDiagnostic extends Identity {
  reason?: CommitNotificationFailure['reason']
  attempts: number
  nextRetryAt?: string
}

export async function ledgerStatus(dataRoot: string, fingerprint: string, state: Awaited<ReturnType<typeof readCommitHookAck>>) {
  let retryCount = 0
  let deadLetterCount = 0
  let outcomeCount = 0
  let failure: (CommitNotificationFailure & { nextRetryAt?: string }) | undefined
  const retries: RetryDiagnostic[] = []
  const dead: CommitNotificationFailure[] = []
  let knownBeyondProgress = 0
  const fresh = (await recordFiles(dataRoot)).filter(file => file.sequence > state.processedThrough)
  const freshSequences = new Set(fresh.map(file => file.sequence))
  for await (const outcome of outcomes(dataRoot, fingerprint, state.ackedThrough ?? 0)) {
    outcomeCount++
    if (freshSequences.has(outcome.sequence)) knownBeyondProgress++
    if (outcome.status === 'dead') {
      const published = await readDeadLetter(dataRoot, fingerprint, recordName(outcome))
      if (!published || stableHash(published) !== stableHash(outcome.failure)) throw new Error('missing or inconsistent active dead-letter evidence')
      deadLetterCount++
      dead.push(outcome.failure)
      dead.sort((a, b) => b.sequence - a.sequence)
      if (dead.length > DETAILS_LIMIT) dead.pop()
    } else if (outcome.status === 'retry' || outcome.status === 'replay') {
      // A fifth failure remains recoverable even if publication was interrupted.
      const published = outcome.status === 'retry' && outcome.failure.attempts === COMMIT_NOTIFICATION_MAX_FAILURES
        ? await readDeadLetter(dataRoot, fingerprint, recordName(outcome)) : null
      if (outcome.status === 'retry' && published) {
        if (stableHash(published) !== stableHash(outcome.failure)) throw new Error('inconsistent dead-letter publication')
        deadLetterCount++
        dead.push(published)
        dead.sort((a, b) => b.sequence - a.sequence)
        if (dead.length > DETAILS_LIMIT) dead.pop()
        continue
      }
      retryCount++
      const item = outcome.status === 'retry' ? { ...outcome.failure, nextRetryAt: nextRetryAt(outcome.failure) }
        : { sequence: outcome.sequence, recordId: outcome.recordId, attempts: 0, nextRetryAt: outcome.requestedAt }
      retries.push(item)
      retries.sort((a, b) => a.sequence - b.sequence)
      if (retries.length > DETAILS_LIMIT) retries.pop()
      if (outcome.status === 'retry' && (!failure || outcome.sequence < failure.sequence)) failure = { ...outcome.failure, nextRetryAt: nextRetryAt(outcome.failure) }
    }
  }
  // Verify the unexplained prefix lazily, stopping at the first known unresolved sequence.
  if (state.queueVersion === 2 && state.processedThrough > (state.ackedThrough ?? 0)) {
    const probe: CommitHookState = { schemaVersion: 1, hookFingerprint: fingerprint, ackedThrough: state.ackedThrough ?? 0, processedThrough: state.processedThrough }
    await advanceAck(dataRoot, probe, (await readArchiveState(dataRoot))?.archivedThrough ?? 0)
  }
  return { notifyBacklog: fresh.length - knownBeyondProgress + retryCount,
    outcomeCount, retryCount, retries, failure, deadLetterCount, deadLetters: dead }
}
