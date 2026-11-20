import type { ConversationStore } from '../main/conversation-store'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
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

  // B1-B3: once `on` mode is active, orchestration.db is the sole authority and H1 is a pure
  // downstream mirror; never read H1 on `on`-mode restart so a partial/corrupt H1 can never block startup.
  const alreadyOnActive = sink.getMeta('orchestration_on_active') === '1'
  if (!alreadyOnActive) {
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
      if (plan.lastSeq > 0) {
        const prevReserved = Number(sink.getMeta('h1_seq_reserved_until') ?? '0')
        if (plan.lastSeq > (Number.isFinite(prevReserved) ? prevReserved : 0)) {
          sink.setMeta('h1_seq_reserved_until', String(plan.lastSeq))
        }
      }
      if (plan.unimportedRuns.length > deferredThreshold) {
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
      } else if (plan.unimportedRuns.length > 0 || plan.lastSeq > plan.currentLedgerSeq) {
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
    }
    sink.setMeta('orchestration_on_active', '1')
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
  })

  // core §2.4 + §2.6 + §2.8: recover orchestration.db & two-ledger boundary BEFORE openLocalChannel.
  const recovery = recoverOrchestrationOnStartup({
    sink,
    leaseOwner,
    findRecorderEvidence: createRecorderEvidenceFinder(userDataDir, sink)
  })
  await reconcileTwoLedgersOnStartup({ sink, conversationStore: conversationStore() })

  return { recovery, deferredPlan, importComplete, resolveImportComplete }
}
