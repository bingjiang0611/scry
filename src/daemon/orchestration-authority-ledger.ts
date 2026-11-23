import { SessionLedgerError, type LedgerStore } from '../main/remote/session-ledger'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { buildDispatchLedgerSnapshot } from '../host-runtime/orchestration/dispatch-ledger-snapshot'

/** The dispatcher holds a transient projection. SQLite owns durable transitions and receipts. */
export function createAuthorityLedgerStore(sink: EventSink): LedgerStore {
  const assertAvailable = (): void => {
    if (!sink.handle.db.open || sink.isWriteIndeterminate()) {
      throw new SessionLedgerError('orchestration_write_indeterminate')
    }
  }
  return {
    assertAvailable,
    loadAll: () => [],
    loadRecovery: () => ({ snapshot: buildDispatchLedgerSnapshot(sink), events: [] }),
    append: assertAvailable,
    compact: assertAvailable
  }
}
