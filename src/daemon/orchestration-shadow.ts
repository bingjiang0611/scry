import type { ConversationStore } from '../main/conversation-store'
import type { LedgerEvent } from '../main/remote/session-ledger'
import { recordOrchestrationCommitTiming } from '../main/run-stage-timing'
import {
  importLegacyStateIncrementally,
  peekUnimportedLegacyRunCount,
  startDeferredLegacyImport
} from '../host-runtime/orchestration/legacy-import'
import {
  parseOrchestrationFullfsync,
  parseOrchestrationMode,
  parsePendingTtlMs,
  type OrchestrationModeResolution
} from '../host-runtime/orchestration/mode'
import { ShadowMirror } from '../host-runtime/orchestration/shadow-mirror'

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
  onLedgerEvent(event: LedgerEvent, meta?: { peerCertSHA256?: string; grantScope?: 'local' | 'remote' }): void
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

  const mirror = ShadowMirror.open({
    userDataDir: options.userDataDir,
    fullfsync,
    checkpointFullfsync,
    ...(options.beforeCommitHook ? { beforeCommitHook: options.beforeCommitHook } : {}),
    onCommitTiming: (sample) => {
      recordOrchestrationCommitTiming({ ...sample, fullfsync })
    },
    onError: (error) => {
      const msg = error instanceof Error ? error.message : String(error)
      options.log(`daemon.orchestration-shadow-fail-open ${msg}`)
    }
  })

  let needsDeferredBackfill = false
  let deferredStarted = false
  let cancelDeferred: (() => void) | undefined
  let resolveImportComplete: (() => void) | undefined
  let importComplete: Promise<void> = Promise.resolve()

  if (mirror.sink && !mirror.stats().failedOpen) {
    try {
      const pendingCount = peekUnimportedLegacyRunCount(mirror.sink, options.userDataDir)
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
          openOnly: true
        })
        mirror.recordImportRejections(openImported.rejectedCommands)
        if (mirror.sink.isWriteIndeterminate()) {
          mirror.markFailedOpen(new Error('orchestration_write_indeterminate'))
        } else {
          mirror.setDeferringLegacyWatermark(true)
          needsDeferredBackfill = true
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
          shadowOnly: true
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

  const startImport = (): void => {
    if (!needsDeferredBackfill || deferredStarted || !mirror.sink || mirror.stats().failedOpen) {
      resolveImportComplete?.()
      return
    }
    deferredStarted = true
    const handle = startDeferredLegacyImport({
      sink: mirror.sink,
      userDataDir: options.userDataDir,
      pendingTtlMs,
      reconcileOpenRuns: false,
      shadowOnly: true
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
      cancelDeferred?.()
      resolveImportComplete?.()
      options.conversationStore().setTurnSettledObserver(undefined)
      mirror.close()
    }
  }
}
