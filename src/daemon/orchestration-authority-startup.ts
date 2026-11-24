import type { ConversationStore } from '../main/conversation-store'
import { createConversationProjectionAccess } from './orchestration-conversation-projection'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import { importCatalogEntries } from '../host-runtime/orchestration/legacy-catalog-and-repair'
import {
  importLegacyStateIncrementally,
  loadLegacyLedgerPlanAsync,
  type LegacyLedgerPlan
} from '../host-runtime/orchestration/legacy-import'
import {
  reconcileTwoLedgersOnStartup,
  recoverOrchestrationOnStartup,
  type RecoverOrchestrationSummary
} from '../host-runtime/orchestration/recovery'
import { createRecorderEvidenceFinder } from '../host-runtime/orchestration/recorder-evidence'
import { recordSessionLineage } from './orchestration-lineage'
import { sideChatLineageInput } from './orchestration-side-chat-lineage'

export const LEGACY_H1_IMPORT_COMPLETE = 'legacy_h1_import_complete'

export interface AuthorityStartupResult {
  recovery: RecoverOrchestrationSummary
  deferredPlan: LegacyLedgerPlan | undefined
  importComplete: Promise<void>
  resolveImportComplete: (() => void) | undefined
}

/**
 * Runs P4-2 startup legacy import (only when transitioning from `off`/fresh DB, never reading a
 * degraded H1 downstream mirror once `on` mode is already active), installs Decision G observer,
 * and executes single-tx startup recovery + two-ledger reconciliation BEFORE `openLocalChannel`.
 */
export async function runAuthorityStartupSequence(options: {
  sink: EventSink
  userDataDir: string
  leaseOwner: string
  pendingTtlMs: number
  deferredThreshold: number
  conversationStore: () => ConversationStore
  resolveTurnOrdinal: (sessionKey: string, runId: string) => number | undefined
  log: (line: string) => void
}): Promise<AuthorityStartupResult> {
  const { sink, userDataDir, leaseOwner, pendingTtlMs, deferredThreshold, conversationStore, resolveTurnOrdinal, log } =
    options
  let deferredPlan: LegacyLedgerPlan | undefined
  let resolveImportComplete: (() => void) | undefined
  let importComplete: Promise<void> = Promise.resolve()

  // Before P4-6, active databases had an H1 downstream mirror. Never import it upstream.
  const legacyImported = sink.getMeta('orchestration_on_active') === '1' ||
    sink.getMeta(LEGACY_H1_IMPORT_COMPLETE) === '1'
  if (legacyImported) {
    // Existing authoritative databases may have started with a catalog and no H1 entries.
    if (!sink.getMeta('legacy_catalog_sha256')) importCatalogEntries(sink, userDataDir, Date.now())
  } else {
    let plan: LegacyLedgerPlan | undefined
    try {
      plan = await loadLegacyLedgerPlanAsync(sink, userDataDir)
    } catch (error) {
      // If DB already has authoritative events and H1 is corrupt, fall back to DB authority.
      const hasExistingEvents =
        (sink.handle.db.prepare('SELECT COUNT(*) AS c FROM orch_event').get() as { c: number }).c > 0
      if (!hasExistingEvents) throw error
      log(`daemon.orchestration-on-skip-corrupt-h1 ${error instanceof Error ? error.message : String(error)}`)
    }
    if (plan) {
      if (plan.unimportedRuns.length > deferredThreshold) {
        // The local channel can serve every catalog row while terminal runs backfill.
        importCatalogEntries(sink, userDataDir, Date.now())
        const pendingConvRunIds = new Set<string>()
        try {
          const ownership = await conversationStore().loadOwnership()
          for (const conv of ownership.values()) {
            for (const turn of conv.turns) {
              if (turn.origin === 'dispatch' && turn.delivery.status === 'pending') {
                pendingConvRunIds.add(turn.runId)
              }
            }
          }
        } catch {
          // Corrupt ownership is surfaced by reconcileTwoLedgersOnStartup below.
        }
        importLegacyStateIncrementally({
          sink,
          userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: true,
          shadowOnly: false,
          openOnly: true,
          ...(pendingConvRunIds.size > 0 ? { extraRunIds: pendingConvRunIds } : {}),
          plan,
          resolveTurnOrdinal
        })
        deferredPlan = plan
        importComplete = new Promise<void>((resolve) => {
          resolveImportComplete = resolve
        })
      } else {
        importLegacyStateIncrementally({
          sink,
          userDataDir,
          pendingTtlMs,
          reconcileOpenRuns: true,
          shadowOnly: false,
          plan,
          resolveTurnOrdinal
        })
      }
    } else {
      importCatalogEntries(sink, userDataDir, Date.now())
    }
    if (!deferredPlan) sink.setMeta(LEGACY_H1_IMPORT_COMPLETE, '1')
  }

  // Decision G: install before-turn-settled observer BEFORE reconcileTwoLedgersOnStartup.
  conversationStore().setBeforeTurnSettledObserver((info) => {
    if (sink.isWriteIndeterminate()) return
    const at = Date.now()
    const delivery = info.delivery.status
    const payload = {
      sessionKey: info.conversationId,
      runId: info.runId,
      ordinal: info.ordinal,
      delivery,
      ...(info.delivery.status !== 'accepted' ? { reason: info.delivery.reason } : {}),
      settledAt: at,
      evidence: [`conversation:${info.conversationId}`]
    }
    sink.execute({
      type: 'turn.record_delivery',
      commandId: `effect:p4-conv-${info.conversationId}-${info.runId}:${delivery}`,
      actor: `effect:p4-conv-${info.conversationId}`,
      scope: 'system',
      at,
      payload,
      payloadSha256: sha256Hex(canonicalJson(payload))
    })
    // D3: a side chat has no identity before the Provider answers, so its lineage is recorded on
    // the first delivered turn instead of at creation. An already-attached session is left alone.
    if (info.delivery.status !== 'accepted') return
    const nativeSessionId = info.delivery.nativeSessionId
    if (sink.getSession(nativeSessionId)?.lineage) return
    const lineageInput = sideChatLineageInput(info.conversation, nativeSessionId, {
      parentSessionKeyOf: (conversationId) => sink.getSessionByConversation(conversationId)?.sessionKey
    })
    if (lineageInput) recordSessionLineage(sink, lineageInput, at)
  })

  // core §2.4 + §2.6 + §2.8: recover orchestration.db & two-ledger boundary BEFORE openLocalChannel.
  const recovery = recoverOrchestrationOnStartup({
    sink,
    leaseOwner,
    findRecorderEvidence: createRecorderEvidenceFinder(userDataDir, sink)
  })
  const managed = conversationStore()
  await reconcileTwoLedgersOnStartup({ sink, conversationStore: managed })
  const conversations = await managed.loadOwnership()
  if (conversations.size) createConversationProjectionAccess(() => sink, log).importExisting(conversations.values())

  return { recovery, deferredPlan, importComplete, resolveImportComplete }
}
