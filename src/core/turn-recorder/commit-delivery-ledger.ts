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

/**
 * Bounded evidence for sequence numbers the ACK crossed without any record file.
 *
 * A number can be absent for two reasons, and both leave nothing to deliver: a commit reserved it
 * and crashed before writing the record, or the record file was deleted outside
 * `scry turns archive`. The ACK may cross such a number — otherwise every later delivery stalls —
 * but the crossing must stay visible, so it is recorded here instead of being inferred as success.
 * Ranges are merged (a large hole costs one entry) and the kept sample is capped; `count` stays
 * exact so a truncated sample never implies there were only `ranges.length` holes.
 */
export interface AbsentSequences {
  schemaVersion: 1
  hookFingerprint: string
  /** Highest crossed sequence; the ledger is append-only and monotonic. */
  absentThrough: number
  count: number
  ranges: Array<[number, number]>
  truncated: boolean
}

const ABSENT_RANGE_LIMIT = 32

function absentPath(dataRoot: string, fingerprint: string) {
  return join(directory(dataRoot, fingerprint), 'absent-sequences.json')
}

export async function readAbsentSequences(dataRoot: string, fingerprint: string): Promise<AbsentSequences | null> {
  const raw = await readNotificationObject<AbsentSequences>(absentPath(dataRoot, fingerprint))
  if (!raw) return null
  if (raw.schemaVersion !== 1 || raw.hookFingerprint !== fingerprint || !Number.isSafeInteger(raw.absentThrough) ||
    !Number.isSafeInteger(raw.count) || raw.count < 0 || raw.count > raw.absentThrough || typeof raw.truncated !== 'boolean' ||
    !Array.isArray(raw.ranges) || raw.ranges.length > ABSENT_RANGE_LIMIT) {
    throw new Error('invalid absent-sequence ledger')
  }
  let previous = 0
  let spanned = 0
  for (const range of raw.ranges) {
    if (!Array.isArray(range) || range.length !== 2) throw new Error('invalid absent-sequence ledger')
    const [from, to] = range
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from > to || from <= previous || to > raw.absentThrough) {
      throw new Error('invalid absent-sequence ledger')
    }
    previous = to
    spanned += to - from + 1
  }
  if (spanned > raw.count) throw new Error('invalid absent-sequence ledger')
  return raw
}

/** Durable, monotonic, range-compacted record of one crossed hole. */
async function recordAbsent(dataRoot: string, fingerprint: string, sequence: number): Promise<void> {
  const previous = await readAbsentSequences(dataRoot, fingerprint)
  const ranges = previous ? previous.ranges.map(([from, to]) => [from, to] as [number, number]) : []
  const last = ranges.at(-1)
  if (last && sequence <= last[1]) return
  if (last && last[1] === sequence - 1) last[1] = sequence
  else ranges.push([sequence, sequence])
  const truncated = (previous?.truncated ?? false) || ranges.length > ABSENT_RANGE_LIMIT
  const ledger: AbsentSequences = {
    schemaVersion: 1,
    hookFingerprint: fingerprint,
    absentThrough: sequence,
    count: (previous?.count ?? 0) + 1,
    ranges: ranges.slice(0, ABSENT_RANGE_LIMIT),
    truncated
  }
  await writeJsonAtomic(absentPath(dataRoot, fingerprint), ledger)
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

/**
 * The store is readable, but the ACK cannot prove a sequence whose record file still exists.
 * This is the one delivery failure a drain may report softly: retrying cannot help, and letting
 * it escape as a thrown promise made every later drain and status query fail.
 */
export class UnresolvedDeliveryPrefixError extends Error {
  constructor() {
    super('missing delivery outcome in visited prefix')
    this.name = 'UnresolvedDeliveryPrefixError'
  }
}

async function walkAck(dataRoot: string, state: CommitHookState, floor: number, persistHoles: boolean): Promise<void> {
  let live: Set<number> | undefined
  for (let sequence = Math.max(state.ackedThrough, floor) + 1; sequence <= (state.processedThrough ?? state.ackedThrough); sequence++) {
    const outcome = await readOutcome(dataRoot, state.hookFingerprint, sequence)
    if (outcome) {
      if (outcome.status !== 'delivered') break
      state.ackedThrough = sequence
      continue
    }
    // No receipt. A sequence that still has a record file lost its delivery result and must stay
    // fail closed; only a sequence with no record at all is a hole with nothing left to deliver.
    live ??= new Set((await recordFiles(dataRoot, { bypassIndex: true })).map(file => file.sequence))
    if (live.has(sequence)) throw new UnresolvedDeliveryPrefixError()
    if (persistHoles) await recordAbsent(dataRoot, state.hookFingerprint, sequence)
    state.ackedThrough = sequence
  }
}

/** ACK can only cross positively persisted success receipts; an absent sequence may also be
 * crossed, but the drain records that absence as durable evidence before the ACK moves. */
export async function advanceAck(dataRoot: string, state: CommitHookState, floor: number): Promise<void> {
  await walkAck(dataRoot, state, floor, true)
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
    // Read-only: status may cross a hole to explain the prefix, but only a drain persists that.
    await walkAck(dataRoot, probe, (await readArchiveState(dataRoot))?.archivedThrough ?? 0, false)
  }
  return { notifyBacklog: fresh.length - knownBeyondProgress + retryCount,
    outcomeCount, retryCount, retries, failure, deadLetterCount, deadLetters: dead, absent: await readAbsentSequences(dataRoot, fingerprint) }
}
