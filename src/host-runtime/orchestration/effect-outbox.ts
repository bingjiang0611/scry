import type Database from 'better-sqlite3'

export const OUTBOX_MAX_ATTEMPTS = 5
export const OUTBOX_BACKOFF_BASE_MS = 100
export const OUTBOX_BACKOFF_CAP_MS = 30_000
/**
 * R6: a claim that has not been settled within this window belongs to an owner that is gone. The
 * dispatcher settles a claim within milliseconds of starting the work, so a row that is still
 * `running` after a minute was orphaned by a crash, and its session queue stayed blocked forever.
 */
export const OUTBOX_LEASE_MS = 60_000

export interface ClaimedEffect {
  effectId: string
  kind: string
  policy: string
  runId: string | null
  sessionKey: string | null
  causationSeq: number
  payload: string
  attempts: number
  leaseOwner: string
}

export type SettleOutcome =
  | { status: 'retry'; delayMs: number; attempts: number }
  | { status: 'exhausted'; attempts: number }
  | { status: 'lease_lost' }

interface RawOutboxRow {
  effect_id: string
  kind: string
  policy: string
  run_id: string | null
  session_key: string | null
  causation_seq: number
  payload: string
  attempts: number
  lease_owner: string | null
}

function backoffFor(attempts: number): number {
  return Math.min(OUTBOX_BACKOFF_CAP_MS, OUTBOX_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))
}

/**
 * B1: `UPDATE … RETURNING` claims one effect. Same-session effects are strictly FIFO: a row is
 * only claimable when no earlier row of the same session is pending or running. Expired rows are
 * voided in the same transaction so the pending TTL cannot strand a session queue.
 */
/** Voids effects past their pending TTL and reports them so the caller can cancel their runs. */
export function voidExpiredEffects(
  db: Database.Database,
  now: number
): Array<{ effectId: string; runId: string | null }> {
  return db
    .prepare(
      `UPDATE orch_outbox SET state = 'voided', last_error = COALESCE(last_error, 'pending_expired'),
         completed_at = ?, lease_owner = NULL, claimed_at = NULL
       WHERE state = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?
       RETURNING effect_id AS effectId, run_id AS runId`
    )
    .all(now, now) as Array<{ effectId: string; runId: string | null }>
}

/**
 * R1/W9: clears every backoff. Called only when the condition that deferred the rows has actually
 * changed (auth released, queue released, a restart note consumed), never on an ordinary pump —
 * otherwise a steady stream of new submissions would nullify the backoff entirely.
 */
export function wakeDeferredEffects(db: Database.Database): number {
  return db
    .prepare("UPDATE orch_outbox SET available_at = NULL WHERE state = 'pending' AND available_at IS NOT NULL")
    .run().changes
}

/** R6: returns orphaned claims to the queue so a dead owner cannot block its session forever. */
export function reclaimExpiredLeases(db: Database.Database, now: number): number {
  return db
    .prepare(
      `UPDATE orch_outbox SET state = 'pending', claimed_at = NULL, lease_owner = NULL,
         available_at = NULL, last_error = 'lease_expired'
       WHERE state = 'running' AND claimed_at IS NOT NULL AND claimed_at <= ?`
    )
    .run(now - OUTBOX_LEASE_MS).changes
}

export interface ClaimResult {
  /** Rows past their pending TTL, surfaced so the caller can cancel their runs. */
  expired: Array<{ effectId: string; runId: string | null }>
  effect?: ClaimedEffect
}

