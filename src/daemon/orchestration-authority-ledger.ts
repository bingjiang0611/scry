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
import { MemoryLedgerSnapshotTracker } from '../host-runtime/orchestration/legacy-mirror-snapshot'

export interface AuthorityLedgerStoreHandle {
  readonly store: LedgerStore
  readonly mirror: LegacyMirrorWorker
  readonly fileStore: SessionLedgerFileStore
  close(): Promise<void>
}

/**
 * Builds the in-memory-backed `LedgerStore` + zero-drop async `LegacyMirrorWorker` used by
 * `SCRY_ORCHESTRATION=on`. Keeps H1 mirroring off the pre-first-token critical path while
 * synthesizing valid contiguous snapshots on compaction or queue overflow (`seq` never gaps).
 */
export function createAuthorityLedgerStore(options: {
  ledgerDirectory: string
  sink: EventSink
  log: (line: string) => void
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
}): AuthorityLedgerStoreHandle {
  const { ledgerDirectory, sink, log, mirrorWriteHook, mirrorMaxPendingEvents } = options
  const fileStore = new SessionLedgerFileStore(ledgerDirectory)
  const mirrorTargetStore: LedgerStore = mirrorWriteHook
    ? {
        assertAvailable: () => fileStore.assertAvailable(),
        loadAll: () => fileStore.loadAll(),
        loadRecovery: () => fileStore.loadRecovery(),
        shouldCompact: (event) => fileStore.shouldCompact(event),
        compact: (snapshot) => {
          mirrorWriteHook('compact', snapshot.lastSeq)
          fileStore.compact(snapshot)
        },
        append: (event) => {
          mirrorWriteHook('append', event.seq)
          fileStore.append(event)
        }
      }
    : fileStore

  const initial: LedgerRecovery = fileStore.loadRecovery?.() ?? { events: fileStore.loadAll() }
  let currentSnapshot: LedgerSnapshot | undefined = initial.snapshot
  let memoryEvents: LedgerEvent[] = [...initial.events]
  const snapshotTracker = new MemoryLedgerSnapshotTracker(initial)
  const mirror = new LegacyMirrorWorker({
    sink,
    ledgerStore: mirrorTargetStore,
    createSnapshot: () => snapshotTracker.createSnapshot(),
    ...(mirrorMaxPendingEvents !== undefined ? { maxPendingEvents: mirrorMaxPendingEvents } : {}),
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-legacy-mirror-error ${msg}`)
    }
  })

  const store: LedgerStore = {
    assertAvailable: () => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
    },
    loadAll: () => [...(currentSnapshot?.retainedEvents ?? []), ...memoryEvents],
    loadRecovery: () => ({
      ...(currentSnapshot ? { snapshot: structuredClone(currentSnapshot) } : {}),
      events: [...memoryEvents]
    }),
    shouldCompact: (nextEvent) => {
      if ((currentSnapshot?.retainedEvents.length ?? 0) + memoryEvents.length >= 8192) return true
      try {
        return fileStore.shouldCompact(nextEvent)
      } catch {
        return false
      }
    },
    compact: (snapshot) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      // Snapshot MUST be deep-cloned: SessionLedger assigns `this.#events = snapshot.retainedEvents`
      // and pushes subsequent events onto that same array before our async mirror serializes it.
      const frozen = structuredClone(snapshot)
      currentSnapshot = frozen
      memoryEvents = []
      snapshotTracker.applyCompact(frozen)
      mirror.enqueueCompact(frozen)
    },
    append: (event) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      memoryEvents.push(event)
      snapshotTracker.apply(event)
      // Idle-flushed zero-drop H1 mirror (plan §9): ZERO sync file fsync pre-first-token.
      mirror.enqueue(event)
    }
  }

  return {
    store,
    mirror,
    fileStore,
    close: async () => {
      await mirror.close()
      fileStore.close()
    }
  }
}
