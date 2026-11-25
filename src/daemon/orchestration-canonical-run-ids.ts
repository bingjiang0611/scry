import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventSink } from '../host-runtime/orchestration/event-sink'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const MAX_LEDGER_CANONICAL_MAP = 4_096

/**
 * The daemon keeps a bounded ledger-run-id -> canonical-run-id map, persisted in `orch_legacy_run`
 * so a restart can still resolve a ledger id that arrived before it.
 */
export function createCanonicalRunIds(sink: EventSink, ledgerToCanonical: Map<string, string>) {
  const canonicalForAlias = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')
  const resolveCanonical = (runId: string): string => ledgerToCanonical.get(runId) ?? runId
  const resolvePersistedCanonical = (runId: string): string => {
    const active = ledgerToCanonical.get(runId)
    if (active || !sink.handle.db.open) return active ?? runId
    const alias = canonicalForAlias.get(runId) as { run_id: string } | undefined
    return alias?.run_id ?? runId
  }
  const trackCanonical = (ledgerRunId: string, canonicalRunId: string): void => {
    if (ledgerRunId === canonicalRunId) return
    if (!sink.isWriteIndeterminate() && sink.handle.db.open) {
      try {
        sink.handle.db
          .prepare('INSERT OR IGNORE INTO orch_legacy_run (ledger_run_id, run_id) VALUES (?, ?)')
          .run(ledgerRunId, canonicalRunId)
      } catch {
        // Ignore if mapping already present or sink fenced.
      }
    }
    ledgerToCanonical.delete(ledgerRunId)
    ledgerToCanonical.set(ledgerRunId, canonicalRunId)
    while (ledgerToCanonical.size > MAX_LEDGER_CANONICAL_MAP) {
      const oldest = ledgerToCanonical.keys().next().value
      if (oldest === undefined) break
      ledgerToCanonical.delete(oldest)
    }
  }

  return { resolveCanonical, resolvePersistedCanonical, trackCanonical }
}

/**
 * A submit's run id may be a caller-chosen id. The ledger needs a v4 id, and a duplicate submit must
 * resolve to the ledger row it already created — read from the alias table, never guessed.
 */
export function createLedgerIdForSubmit(
  db: Database.Database,
  trackCanonical: (ledgerRunId: string, runId: string) => void
): (runId: string, duplicate: boolean) => string {
  const alias = db.prepare('SELECT ledger_run_id FROM orch_legacy_run WHERE run_id = ?')
  return (runId, duplicate) => {
    if (UUID_V4_RE.test(runId)) return runId
    const row = alias.get(runId) as { ledger_run_id: string } | undefined
    if (row) return row.ledger_run_id
    if (duplicate) return runId
    const ledgerRunId = randomUUID()
    trackCanonical(ledgerRunId, runId)
    return ledgerRunId
  }
}

/**
 * R5: the reverse direction. A dispatch row carries the canonical run id, but the dispatcher's ledger
 * is keyed by the v4 id `createLedgerIdForSubmit` minted. Without this the ledger finds no run and the
 * dispatch fence looks like a conflict, which used to drop the intent.
 */
export function createLedgerIdForCanonical(db: Database.Database): (runId: string) => string {
  const alias = db.prepare('SELECT ledger_run_id FROM orch_legacy_run WHERE run_id = ?')
  return (runId) => {
    const row = alias.get(runId) as { ledger_run_id: string } | undefined
    return row?.ledger_run_id ?? runId
  }
}

/** Every run-id mapping the authority needs, built once against one connection. */
export function createRunIdMappings(sink: EventSink, ledgerToCanonical: Map<string, string>) {
  const db = sink.handle.db
  const canonical = createCanonicalRunIds(sink, ledgerToCanonical)
  return {
    ...canonical,
    ledgerIdForSubmit: createLedgerIdForSubmit(db, canonical.trackCanonical),
    ledgerIdForCanonical: createLedgerIdForCanonical(db)
  }
}
