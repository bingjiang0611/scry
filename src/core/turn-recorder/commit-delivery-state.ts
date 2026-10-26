import { opendir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson, writeJsonAtomic } from './io.js'
import { parseRecordName, recordFiles, stableHash } from './store-index.js'

export const COMMIT_NOTIFICATION_MAX_FAILURES = 5
const DEAD_LETTER_DETAILS_LIMIT = 20

export interface CommitNotificationFailure {
  sequence: number
  recordId: string
  attempts: number
  lastFailureAt: string
  reason: 'spawn_error' | 'stdin_error' | 'timeout' | 'signal' | 'exit' | 'record_unavailable' | 'environment_unavailable'
  exitCode?: number | null
  signal?: NodeJS.Signals | null
  errorCode?: string
}

export interface CommitHookState {
  schemaVersion: 1
  hookFingerprint: string
  ackedThrough: number
  /** Visited prefix; queueVersion 2 also includes deferred retries. Never an ACK. */
  processedThrough?: number
  queueVersion?: 2
  failure?: CommitNotificationFailure
}

interface DeadLetter extends CommitNotificationFailure {
  schemaVersion: 1
  hookFingerprint: string
}

export function commitHookStatePath(dataRoot: string, fingerprint: string): string {
  return join(dataRoot, 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
}

export function recordName(failure: Pick<CommitNotificationFailure, 'sequence' | 'recordId'>): string {
  return `${String(failure.sequence).padStart(20, '0')}-${failure.recordId}.json`
}

export function validFailure(value: unknown): value is CommitNotificationFailure {
  if (!value || typeof value !== 'object') return false
  const failure = value as CommitNotificationFailure
  if (typeof failure.recordId !== 'string' || !Number.isSafeInteger(failure.sequence)) return false
  const parsed = parseRecordName(recordName(failure))
  return parsed?.sequence === failure.sequence && parsed.recordId === failure.recordId &&
    Number.isSafeInteger(failure.attempts) && failure.attempts > 0 && failure.attempts <= COMMIT_NOTIFICATION_MAX_FAILURES &&
    typeof failure.lastFailureAt === 'string' && Number.isFinite(Date.parse(failure.lastFailureAt)) &&
    ['spawn_error', 'stdin_error', 'timeout', 'signal', 'exit', 'record_unavailable', 'environment_unavailable'].includes(failure.reason) &&
    (failure.exitCode === undefined || failure.exitCode === null || Number.isSafeInteger(failure.exitCode)) &&
    (failure.signal === undefined || failure.signal === null || typeof failure.signal === 'string') &&
    (failure.errorCode === undefined || typeof failure.errorCode === 'string')
}

export async function readNotificationObject<T>(path: string): Promise<T | null> {
  let source: string
  try { source = await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('unreadable commit notification state')
  }
  let value: unknown
  try { value = JSON.parse(source) } catch { throw new Error('invalid commit notification state') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid commit notification state')
  return value as T
}

export async function readCommitHookAck(dataRoot: string, fingerprint: string) {
  // Keep v1 read-only: an old App can still own it while a new CLI writes its own
  // checkpoint. Only the exact same identity may contribute a prior ACK.
  const [isolated, legacy] = await Promise.all([
    readNotificationObject<CommitHookState>(commitHookStatePath(dataRoot, fingerprint)),
    readJson<CommitHookState>(join(dataRoot, 'notifications', 'commit-hook-state.json'))
  ])
  const validAck = (state: CommitHookState | null): number | null =>
    state?.schemaVersion === 1 && state.hookFingerprint === fingerprint &&
      Number.isSafeInteger(state.ackedThrough) && state.ackedThrough >= 0
      ? state.ackedThrough : null
  const isolatedAck = validAck(isolated)
  const legacyAck = validAck(legacy)
  const ackedThrough = isolatedAck === null ? legacyAck : Math.max(isolatedAck, legacyAck ?? 0)
  let processedThrough = ackedThrough ?? 0
  let failure: CommitNotificationFailure | undefined
  if (isolated) {
    const progress = isolated.processedThrough ?? isolated.ackedThrough
    if (isolatedAck === null || !Number.isSafeInteger(progress) || progress < isolatedAck ||
      (isolated.queueVersion !== undefined && isolated.queueVersion !== 2) ||
      (isolated.queueVersion === 2 && isolated.failure !== undefined) ||
      (isolated.failure !== undefined && (!validFailure(isolated.failure) || isolated.failure.sequence <= progress))) {
      throw new Error('invalid commit notification state')
    }
    processedThrough = Math.max(processedThrough, progress)
    if (isolated.failure && isolated.failure.sequence > processedThrough) failure = isolated.failure
  }
  if (isolated?.queueVersion !== 2 && processedThrough > (ackedThrough ?? 0) &&
    (await readDeadLetters(dataRoot, fingerprint)).deadLetterCount === 0) {
    throw new Error('commit notification state is missing dead-letter evidence')
  }
  return { ackedThrough, isolatedAck, processedThrough, failure, queueVersion: isolated?.queueVersion }
}

export async function pendingCommitFiles(dataRoot: string, state: { processedThrough: number; failure?: CommitNotificationFailure }) {
  const pending = (await recordFiles(dataRoot)).filter(file => file.sequence > state.processedThrough)
  // A previously observed poison record remains a queue item even if its source was removed.
  const failure = state.failure
  if (failure && !pending.some(file => file.name === recordName(failure))) {
    pending.push({ name: recordName(failure), sequence: failure.sequence, recordId: failure.recordId })
    pending.sort((a, b) => a.sequence - b.sequence)
  }
  return pending
}

export function deadLetterDirectory(dataRoot: string, fingerprint: string): string {
  return join(dataRoot, 'notifications', 'dead-letters', stableHash(fingerprint))
}

export async function publishDeadLetter(dataRoot: string, fingerprint: string, failure: CommitNotificationFailure): Promise<void> {
  await writeJsonAtomic(join(deadLetterDirectory(dataRoot, fingerprint), recordName(failure)), {
    schemaVersion: 1, hookFingerprint: fingerprint, ...failure
  } satisfies DeadLetter)
}

export async function readDeadLetter(dataRoot: string, fingerprint: string, filename: string): Promise<CommitNotificationFailure | null> {
  const raw = await readNotificationObject<DeadLetter>(join(deadLetterDirectory(dataRoot, fingerprint), filename))
  if (raw === null) return null
  if (raw.schemaVersion !== 1 || raw.hookFingerprint !== fingerprint || !validFailure(raw) ||
    raw.attempts !== COMMIT_NOTIFICATION_MAX_FAILURES || recordName(raw) !== filename) {
    throw new Error('invalid commit notification dead-letter state')
  }
  const { schemaVersion: _version, hookFingerprint: _fingerprint, ...failure } = raw
  return failure
}

export async function readDeadLetters(dataRoot: string, fingerprint: string) {
  const directory = deadLetterDirectory(dataRoot, fingerprint)
  let entries
  try { entries = await opendir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deadLetterCount: 0, deadLetters: [] as CommitNotificationFailure[] }
    throw error
  }
  let deadLetterCount = 0
  const latest: { name: string; sequence: number }[] = []
  // Count with bounded memory; only read the latest twenty small diagnostic bodies.
  for await (const entry of entries) {
    const parsed = entry.isFile() ? parseRecordName(entry.name) : null
    if (!parsed) continue
    deadLetterCount++
    latest.push({ name: entry.name, sequence: parsed.sequence })
    latest.sort((a, b) => b.sequence - a.sequence)
    if (latest.length > DEAD_LETTER_DETAILS_LIMIT) latest.pop()
  }
  const deadLetters = await Promise.all(latest.map(async entry => {
    const failure = await readDeadLetter(dataRoot, fingerprint, entry.name)
    if (!failure) throw new Error('commit notification dead-letter state disappeared during inspection')
    return failure
  }))
  return { deadLetterCount, deadLetters }
}