export function claimNextEffect(input: {
  db: Database.Database
  owner: string
  now: number
  sessionKey?: string
  /** Restricts the claim to one kind so a dispatcher never takes work it cannot run. */
  kind?: string
}): ClaimResult {
  const { db, owner, now } = input
  return db.transaction((): ClaimResult => {
    // Expiry is reported, not swallowed: the voided effect still owns a run nobody started.
    const expired = voidExpiredEffects(db, now)
    reclaimExpiredLeases(db, now)

    const row = db
      .prepare(
        `WITH pending AS (
           SELECT o.effect_id, o.causation_seq,
                  COALESCE(o.session_key, (SELECT r.session_key FROM orch_p_run r WHERE r.run_id = o.run_id)) AS sess
           FROM orch_outbox o
           WHERE o.state = 'pending'
             AND (o.available_at IS NULL OR o.available_at <= :now)
             AND (:kind IS NULL OR o.kind = :kind)
             AND (:session IS NULL OR COALESCE(o.session_key,
                   (SELECT r.session_key FROM orch_p_run r WHERE r.run_id = o.run_id)) = :session)
             AND NOT EXISTS (
               SELECT 1 FROM orch_outbox earlier
               WHERE earlier.effect_id != o.effect_id
                 AND earlier.state IN ('pending', 'running')
                 AND (earlier.causation_seq < o.causation_seq
                   OR (earlier.causation_seq = o.causation_seq AND earlier.effect_id < o.effect_id))
                 AND COALESCE(earlier.session_key,
                       (SELECT r.session_key FROM orch_p_run r WHERE r.run_id = earlier.run_id))
                     IS COALESCE(o.session_key, (SELECT r.session_key FROM orch_p_run r WHERE r.run_id = o.run_id))
             )
           ORDER BY o.causation_seq ASC, o.effect_id ASC
           LIMIT 1
         )
         SELECT o.effect_id, o.kind, o.policy, o.run_id, pending.sess AS session_key,
                o.causation_seq, o.payload, o.attempts
         FROM orch_outbox o JOIN pending ON pending.effect_id = o.effect_id`
      )
      .get({ session: input.sessionKey ?? null, kind: input.kind ?? null, now }) as RawOutboxRow | undefined
    if (!row) return { expired }
    const claimed = db
      .prepare(
        `UPDATE orch_outbox
         SET state = 'running', attempts = attempts + 1, lease_owner = ?, claimed_at = ?
         WHERE effect_id = ? AND state = 'pending'
         RETURNING effect_id, kind, policy, run_id, causation_seq, payload, attempts`
      )
      .get(owner, now, row.effect_id) as
      | {
          effect_id: string
          kind: string
          policy: string
          run_id: string | null
          causation_seq: number
          payload: string
          attempts: number
        }
      | undefined
    if (!claimed) return { expired }
    return {
      expired,
      effect: {
        effectId: claimed.effect_id,
        kind: claimed.kind,
        policy: claimed.policy,
        runId: claimed.run_id,
        sessionKey: row.session_key,
        causationSeq: claimed.causation_seq,
        payload: claimed.payload,
        attempts: claimed.attempts,
        leaseOwner: owner
      }
    }
  })()
}

/** Marks a claimed effect done. Only the current lease holder may settle it. */
export function succeedEffect(input: {
  db: Database.Database
  effectId: string
  owner: string
  now: number
  resultSeq?: number
}): boolean {
  const changes = input.db
    .prepare(
      `UPDATE orch_outbox
       SET state = 'done', completed_at = ?, result_seq = ?, lease_owner = NULL, last_error = NULL
       WHERE effect_id = ? AND state = 'running' AND lease_owner = ?`
    )
    .run(input.now, input.resultSeq ?? null, input.effectId, input.owner).changes
  return changes > 0
}

