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
import { buildH1SnapshotFromDb, getMaxOrchEventSeq } from '../host-runtime/orchestration/legacy-snapshot-builder'

export interface AuthorityLedgerStoreHandle {
  readonly store: LedgerStore
  readonly mirror: LegacyMirrorWorker
  readonly fileStore?: SessionLedgerFileStore
  syncSnapshotFromDb(): void
  close(): Promise<void>
}

/**
 * Builds the DB-authoritative in-memory `LedgerStore` + pure downstream async `LegacyMirrorWorker`
 * used by `SCRY_ORCHESTRATION=on` (W9 Round-3 B1-B3 fix).
 * - Startup ALWAYS rebuilds device-facing `SessionLedger` strictly from `orchestration.db` (never
 *   reads H1 files), so partial writes, duplicate seqs, or SIGKILL mirror lag can never corrupt
 *   or roll back `on`-mode restarts.
 * - H1 file store is strictly downstream: on any write failure, `LegacyMirrorWorker` atomically
 *   rewrites H1 from a DB-built snapshot; if rewrite also fails, H1 fallback is marked unavailable
 *   while `on` mode continues uninterrupted.
 */
export function createAuthorityLedgerStore(options: {
  ledgerDirectory: string
  sink: EventSink
  log: (line: string) => void
  mirrorWriteHook?: (op: 'append' | 'compact', seq: number) => void
  mirrorMaxPendingEvents?: number
}): AuthorityLedgerStoreHandle {
  const { ledgerDirectory, sink, log, mirrorWriteHook, mirrorMaxPendingEvents } = options

  let fileStore: SessionLedgerFileStore | undefined
  try {
    fileStore = new SessionLedgerFileStore(ledgerDirectory)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    log(`daemon.orchestration-h1-fallback-unavailable ${msg}`)
  }

  const mirrorTargetStore: LedgerStore | undefined = !fileStore
    ? undefined
    : mirrorWriteHook
      ? {
          assertAvailable: () => fileStore!.assertAvailable(),
          loadAll: () => fileStore!.loadAll(),
          loadRecovery: () => fileStore!.loadRecovery(),
          shouldCompact: (event) => fileStore!.shouldCompact(event),
          compact: (snapshot) => {
            mirrorWriteHook('compact', snapshot.lastSeq)
            fileStore!.compact(snapshot)
          },
          append: (event) => {
            mirrorWriteHook('append', event.seq)
            fileStore!.append(event)
          }
        }
      : fileStore

  // B1-B3: ALWAYS rebuild initial device-facing ledger state strictly from orchestration.db.
  const initialSnapshot = buildH1SnapshotFromDb(sink)
  const maxOrchSeq = getMaxOrchEventSeq(sink)
  const desiredOffset = Math.max(0, initialSnapshot.lastSeq - maxOrchSeq)
  const existingOffset = Number(sink.getMeta('h1_seq_offset') ?? '0')
  if (!sink.isWriteIndeterminate() && desiredOffset > (Number.isFinite(existingOffset) ? existingOffset : 0)) {
    sink.setMeta('h1_seq_offset', String(desiredOffset))
  }

  let currentSnapshot: LedgerSnapshot = initialSnapshot
  let memoryEvents: LedgerEvent[] = []
  let currentLastSeq = initialSnapshot.lastSeq
  let persistedSeqFloor = Math.max(
    initialSnapshot.lastSeq,
    Number(sink.getMeta('h1_seq_floor') ?? '0') || 0
  )

  const persistSeqFloor = (seq: number): void => {
    if (seq <= persistedSeqFloor || sink.isWriteIndeterminate() || !sink.handle.db.open) return
    try {
      sink.setMeta('h1_seq_floor', String(seq))
      persistedSeqFloor = seq
    } catch {
      // Ignore if sink fenced.
    }
  }

  const mirror = new LegacyMirrorWorker({
    sink,
    ...(mirrorTargetStore ? { ledgerStore: mirrorTargetStore } : {}),
    createSnapshot: () => buildH1SnapshotFromDb(sink, { minLastSeq: currentLastSeq }),
    ...(mirrorMaxPendingEvents !== undefined ? { maxPendingEvents: mirrorMaxPendingEvents } : {}),
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-legacy-mirror-error ${msg}`)
    },
    onH1FallbackUnavailable: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      log(`daemon.orchestration-h1-fallback-unavailable reason=${msg}`)
    }
  })

  // Self-heal degraded/lagging H1 downstream mirror asynchronously after restart if needed.
  if (fileStore && (sink.getMeta('h1_fallback_unavailable') === '1' || initialSnapshot.runs.length > 0)) {
    mirror.enqueueCompact(initialSnapshot)
  }

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
      if (!fileStore || mirror.isH1FallbackUnavailable()) return false
      try {
        return fileStore.shouldCompact(nextEvent)
      } catch {
        return false
      }
    },
    compact: (snapshot) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      const frozen = structuredClone(snapshot)
      currentSnapshot = frozen
      memoryEvents = []
      currentLastSeq = Math.max(currentLastSeq, frozen.lastSeq)
      persistSeqFloor(currentLastSeq)
      mirror.enqueueCompact(buildH1SnapshotFromDb(sink, { minLastSeq: currentLastSeq }))
    },
    append: (event) => {
      if (sink.isWriteIndeterminate()) throw new SessionLedgerError('orchestration_write_indeterminate')
      memoryEvents.push(event)
      currentLastSeq = Math.max(currentLastSeq, event.seq)
      // Persist H1 seq floor off the pre-first-token hot path so opaque progress/terminal events
      // never allow seq to regress across restarts even when H1 mirror is degraded (B2).
      if (event.kind !== 'intent_recorded' && event.kind !== 'run_dispatched') {
        persistSeqFloor(currentLastSeq)
      }
      // Downstream pure mirror (plan §9): ZERO sync file fsync pre-first-token.
      mirror.enqueue(event)
    }
  }

  return {
    store,
    mirror,
    fileStore,
    syncSnapshotFromDb: () => {
      if (!fileStore || sink.isWriteIndeterminate() || !sink.handle.db.open) return
      const snap = buildH1SnapshotFromDb(sink, { minLastSeq: currentLastSeq })
      currentLastSeq = Math.max(currentLastSeq, snap.lastSeq)
      persistSeqFloor(currentLastSeq)
      mirror.enqueueCompact(snap)
    },
    close: async () => {
      persistSeqFloor(currentLastSeq)
      await mirror.close()
      try {
        fileStore?.close()
      } catch {
        // Preserve clean shutdown even if H1 store was degraded.
      }
    }
  }
}
