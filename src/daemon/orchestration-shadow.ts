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
  readonly importComplete: Promise<void>
  startImport(): void
  onLedgerEvent(event: LedgerEvent, meta?: ShadowLedgerEventMeta): void
  close(): void
}

export interface AttachDaemonOrchestrationShadowOptions {
  userDataDir: string
  env: NodeJS.ProcessEnv
  conversationStore: () => ConversationStore
  log: (line: string) => void
  beforeCommitHook?: () => void
  deferredImportThreshold?: number
  pauseDeferredBackfill?: Promise<void>
}

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
  if (mode.effective !== 'shadow') return undefined

  const fullfsync = parseOrchestrationFullfsync(options.env) ?? false
  const checkpointFullfsync = true
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
