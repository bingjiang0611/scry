import { startDeferredLegacyImport } from '../host-runtime/orchestration/legacy-import'
import type { LegacyLedgerPlan } from '../host-runtime/orchestration/legacy-import'
import { LEGACY_H1_IMPORT_COMPLETE } from './orchestration-authority-startup'
import type { createConversationOrdinalResolver } from '../host-runtime/orchestration/conversation-ordinal-lookup'
import type { EventSink } from '../host-runtime/orchestration/event-sink'

/**
 * The deferred legacy import is the one startup step that runs after the authority is usable.
 * It lives here so the authority module stays readable, and it keeps its two rules: a plan is
 * consumed once, and a closed or indeterminate store stops it instead of writing on top of a
 * failed commit.
 */
export interface DeferredImportInput {
  sink: EventSink
  plan: LegacyLedgerPlan
  closed: boolean
  pendingTtlMs: number
  userDataDir: string
  resolveTurnOrdinal: ReturnType<typeof createConversationOrdinalResolver>
  control: { deferredStarted: boolean; setStarted: () => void; cancelDeferred: (() => void) | undefined }
  log: (line: string) => void
  resolveImportComplete: (() => void) | undefined
}

/** Returns false when nothing was started, so the caller keeps the plan for a later call. */
export function runDeferredLegacyImport(input: DeferredImportInput): boolean {
  const { sink, plan, control, log, resolveImportComplete } = input
  if (control.deferredStarted || input.closed || sink.isWriteIndeterminate()) {
    resolveImportComplete?.()
    return false
  }
  control.setStarted()
  const handle = startDeferredLegacyImport({
    sink, userDataDir: input.userDataDir, pendingTtlMs: input.pendingTtlMs,
    reconcileOpenRuns: true, shadowOnly: false, plan, resolveTurnOrdinal: input.resolveTurnOrdinal
  })
  handle.promise
    .then((summary) => {
      if (input.closed || sink.isWriteIndeterminate() || summary.legacyLedgerSeq < plan.lastSeq) return
      sink.setMeta(LEGACY_H1_IMPORT_COMPLETE, '1')
      log(`daemon.orchestration-on-import-done importedRuns=${summary.importedRuns} importedSessions=${summary.importedSessions}`)
    })
    .catch((error) => log(`daemon.orchestration-on-import-failed ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => resolveImportComplete?.())
  return true
}
