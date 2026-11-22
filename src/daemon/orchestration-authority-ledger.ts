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

export function createAuthorityLedgerStore(options: {
  ledgerDirectory: string
  sink: EventSink
  log: (line: string) => void
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
  mirrorRetryIntervalMs?: number
  seqReservationBlockSize?: number
  h1DiskLastSeq?: number
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

  const h1DiskLastSeq = Math.max(0, Math.floor(options.h1DiskLastSeq ?? 0))
  const prevReserved = readReservedSeqUntil(sink)
  const legacyLedgerSeq = Math.max(0, Math.floor(Number(sink.getMeta('legacy_ledger_seq') ?? '0') || 0))
  const initialSnapshot = buildH1SnapshotFromDb(sink, {
    lastSeq: Math.max(prevReserved, legacyLedgerSeq, h1DiskLastSeq)
  })
  const startSeq = initialSnapshot.lastSeq

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
      mirror.enqueueCompact(frozen)
    },
    append: (event) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      if (event.seq > reservedUntil) {
        persistReservedUntil(Math.max(reservedUntil + blockSize, event.seq))
        if (event.seq > reservedUntil) {
          throw new SessionLedgerError('orchestration_write_indeterminate')
        }
      }
      memoryEvents.push(event)
      currentLastSeq = Math.max(currentLastSeq, event.seq)
      const isTerminal =
        event.kind === 'run_settled' || event.kind === 'run_failed' || event.kind === 'run_cancelled'
      if (isTerminal && currentLastSeq >= reservedUntil - proactiveMargin) {
        persistReservedUntil(reservedUntil + blockSize)
      }
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
      }
    }
  }
}
