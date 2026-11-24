import type Database from 'better-sqlite3'
import { TERMINAL_LIFECYCLE_SQL } from './run-transitions'
import { canonicalJson } from './canonical-json'

export const OUTBOX_DONE_RETENTION_MS = 72 * 3_600_000
export const OUTBOX_DEAD_RETENTION_MS = 30 * 24 * 3_600_000
/** 决定 C: events stay 30 days, and anything still retained must decode under the current build. */
export const DEFAULT_EVENT_RETENTION_MS = 30 * 24 * 3_600_000
const DEFAULT_BATCH_SIZE = 500

export interface PruneOptions {
  now: number
  eventRetentionMs?: number
  batchSize?: number
  /** Hard cap on pages per run so a large backlog cannot hold the writer forever. */
  maxBatches?: number
}

export interface PruneReport {
  deletedEvents: number
  deletedOutbox: number
  deletedReceipts: number
  clearedInlineBodies: number
  queuedBodyErasures: number
  prunedThrough: number
  wroteWatermarkFirst: boolean
  batches: number
}

const APPLIED_SEQ_KEY = 'projection_applied_seq'
const PRUNED_THROUGH_KEY = 'pruned_through'

function readMetaNumber(db: Database.Database, key: string): number {
  const raw = db.prepare('SELECT value FROM orch_meta WHERE key = ?').pluck().get(key) as string | undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : 0
}

function writeMeta(db: Database.Database, key: string, value: number): void {
  db.prepare('INSERT OR REPLACE INTO orch_meta (key, value) VALUES (?, ?)').run(key, String(value))
}

/**
 * B2 (data §4.8): prunes event rows before `retentionMs` while never crossing the position any
 * projection has applied, never removing the newest event of a stream, and never removing an
 * event that still anchors a live outbox row. The watermark is written first so a crash can only
 * under-prune.
 */
export function pruneOrchestrationInDb(db: Database.Database, options: PruneOptions): PruneReport {
  const now = options.now
  const retentionMs = options.eventRetentionMs ?? DEFAULT_EVENT_RETENTION_MS
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const maxBatches = Math.max(1, options.maxBatches ?? 20)
  const cutoff = now - retentionMs
  const report: PruneReport = {
    deletedEvents: 0,
    deletedOutbox: 0,
    deletedReceipts: 0,
    clearedInlineBodies: 0,
    queuedBodyErasures: 0,
    prunedThrough: readMetaNumber(db, PRUNED_THROUGH_KEY),
    wroteWatermarkFirst: false,
    batches: 0
  }

  const appliedSeq = readMetaNumber(db, APPLIED_SEQ_KEY)

  const selectBatch = db.prepare(
    `SELECT e.seq FROM orch_event e
     WHERE e.at < :cutoff
       AND e.seq <= :applied
       AND e.seq < (SELECT MAX(head.seq) FROM orch_event head WHERE head.stream = e.stream)
       AND NOT EXISTS (
         SELECT 1 FROM orch_outbox o
         WHERE o.state IN ('pending', 'running') AND o.run_id IS NOT NULL AND o.run_id = e.run_id
           AND o.causation_seq > e.seq
       )
     ORDER BY e.seq ASC
     LIMIT :batch`
  )
  const deleteRow = db.prepare('DELETE FROM orch_event WHERE seq = ?')

  // The watermark must lead the deletes it authorises. Plan a bounded page set up front.
  const planned = selectBatch.all({ cutoff, applied: appliedSeq, batch: batchSize * maxBatches }) as Array<{
    seq: number
  }>
  const tx = db.transaction(() => {
    if (planned.length > 0) {
      const highest = planned.reduce((acc, row) => Math.max(acc, row.seq), 0)
      if (highest > report.prunedThrough) {
        writeMeta(db, PRUNED_THROUGH_KEY, highest)
        report.prunedThrough = highest
      }
    }
    report.wroteWatermarkFirst = true
    for (let page = 0; page < maxBatches; page += 1) {
      const rows = selectBatch.all({ cutoff, applied: appliedSeq, batch: batchSize }) as Array<{ seq: number }>
      if (rows.length === 0) break
      report.batches += 1
      for (const row of rows) {
        deleteRow.run(row.seq)
        report.deletedEvents += 1
      }
      if (rows.length < batchSize) break
    }

    report.deletedOutbox = db
      .prepare(
        `DELETE FROM orch_outbox
         WHERE (state = 'done' AND completed_at IS NOT NULL AND completed_at < ?)
            OR (state IN ('failed', 'voided') AND completed_at IS NOT NULL AND completed_at < ?)`
      )
      .run(now - OUTBOX_DONE_RETENTION_MS, now - OUTBOX_DEAD_RETENTION_MS).changes

    // B4: device/user receipts and resolveIntent tombstones are permanent; system and effect
    // receipts exist only to make their own commands idempotent, so they expire with the events.
    report.deletedReceipts = db
      .prepare(
        `DELETE FROM orch_command
         WHERE type != 'run.resolve_intent'
           AND (actor = 'system' OR actor LIKE 'effect:%')
           AND accepted_at < ?`
      )
      .run(cutoff).changes

    report.clearedInlineBodies = clearFinishedInlineBodies(db)
    report.queuedBodyErasures = queueTerminalRunBodyErasures(db, now - retentionMs)
  })
  tx()
  return report
}

/** Drops inline prompt bytes from outbox rows that can no longer be dispatched. */
function clearFinishedInlineBodies(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT effect_id, payload FROM orch_outbox
       WHERE state IN ('done', 'failed', 'voided')
         AND json_extract(payload, '$.body.storage') = 'inline'`
    )
    .all() as Array<{ effect_id: string; payload: string }>
  if (rows.length === 0) return 0
  const update = db.prepare('UPDATE orch_outbox SET payload = ? WHERE effect_id = ?')
  let cleared = 0
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as { body?: { storage: string; sha256?: string; bytes?: number } }
    if (!payload.body || !('inline' in payload.body)) continue
    const { sha256, bytes } = payload.body
    update.run(canonicalJson({ ...payload, body: { storage: 'inline', ...(sha256 ? { sha256 } : {}), ...(bytes ? { bytes } : {}) } }), row.effect_id)
    cleared += 1
  }
  return cleared
}

/**
 * B2.4 (data §4.7): external bodies of terminal runs are no longer needed once the run has been
 * settled past the retention window. Erasure goes through the durable `orch_body_erase` queue so
 * unlink failures are retried instead of resurrecting the bytes.
 */
function queueTerminalRunBodyErasures(db: Database.Database, olderThanAt: number): number {
  const rows = db
    .prepare(
      `SELECT run_id, body FROM orch_p_run
       WHERE lifecycle IN ${TERMINAL_LIFECYCLE_SQL}
         AND body IS NOT NULL AND settled_at IS NOT NULL AND settled_at < ?`
    )
    .all(olderThanAt) as Array<{ run_id: string; body: string }>
  let queued = 0
  const insert = db.prepare('INSERT OR IGNORE INTO orch_body_erase (session_key, sha256) VALUES (?, ?)')
  for (const row of rows) {
    let descriptor: { storage?: string; sha256?: string } | null = null
    try {
      descriptor = JSON.parse(row.body) as { storage?: string; sha256?: string }
    } catch {
      continue
    }
    if (descriptor?.storage !== 'external' || !descriptor.sha256) continue
    queued += insert.run(`run:${row.run_id}`, descriptor.sha256).changes
  }
  return queued
}
