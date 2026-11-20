import {
  SessionLedgerError,
  type LedgerEvent,
  type LedgerRecovery,
  type LedgerSnapshot,
  type LedgerStore
} from '../main/remote/session-ledger'
import { SessionLedgerFileStore } from '../main/remote/session-ledger-file'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { LegacyMirrorWorker } from '../host-runtime/orchestration/legacy-mirror'
import { buildH1SnapshotFromDb, readReservedSeqUntil } from '../host-runtime/orchestration/legacy-snapshot-builder'

export const H1_SEQ_RESERVATION_BLOCK = 1_024

export interface AuthorityLedgerStoreHandle {
  readonly store: LedgerStore
  readonly mirror: LegacyMirrorWorker
  readonly fileStore?: SessionLedgerFileStore
  syncSnapshotFromDb(): void
  h1FallbackStatus(): { unavailable: boolean; reason?: string }
  close(): Promise<void>
}

/**
 * Builds the DB-authoritative in-memory `LedgerStore` + pure downstream async `LegacyMirrorWorker`
 * used by `SCRY_ORCHESTRATION=on` (Decision H):
 * - Startup ALWAYS builds one state-only snapshot (`retainedEvents: []`) from `orchestration.db`
 *   with `lastSeq = minCursor = R` (never reading H1, never renumbering old events); stale device
 *   cursors receive the standard `reset` response.
 * - Sequence ceilings are reserved in blocks (`h1_seq_reserved_until`, default 1,024 per block),
 *   eliminating per-event `h1_seq_floor` commits (0 extra commits pre-first-token).
 * - Writes a valid H1 snapshot immediately upon entering `on` mode (even with 0 runs).
 * - If H1 writes/rewrites fail, marks `h1_fallback_unavailable` and retries periodically in-process.
 */
