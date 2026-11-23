import { createConversationOrdinalResolver, type TurnOrdinalResolver } from './conversation-ordinal-lookup'
import type { EventSink } from './event-sink'
import { importCatalogEntries, repairMissingShadowBodies } from './legacy-catalog-and-repair'
import {
  loadLegacyLedgerPlan,
  loadLegacyLedgerPlanAsync,
  peekUnimportedLegacyRunCount,
  type LegacyLedgerPlan,
  type LegacyRunState
} from './legacy-ledger-reader'
import { importSingleRun } from './legacy-import-run'
import { parseLedgerIntentRouting } from './shadow-routing'
import { DEFAULT_PENDING_TTL_MS } from './types'
import { WalCheckpointWorker } from './wal-checkpoint-worker'

export {
  loadLegacyLedgerPlan,
  loadLegacyLedgerPlanAsync,
  peekUnimportedLegacyRunCount,
  repairMissingShadowBodies,
  type LegacyLedgerPlan
}

export interface LegacyImportOptions {
  sink: EventSink
  userDataDir: string
  now?: number
  pendingTtlMs?: number
  /**
   * When `false` (P4-1 shadow default), open runs (`recorded`/`dispatched`) are imported faithfully
   * at their ledger state so H1 `recover()` / `pump()` drive their final state through `onLedgerEvent`
   * without `illegal_transition` divergence. When `true` (P4-2 authoritative mode), open runs are
   * reconciled per plan §9 rule 1 (`interrupted` / `pending_expired`).
   */
  reconcileOpenRuns?: boolean
  /** Mark imported outbox rows `done` (`shadowOnly`) so P4-2 recovery never dispatches them. */
  shadowOnly?: boolean
  /** Number of legacy runs / sessions committed per SQLite transaction (default 500). */
  batchSize?: number
  /**
   * When `true`, imports only non-terminal (`recorded`/`dispatched`) runs without advancing
   * `legacy_ledger_seq`, allowing huge historical terminal ledgers to be backfilled after
   * `openLocalChannel` without blocking daemon startup.
   */
  openOnly?: boolean
  /** Extra runIds (e.g. pending conversation turns) to import synchronously alongside `openOnly`. */
  extraRunIds?: ReadonlySet<string>
  /** Pre-parsed ledger plan from `loadLegacyLedgerPlan` to avoid redundant full-ledger parses. */
  plan?: LegacyLedgerPlan
  /** Authoritative H3 ordinal lookup for pre-fix ledger intents lacking `conversation.ordinal`. */
  resolveTurnOrdinal?: TurnOrdinalResolver
  /** Time budget (ms) per yielding slice in `startDeferredLegacyImport` (default 8 ms). */
  maxSliceMs?: number
  /** Runs between periodic PASSIVE checkpoints during deferred backfill (default 500). */
  walCheckpointRuns?: number
  /** WAL size threshold (bytes) to trigger an early PASSIVE checkpoint when `-wal` grows past it (default 16 MiB). */
  walCheckpointBytes?: number
  /** Hard WAL size cap (bytes) to trigger a TRUNCATE checkpoint reclaiming `-wal` disk space (default 64 MiB). */
  walHardCapBytes?: number
}

export interface LegacyImportSummary {
  importedRuns: number
  importedSessions: number
  rejectedCommands: number
  legacyLedgerSeq: number
  catalogSha256: string
}

/**
 * plan §9 rule 1: idempotent, batched incremental import of H1 `SessionLedger` (entries with
 * `seq > orch_meta.legacy_ledger_seq`) and `app-sessions.json` (when sha256 differs from
 * `orch_meta.legacy_catalog_sha256`).
 */
