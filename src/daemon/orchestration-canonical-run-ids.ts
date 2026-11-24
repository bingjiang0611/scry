import type { EventSink } from '../host-runtime/orchestration/event-sink'

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
