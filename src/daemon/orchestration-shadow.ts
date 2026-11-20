import type { ConversationStore } from '../main/conversation-store'
import type { LedgerEvent } from '../main/remote/session-ledger'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import { createConversationOrdinalResolver } from '../host-runtime/orchestration/conversation-ordinal-lookup'
import {
  importLegacyStateIncrementally,
  loadLegacyLedgerPlan,
  repairMissingShadowBodies,
  startDeferredLegacyImport,
  type LegacyLedgerPlan
} from '../host-runtime/orchestration/legacy-import'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs,
  type OrchestrationModeResolution
} from '../host-runtime/orchestration/mode'
import { ShadowMirror, type ShadowLedgerEventMeta } from '../host-runtime/orchestration/shadow-mirror'

const DEFAULT_DEFERRED_IMPORT_THRESHOLD = 2_000

export interface DaemonOrchestrationShadow {
  readonly mode: OrchestrationModeResolution
  readonly fullfsync: boolean
  readonly checkpointFullfsync: boolean
  readonly mirror: ShadowMirror
  /** Resolves once initial (or deferred post-socket) legacy import has finished. */
  readonly importComplete: Promise<void>
  /** Starts deferred historical backfill after `openLocalChannel` when ledger exceeds sync threshold. */
  startImport(): void
  onLedgerEvent(event: LedgerEvent, meta?: ShadowLedgerEventMeta): void
  close(): void
}

export interface AttachDaemonOrchestrationShadowOptions {
  userDataDir: string
  env: NodeJS.ProcessEnv
  conversationStore: () => ConversationStore
  log: (line: string) => void
  /** Test seam: inject a commit failure into the shadow EventSink. */
  beforeCommitHook?: () => void
  /** Unimported run threshold above which historical backfill defers until after `openLocalChannel`. */
  deferredImportThreshold?: number
  /** Test seam: pause deferred backfill after `openLocalChannel` until this promise resolves. */
  pauseDeferredBackfill?: Promise<void>
}

/**
 * Isolated daemon hook for P4-1 shadow writes + off<->shadow incremental import.
 * Kept in its own module so `src/daemon/host-process.ts` stays minimal and free of conflicts.
 */