export function importLegacyStateIncrementally(options: LegacyImportOptions): LegacyImportSummary {
  const { sink, userDataDir } = options
  const now = options.now ?? Date.now()
  const pendingTtlMs = Math.min(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS)
  const reconcileOpenRuns = options.reconcileOpenRuns ?? false
  const shadowOnly = options.shadowOnly ?? !reconcileOpenRuns
  const batchSize = Math.max(1, options.batchSize ?? 500)
  const openOnly = options.openOnly ?? false
  const resolveTurnOrdinal = options.resolveTurnOrdinal ?? createConversationOrdinalResolver(userDataDir)
  const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')

  let importedRuns = 0
  let rejectedCommands = 0
  const plan = options.plan ?? loadLegacyLedgerPlan(sink, userDataDir)
  let currentLedgerSeq = plan.currentLedgerSeq

  if (plan.lastSeq > currentLedgerSeq) {
    let sortedRuns = openOnly ? plan.openRuns : plan.unimportedRuns
    if (openOnly && options.extraRunIds && options.extraRunIds.size > 0) {
      const included = new Set(sortedRuns.map((r) => r.ledgerRunId))
      const extra: LegacyRunState[] = []
      for (const run of plan.unimportedRuns) {
        if (included.has(run.ledgerRunId)) continue
        const routing = parseLedgerIntentRouting(run.ledgerRunId, run.detail)
        if (options.extraRunIds.has(run.ledgerRunId) || options.extraRunIds.has(routing.canonicalRunId)) {
          extra.push(run)
          included.add(run.ledgerRunId)
        }
      }
      if (extra.length > 0) {
        sortedRuns = [...sortedRuns, ...extra].sort((a, b) => a.intentSeq - b.intentSeq)
      }
    }
    for (let offset = 0; offset < sortedRuns.length; offset += batchSize) {
      const chunk = sortedRuns.slice(offset, offset + batchSize)
      const isLastChunk = offset + batchSize >= sortedRuns.length
      sink.runInBatchTransaction(() => {
        for (const run of chunk) {
          const delta = importSingleRun(sink, stmtLegacyMapping, run, {
            now,
            pendingTtlMs,
            reconcileOpenRuns,
            shadowOnly,
            resolveTurnOrdinal
          })
          importedRuns += delta.imported
          rejectedCommands += delta.rejected
        }
        if (isLastChunk && !openOnly) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
      })
    }
    if (sortedRuns.length === 0 && !openOnly) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
    if (!openOnly) currentLedgerSeq = plan.lastSeq
  }

  if (openOnly) {
    return {
      importedRuns,
      importedSessions: 0,
      rejectedCommands,
      legacyLedgerSeq: currentLedgerSeq,
      catalogSha256: sink.getMeta('legacy_catalog_sha256') ?? ''
    }
  }

  const catalog = importCatalogEntries(sink, userDataDir, now, batchSize)
  return {
    importedRuns,
    importedSessions: catalog.importedSessions,
    rejectedCommands: rejectedCommands + catalog.rejectedCommands,
    legacyLedgerSeq: currentLedgerSeq,
    catalogSha256: catalog.catalogSha256
  }
}

/**
 * Yields between 100-run batches via `setImmediate` so large historical backfills (up to H1's
 * 100k snapshot cap) never block `openLocalChannel` or starve incoming daemon socket requests.
 */