/** Releases a claimed effect for a later attempt, or fails it once attempts are exhausted. */
export function retryEffect(input: {
  db: Database.Database
  effectId: string
  owner: string
  now: number
  reason: string
}): SettleOutcome {
  return input.db.transaction((): SettleOutcome => {
    const row = input.db
      .prepare('SELECT attempts FROM orch_outbox WHERE effect_id = ? AND state = ? AND lease_owner = ?')
      .get(input.effectId, 'running', input.owner) as { attempts: number } | undefined
    if (!row) return { status: 'lease_lost' }
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      input.db
        .prepare(
          `UPDATE orch_outbox SET state = 'failed', completed_at = ?, last_error = ?, lease_owner = NULL
           WHERE effect_id = ? AND state = 'running' AND lease_owner = ?`
        )
        .run(input.now, input.reason, input.effectId, input.owner)
      return { status: 'exhausted', attempts: row.attempts }
    }
    const delayMs = backoffFor(row.attempts)
    input.db
      .prepare(
        `UPDATE orch_outbox SET state = 'pending', claimed_at = NULL, lease_owner = NULL, last_error = ?,
             available_at = ?
         WHERE effect_id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(input.reason, input.now + delayMs, input.effectId, input.owner)
    return { status: 'retry', delayMs, attempts: row.attempts }
  })()
}

/**
 * Returns a claimed effect to the queue without consuming its retry budget. Policy deferrals
 * (provider still authenticating, host restarting) are not failures and must not exhaust the
 * five attempts that bound real errors.
 */
export function deferEffect(input: {
  db: Database.Database
  effectId: string
  owner: string
  reason: string
  /** When the deferred row may be claimed again; the caller's retry hint, clamped to a floor. */
  now: number
  delayMs: number
}): boolean {
  return (
    input.db
      .prepare(
        `UPDATE orch_outbox
         SET state = 'pending', claimed_at = NULL, lease_owner = NULL, last_error = ?,
             attempts = MAX(0, attempts - 1), available_at = ?
         WHERE effect_id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(input.reason, input.now + Math.max(10, input.delayMs), input.effectId, input.owner).changes > 0
  )
}

/** Fails a claimed effect without further attempts. */
export function failEffect(input: {
  db: Database.Database
  effectId: string
  owner: string
  now: number
  reason: string
}): boolean {
  return (
    input.db
      .prepare(
        `UPDATE orch_outbox SET state = 'failed', completed_at = ?, last_error = ?, lease_owner = NULL
         WHERE effect_id = ? AND state = 'running' AND lease_owner = ?`
      )
      .run(input.now, input.reason, input.effectId, input.owner).changes > 0
  )
}

export interface EffectWorkerPassReport {
  claimed: number
  completed: number
  retried: number
  failed: number
  leaseLost: number
  nextRetryInMs?: number
}

export interface EffectWorkerPassOptions {
  db: Database.Database
  owner: string
  now: () => number
  execute: (effect: ClaimedEffect) => 'done' | 'retry' | 'failed'
  maxEffects?: number
}

/**
 * B1: one bounded worker pass. Undecodable rows are failed in place so they cannot block their
 * session queue, and every state change happens in the caller's EventSink database handle.
 */
export function runEffectWorkerPass(options: EffectWorkerPassOptions): EffectWorkerPassReport {
  const report: EffectWorkerPassReport = { claimed: 0, completed: 0, retried: 0, failed: 0, leaseLost: 0 }
  const limit = Math.max(1, options.maxEffects ?? 32)
  for (let i = 0; i < limit; i += 1) {
    const { effect } = claimNextEffect({ db: options.db, owner: options.owner, now: options.now() })
    if (!effect) break
    report.claimed += 1
    let decoded: ClaimedEffect
    try {
      JSON.parse(effect.payload)
      decoded = effect
    } catch {
      failEffect({
        db: options.db,
        effectId: effect.effectId,
        owner: options.owner,
        now: options.now(),
        reason: 'decode_failed'
      })
      report.failed += 1
      continue
    }
    let outcome: 'done' | 'retry' | 'failed'
    try {
      outcome = options.execute(decoded)
    } catch {
      outcome = 'retry'
    }
    if (outcome === 'done') {
      if (succeedEffect({
        db: options.db,
        effectId: effect.effectId,
        owner: options.owner,
        now: options.now()
      })) report.completed += 1
      else report.leaseLost += 1
      continue
    }
    if (outcome === 'failed') {
      if (failEffect({
        db: options.db,
        effectId: effect.effectId,
        owner: options.owner,
        now: options.now(),
        reason: 'dispatch_failed'
      })) report.failed += 1
      else report.leaseLost += 1
      continue
    }
    const settled = retryEffect({
      db: options.db,
      effectId: effect.effectId,
      owner: options.owner,
      now: options.now(),
      reason: 'dispatch_error'
    })
    if (settled.status === 'retry') {
      report.retried += 1
      report.nextRetryInMs =
        report.nextRetryInMs === undefined ? settled.delayMs : Math.min(report.nextRetryInMs, settled.delayMs)
    } else if (settled.status === 'exhausted') report.failed += 1
    else report.leaseLost += 1
  }
  return report
}