export function attachDaemonOrchestrationShadow(
  options: AttachDaemonOrchestrationShadowOptions
): DaemonOrchestrationShadow | undefined {
  const mode = parseOrchestrationMode(options.env)
  if (mode.refused) {
    options.log(
      `daemon.orchestration-refused requested=${mode.requested} reason=${mode.reason ?? 'unsupported'}`
    )
    return undefined
  }
  if (mode.effective === 'off') return undefined

  // Maintainer decision (2026-11-19): P4-1 explicitly fixes fullfsync=OFF + checkpoint_fullfsync=ON
  // even when env vars are unset; final fullfsync decision is deferred to P4-2.
  const fullfsync = parseOrchestrationFullfsync(options.env) ?? false
  const checkpointFullfsync = !fullfsync
  const pendingTtlMs = parsePendingTtlMs(options.env)
  const deferredThreshold = options.deferredImportThreshold ?? DEFAULT_DEFERRED_IMPORT_THRESHOLD

  const resolveTurnOrdinal = createConversationOrdinalResolver(options.userDataDir)
  const mirror = ShadowMirror.open({
    userDataDir: options.userDataDir,
    fullfsync,
    checkpointFullfsync,
    resolveTurnOrdinal,
    ...(options.beforeCommitHook ? { beforeCommitHook: options.beforeCommitHook } : {}),
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, fullfsync })
    },
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      options.log(`daemon.orchestration-shadow-fail-open ${msg}`)
    }
  })

  let deferredPlan: LegacyLedgerPlan | undefined
  let deferredStarted = false
  let cancelDeferred: (() => void) | undefined
  let resolveImportComplete: (() => void) | undefined
  let importComplete: Promise<void> = Promise.resolve()

  if (mirror.sink && !mirror.stats().failedOpen) {
    try {
      // Parse H1 snapshot+log ONCE and reuse the plan across missing-body repair, threshold check,
      // open-run sync import, and post-socket deferred backfill (no redundant parses).
      const plan = loadLegacyLedgerPlan(mirror.sink, options.userDataDir)
      const bodyRepair = repairMissingShadowBodies(mirror.sink, plan)
      if (bodyRepair.repaired > 0 || bodyRepair.stillMissing > 0) {
        mirror.recordMissingBodies(bodyRepair.stillMissing)
        options.log(
          `daemon.orchestration-shadow-body-repair repaired=${bodyRepair.repaired} missing=${bodyRepair.stillMissing}`
        )
      }
      const pendingCount = plan.unimportedRuns.length
      if (pendingCount > deferredThreshold) {
        // Large ledger (> 2,000 unimported runs): synchronously import only open runs before
        // `service.start()` so H1 `recover()` has zero invalid_target deviations, then backfill
        // historical terminal runs in yielding batches after `openLocalChannel`.
        const openImported = importLegacyStateIncrementally({
          sink: mirror.sink,
          userDataDir: options.userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: false,
          shadowOnly: true,
          openOnly: true,
          plan,
          resolveTurnOrdinal
        })
        mirror.recordImportRejections(openImported.rejectedCommands)
        if (mirror.sink.isWriteIndeterminate()) {
          mirror.markFailedOpen(new Error('orchestration_write_indeterminate'))
        } else {
          mirror.setDeferringLegacyWatermark(true)
          deferredPlan = plan
          importComplete = new Promise<void>((resolve) => {
            resolveImportComplete = resolve
          })
          options.log(
            `daemon.orchestration-shadow-deferred-import pendingRuns=${pendingCount} importedOpenRuns=${openImported.importedRuns}`
          )
        }
      } else {
        const imported = importLegacyStateIncrementally({
          sink: mirror.sink,
          userDataDir: options.userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: false,
          shadowOnly: true,
          plan,
          resolveTurnOrdinal
        })
        mirror.recordImportRejections(imported.rejectedCommands)
        if (mirror.sink.isWriteIndeterminate()) {
          mirror.markFailedOpen(new Error('orchestration_write_indeterminate'))
        } else {
          options.log(
            `daemon.orchestration-shadow-ready mode=${mode.requested}/${mode.effective} fullfsync=${String(fullfsync)} checkpointFullfsync=${String(checkpointFullfsync)} importedRuns=${imported.importedRuns} importedSessions=${imported.importedSessions}`
          )
        }
      }
    } catch (error) {
      mirror.markFailedOpen(error)
      const msg = error instanceof Error ? error.message : String(error)
      options.log(`daemon.orchestration-shadow-import-failed ${msg}`)
    }
  }

  let closed = false
  const startImport = (): void => {
    if (!deferredPlan || deferredStarted || !mirror.sink || mirror.stats().failedOpen) {
      resolveImportComplete?.()
      return
    }
    deferredStarted = true
    const plan = deferredPlan
    deferredPlan = undefined
    const launch = (): void => {
      if (closed || !mirror.sink || mirror.stats().failedOpen) {
        resolveImportComplete?.()
        return
      }
      const handle = startDeferredLegacyImport({
        sink: mirror.sink,
        userDataDir: options.userDataDir,
        pendingTtlMs,
        reconcileOpenRuns: false,
        shadowOnly: true,
        plan,
        resolveTurnOrdinal
      })
      cancelDeferred = handle.cancel
      handle.promise
        .then((summary) => {
          mirror.recordImportRejections(summary.rejectedCommands)
          if (mirror.sink?.isWriteIndeterminate()) {
            mirror.markFailedOpen(new Error('orchestration_write_indeterminate'))
          } else {
            mirror.setDeferringLegacyWatermark(false, summary.legacyLedgerSeq)
            options.log(
              `daemon.orchestration-shadow-ready mode=${mode.requested}/${mode.effective} fullfsync=${String(fullfsync)} checkpointFullfsync=${String(checkpointFullfsync)} importedRuns=${summary.importedRuns} importedSessions=${summary.importedSessions}`
            )
          }
        })
        .catch((error) => {
          mirror.markFailedOpen(error)
          const msg = error instanceof Error ? error.message : String(error)
          options.log(`daemon.orchestration-shadow-import-failed ${msg}`)
        })
        .finally(() => {
          resolveImportComplete?.()
        })
    }
    if (options.pauseDeferredBackfill) {
      void options.pauseDeferredBackfill.then(launch, launch)
    } else {
      launch()
    }
  }

  options.conversationStore().setTurnSettledObserver((info) => {
    mirror.onConversationTurnSettled(info)
  })

  return {
    mode,
    fullfsync,
    checkpointFullfsync,
    mirror,
    importComplete,
    startImport,
    onLedgerEvent: (event, meta) => mirror.onLedgerEvent(event, meta),
    close: () => {
      closed = true
      cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setTurnSettledObserver(undefined)
      mirror.close()
    }
  }
}