export function startDeferredLegacyImport(
  options: Omit<LegacyImportOptions, 'openOnly'>
): { promise: Promise<LegacyImportSummary>; cancel(): void } {
  let cancelled = false
  let pendingTimer: NodeJS.Immediate | null = null
  let settleOnCancel: (() => void) | null = null
  const { sink, userDataDir } = options
  const now = options.now ?? Date.now()
  const pendingTtlMs = Math.min(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, DEFAULT_PENDING_TTL_MS)
  const reconcileOpenRuns = options.reconcileOpenRuns ?? false
  const shadowOnly = options.shadowOnly ?? !reconcileOpenRuns
  const batchSize = Math.max(1, options.batchSize ?? 100)
  const maxSliceMs = Math.max(1, options.maxSliceMs ?? 4)
  const walCheckpointRuns = Math.max(50, options.walCheckpointRuns ?? 200)
  const walCheckpointBytes = Math.max(256 * 1024, options.walCheckpointBytes ?? 12 * 1024 * 1024)
  const walHardCapBytes = Math.max(walCheckpointBytes * 2, options.walHardCapBytes ?? 28 * 1024 * 1024)
  const resolveTurnOrdinal = options.resolveTurnOrdinal ?? createConversationOrdinalResolver(userDataDir)

  const promise = new Promise<LegacyImportSummary>((resolve, reject) => {
    const plan = options.plan ?? loadLegacyLedgerPlan(sink, userDataDir)
    let currentLedgerSeq = plan.currentLedgerSeq
    const sortedRuns = plan.unimportedRuns
    const stmtLegacyMapping = sink.handle.db.prepare('SELECT run_id FROM orch_legacy_run WHERE ledger_run_id = ?')
    const ckptWorker = sortedRuns.length > 0 ? WalCheckpointWorker.start(sink) : null

    let offset = 0
    let importedRuns = 0
    let rejectedCommands = 0
    let runsSinceCheckpoint = 0
    let walBytesAtLastCheckpoint = sink.walFileBytes()
    let settled = false

    const cleanupWorker = async (): Promise<void> => {
      if (ckptWorker) await ckptWorker.close()
    }

    const finish = (summary: LegacyImportSummary): void => {
      if (settled) return
      settled = true
      if (pendingTimer) {
        clearImmediate(pendingTimer)
        pendingTimer = null
      }
      void cleanupWorker().finally(() => resolve(summary))
    }

    settleOnCancel = () => {
      finish({
        importedRuns,
        importedSessions: 0,
        rejectedCommands,
        legacyLedgerSeq: currentLedgerSeq,
        catalogSha256: ''
      })
    }

    const scheduleNext = (): void => {
      if (cancelled || settled) return
      pendingTimer = setImmediate(step)
    }

    const step = (): void => {
      pendingTimer = null
      if (cancelled || sink.isWriteIndeterminate() || !sink.handle.db.open) {
        finish({
          importedRuns,
          importedSessions: 0,
          rejectedCommands,
          legacyLedgerSeq: currentLedgerSeq,
          catalogSha256: ''
        })
        return
      }
      try {
        if (offset < sortedRuns.length) {
          const sliceStart = performance.now()
          let processed = 0
          sink.runInBatchTransaction(() => {
            while (offset < sortedRuns.length && processed < batchSize) {
              const run = sortedRuns[offset++]!
              const delta = importSingleRun(sink, stmtLegacyMapping, run, {
                now,
                pendingTtlMs,
                reconcileOpenRuns,
                shadowOnly,
                resolveTurnOrdinal
              })
              importedRuns += delta.imported
              rejectedCommands += delta.rejected
              processed += 1
              if (performance.now() - sliceStart >= maxSliceMs) break
            }
            if (offset >= sortedRuns.length) sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
          })
          runsSinceCheckpoint += processed
          if (offset >= sortedRuns.length) currentLedgerSeq = plan.lastSeq
          const walSize = sink.walFileBytes()
          // Off-main-thread WAL checkpointing (W9 Must-Fix 1): fire non-blocking PASSIVE
          // checkpoints on the worker connection so main-thread event loop & live commits never stall.
          // Apply async backpressure to backfill slicing (not live commits) when WAL reaches soft/hard caps.
          if (ckptWorker && walSize >= walHardCapBytes) {
            runsSinceCheckpoint = 0
            void ckptWorker
              .waitInFlight()
              .then(() => ckptWorker.request('passive'))
              .then(() => {
                walBytesAtLastCheckpoint = sink.walFileBytes()
                scheduleNext()
              })
            return
          }
          if (ckptWorker && walSize >= walCheckpointBytes && ckptWorker.isBusy()) {
            void ckptWorker.waitInFlight().then(() => {
              walBytesAtLastCheckpoint = sink.walFileBytes()
              scheduleNext()
            })
            return
          }
          if (
            ckptWorker &&
            !ckptWorker.isBusy() &&
            (runsSinceCheckpoint >= walCheckpointRuns ||
              walSize >= Math.max(walCheckpointBytes, walBytesAtLastCheckpoint + walCheckpointBytes))
          ) {
            runsSinceCheckpoint = 0
            void ckptWorker.request('passive').then(() => {
              walBytesAtLastCheckpoint = sink.walFileBytes()
            })
          }
          scheduleNext()
          return
        }
        if (plan.lastSeq > currentLedgerSeq) {
          sink.setMeta('legacy_ledger_seq', String(plan.lastSeq))
          currentLedgerSeq = plan.lastSeq
        }
        const catalog = importCatalogEntries(sink, userDataDir, now, batchSize)
        const finalSummary: LegacyImportSummary = {
          importedRuns,
          importedSessions: catalog.importedSessions,
          rejectedCommands: rejectedCommands + catalog.rejectedCommands,
          legacyLedgerSeq: currentLedgerSeq,
          catalogSha256: catalog.catalogSha256
        }
        if (ckptWorker) {
          void ckptWorker
            .waitInFlight()
            .then(() => (sink.walFileBytes() >= walCheckpointBytes ? ckptWorker.request('passive') : null))
            .then(() => finish(finalSummary))
          return
        }
        finish(finalSummary)
      } catch (error) {
        if (!settled) {
          settled = true
          void cleanupWorker().finally(() => reject(error))
        }
      }
    }

    scheduleNext()
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      settleOnCancel?.()
    }
  }
}