export function createAuthorityLedgerStore(options: {
  ledgerDirectory: string
  sink: EventSink
  log: (line: string) => void
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
  mirrorRetryIntervalMs?: number
  seqReservationBlockSize?: number
}): AuthorityLedgerStoreHandle {
  const { ledgerDirectory, sink, log, mirrorWriteHook, mirrorMaxPendingEvents, mirrorRetryIntervalMs } = options
  const blockSize = Math.max(16, Math.floor(options.seqReservationBlockSize ?? H1_SEQ_RESERVATION_BLOCK))
  const proactiveMargin = Math.min(128, Math.floor(blockSize / 4))

  let fileStore: SessionLedgerFileStore | undefined
  const openWrappedFileStore = (): LedgerStore | undefined => {
    try {
      fileStore = new SessionLedgerFileStore(ledgerDirectory)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-h1-fallback-unavailable ${msg}`)
      return undefined
    }
    const target = fileStore
    if (!mirrorWriteHook) return target
    return {
      assertAvailable: () => target.assertAvailable(),
      loadAll: () => target.loadAll(),
      loadRecovery: () => target.loadRecovery(),
      shouldCompact: (event) => target.shouldCompact(event),
      compact: (snapshot) => {
        mirrorWriteHook('compact', snapshot.lastSeq)
        target.compact(snapshot)
      },
      append: (event) => {
        mirrorWriteHook('append', event.seq)
        target.append(event)
      }
    }
  }

  const mirrorTargetStore = openWrappedFileStore()

  // Decision H §14.1–2 + W9-review-2 MF4: build single state snapshot at max(R, legacyLedgerSeq, H1 lastSeq)
  // (corrupt/partial H1 is ignored inside try/catch so it never blocks on-mode startup; closes fail-open off residual).
  let h1DiskLastSeq = 0
  if (fileStore) {
    try {
      const recovery = fileStore.loadRecovery()
      h1DiskLastSeq = recovery.snapshot?.lastSeq ?? 0
      for (const ev of recovery.events) {
        if (Number.isSafeInteger(ev.seq) && ev.seq > h1DiskLastSeq) h1DiskLastSeq = ev.seq
      }
    } catch {
      h1DiskLastSeq = 0
    }
  }
  const prevReserved = readReservedSeqUntil(sink)
  const legacyLedgerSeq = Math.max(0, Math.floor(Number(sink.getMeta('legacy_ledger_seq') ?? '0') || 0))
  const initialSnapshot = buildH1SnapshotFromDb(sink, {
    lastSeq: Math.max(prevReserved, legacyLedgerSeq, h1DiskLastSeq)
  })
  const startSeq = initialSnapshot.lastSeq

  // Reserve the next block `[startSeq + 1, startSeq + blockSize]` once at startup (off pre-first-token path).
  let reservedUntil = startSeq + blockSize
  if (!sink.isWriteIndeterminate() && sink.handle.db.open) {
    sink.setMeta('h1_seq_reserved_until', String(reservedUntil))
  }

  let currentSnapshot: LedgerSnapshot = initialSnapshot
  let memoryEvents: LedgerEvent[] = []
  let currentLastSeq = startSeq

  const persistReservedUntil = (nextCeiling: number): void => {
    if (nextCeiling <= reservedUntil || sink.isWriteIndeterminate() || !sink.handle.db.open) return
    try {
      sink.setMeta('h1_seq_reserved_until', String(nextCeiling))
      reservedUntil = nextCeiling
    } catch {
      // Ignore if sink fenced.
    }
  }

  const mirror = new LegacyMirrorWorker({
    sink,
    ...(mirrorTargetStore ? { ledgerStore: mirrorTargetStore } : {}),
    reopenLedgerStore: openWrappedFileStore,
    createSnapshot: () => buildH1SnapshotFromDb(sink, { lastSeq: currentLastSeq }),
    ...(mirrorMaxPendingEvents !== undefined ? { maxPendingEvents: mirrorMaxPendingEvents } : {}),
    ...(mirrorRetryIntervalMs !== undefined ? { fallbackRetryIntervalMs: mirrorRetryIntervalMs } : {}),
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-legacy-mirror-error ${msg}`)
    },
    onH1FallbackUnavailable: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-h1-fallback-unavailable reason=${msg}`)
    },
    onH1FallbackRecovered: (lastSeq) => {
      log(`daemon.orchestration-h1-fallback-recovered lastSeq=${lastSeq}`)
    }
  })

  // Decision H §14.3: H1 must be a valid file immediately upon entering `on` mode (even with 0 runs).
  mirror.writeInitialSnapshot(initialSnapshot)

  const store: LedgerStore = {
    assertAvailable: () => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
    },
    loadAll: () => [...currentSnapshot.retainedEvents, ...memoryEvents],
    loadRecovery: (): LedgerRecovery => ({
      snapshot: structuredClone(currentSnapshot),
      events: [...memoryEvents]
    }),
    shouldCompact: (nextEvent) => {
      if (currentSnapshot.retainedEvents.length + memoryEvents.length >= 8192) return true
      if (!fileStore || mirror.isH1FallbackUnavailable() || mirror.hasPendingCompact()) return false
      try {
        return fileStore.shouldCompact(nextEvent)
      } catch {
        return false
      }
    },
    compact: (snapshot) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      const frozen = structuredClone(snapshot)
      if (frozen.lastSeq > reservedUntil) {
        persistReservedUntil(frozen.lastSeq + blockSize)
        if (frozen.lastSeq > reservedUntil) {
          throw new SessionLedgerError('orchestration_write_indeterminate')
        }
      }
      currentSnapshot = frozen
      memoryEvents = []
      currentLastSeq = Math.max(currentLastSeq, frozen.lastSeq)
      // W9-review-2 B2: routine compaction mirrors the ledger's own pre-emit snapshot directly
      // (consistent with the immediately following append, ZERO sync buildH1SnapshotFromDb on emit).
      mirror.enqueueCompact(frozen)
    },
    append: (event) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      // Block reservation invariant (Decision H + W9-review-2 B3):
      // NEVER emit a seq beyond persisted `h1_seq_reserved_until`.
      if (event.seq > reservedUntil) {
        persistReservedUntil(Math.max(reservedUntil + blockSize, event.seq))
        if (event.seq > reservedUntil) {
          throw new SessionLedgerError('orchestration_write_indeterminate')
        }
      }
      memoryEvents.push(event)
      currentLastSeq = Math.max(currentLastSeq, event.seq)
      // Proactively top up block AFTER terminal events when approaching exhaustion so pre-first-token stays 0 commits.
      const isTerminal =
        event.kind === 'run_settled' || event.kind === 'run_failed' || event.kind === 'run_cancelled'
      if (isTerminal && currentLastSeq >= reservedUntil - proactiveMargin) {
        persistReservedUntil(reservedUntil + blockSize)
      }
      // Downstream pure mirror (Decision H): ZERO sync file fsync pre-first-token.
      mirror.enqueue(event)
    }
  }

  return {
    store,
    mirror,
    fileStore,
    syncSnapshotFromDb: () => {
      if (!fileStore || sink.isWriteIndeterminate() || !sink.handle.db.open) return
      const snap = buildH1SnapshotFromDb(sink, { lastSeq: currentLastSeq })
      mirror.enqueueCompact(snap)
    },
    h1FallbackStatus: () => {
      const unavailable = mirror.isH1FallbackUnavailable()
      const reason = mirror.h1FallbackReason()
      return { unavailable, ...(unavailable && reason ? { reason } : {}) }
    },
    close: async () => {
      await mirror.close()
      try {
        fileStore?.close()
      } catch {
        // Preserve clean shutdown even if H1 store was degraded.
      }
    }
  }
}
