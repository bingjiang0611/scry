import { randomUUID } from 'node:crypto'
import { TERMINAL_RUN_LIFECYCLES } from './run-transitions'
import type { ConversationStore } from '../../main/conversation-store'
import { canonicalJson, sha256Hex } from './canonical-json'
import { findEffectPolicy } from './effect-policy'
import type { EventSink } from './event-sink'

export interface RecorderTerminalEvidence {
  outcome: 'settled' | 'failed'
  settledAt: number
  reason?: string
  contentRef?: string
  outputSeq?: number
  evidence: string[]
}

export interface RecoverOrchestrationOptions {
  sink: EventSink
  leaseOwner: string
  now?: number
  /** Optional recorder-evidence lookup for dispatched runs across crashes (core §2.4). */
  findRecorderEvidence?: (runId: string) => RecorderTerminalEvidence | undefined
}

export interface RecoverOrchestrationSummary {
  dispatchablePendingRunIds: string[]
  cancelledPending: number
  cancelledClaimed: number
  interruptedDispatched: number
  settledFromEvidence: number
  closedOpenQuestions: number
  voidedProcessBoundEffects: number
  requeuedReplayableEffects: number
  failedUnknownEffects: number
}

/**
 * P4-2 startup recovery (core §2.4 + §2.6): runs AFTER `runStartupRecovery` and BEFORE
 * `openLocalChannel` in a single atomic transaction so every stale outbox row, undispatched
 * claim, dispatched run, and open interaction converges before clients connect.
 */
export function recoverOrchestrationOnStartup(
  options: RecoverOrchestrationOptions
): RecoverOrchestrationSummary {
  const { sink, leaseOwner } = options
  const now = options.now ?? Date.now()
  const db = sink.handle.db

  const summary: RecoverOrchestrationSummary = {
    dispatchablePendingRunIds: [],
    cancelledPending: 0,
    cancelledClaimed: 0,
    interruptedDispatched: 0,
    settledFromEvidence: 0,
    closedOpenQuestions: 0,
    voidedProcessBoundEffects: 0,
    requeuedReplayableEffects: 0,
    failedUnknownEffects: 0
  }

  sink.runInBatchTransaction(() => {
    const startPayload = { leaseOwner }
    sink.execute({
      type: 'host.start',
      commandId: `host-start:${leaseOwner}:${now}`,
      actor: 'system',
      scope: 'system',
      at: now,
      payload: startPayload,
      payloadSha256: sha256Hex(canonicalJson(startPayload))
    })

    const failUnknown = db.prepare(
      "UPDATE orch_outbox SET state = 'failed', lease_owner = NULL, claimed_at = NULL, completed_at = ?, last_error = ? WHERE effect_id = ?"
    )
    const updateOutbox = db.prepare(
      'UPDATE orch_outbox SET state = ?, lease_owner = ?, claimed_at = ?, completed_at = ? WHERE effect_id = ?'
    )
    const insertEffectVoided = db.prepare(
      `INSERT INTO orch_event (
        event_id, at, type, stream, session_key, run_id, cwd, command_id,
        actor, scope, payload, evidence, principal, via, actor_run_id
      ) VALUES (?, ?, 'effect.voided', ?, ?, ?, ?, NULL, 'system', 'system', ?, NULL, 'system', NULL, NULL)`
    )
    const readIntentEvent = db.prepare('SELECT at, actor, payload FROM orch_event WHERE seq = ?')

    const cancelRun = (runId: string, reason: string): void => {
      const payload = {
        runId,
        step: 'cancelled' as const,
        reason,
        delivery: 'not_sent' as const,
        outcome: {
          status: 'unavailable' as const,
          quality: 'unavailable' as const,
          source: ['host.recovery'],
          omissionReason: reason
        },
        evidence: ['host.recovery']
      }
      sink.execute({
        type: 'run.effect_result',
        commandId: `effect:recovery-${runId}:cancelled:${reason}`,
        actor: `effect:recovery-${runId}`,
        scope: 'system',
        at: now,
        payload,
        payloadSha256: sha256Hex(canonicalJson(payload))
      })
    }

    for (const row of sink.listOutbox()) {
      if (row.state !== 'pending' && row.state !== 'running') continue
      const spec = findEffectPolicy(row.kind)
      if (!spec) {
        // A4: unknown kind must not block startup. Park the row as failed with its kind recorded.
        failUnknown.run(now, `unregistered_effect_kind:${row.kind}`, row.effectId)
        summary.failedUnknownEffects += 1
        continue
      }

      if (spec.onRestart === 'void') {
        updateOutbox.run('voided', null, null, now, row.effectId)
        summary.voidedProcessBoundEffects += 1
        continue
      }

      if (spec.onRestart === 'requeue') {
        if (row.state === 'running') {
          updateOutbox.run('pending', null, null, null, row.effectId)
          summary.requeuedReplayableEffects += 1
        }
        continue
      }

      // provider.run.start (run_start_reconcile)
      if (!row.runId) {
        updateOutbox.run('voided', null, null, now, row.effectId)
        continue
      }
      const run = sink.getRun(row.runId)
      if (!run || TERMINAL_RUN_LIFECYCLES.has(run.lifecycle)) {
        updateOutbox.run('done', row.leaseOwner, row.claimedAt, now, row.effectId)
        continue
      }

      if (row.state === 'pending') {
        const intentRow = readIntentEvent.get(run.intentSeq) as
          | { at: number; actor: string; payload: string }
          | undefined
        const intentAt = intentRow?.at ?? now
        const intentActor = intentRow?.actor ?? run.ownerActor
        const intentPayload = intentRow ? (JSON.parse(intentRow.payload) as { isConversationRun?: boolean }) : {}
        const isConversationRun = Boolean(intentPayload.isConversationRun)

        if (intentActor.startsWith('agent:')) {
          updateOutbox.run('voided', null, null, now, row.effectId)
          cancelRun(run.runId, 'caller_run_gone')
          summary.cancelledPending += 1
        } else if (isConversationRun) {
          updateOutbox.run('voided', null, null, now, row.effectId)
          cancelRun(run.runId, 'conversation_start_unavailable')
          summary.cancelledPending += 1
        } else if (now < intentAt || (row.expiresAt !== null && now > row.expiresAt)) {
          updateOutbox.run('voided', null, null, now, row.effectId)
          cancelRun(run.runId, 'pending_expired')
          summary.cancelledPending += 1
        } else {
          summary.dispatchablePendingRunIds.push(run.runId)
        }
        continue
      }

      // row.state === 'running'
      if (run.lifecycle === 'queued') {
        // D1: the process died between claiming a queue entry and deferring it. Marking the effect done
        // would leave the run `queued` with nothing left to dispatch it — the session would never move.
        updateOutbox.run('pending', null, null, null, row.effectId)
        summary.requeuedReplayableEffects += 1
        continue
      }
      if (run.lifecycle === 'recorded') {
        // Claimed without run.dispatched -> void effect + cancel (host_restarted_before_dispatch)
        insertEffectVoided.run(
          randomUUID(),
          now,
          `run:${run.runId}`,
          run.sessionKey,
          run.runId,
          run.cwd,
          canonicalJson({ effectId: row.effectId, kind: row.kind, reason: 'host_restarted_before_dispatch' })
        )
        updateOutbox.run('voided', null, null, now, row.effectId)
        cancelRun(run.runId, 'host_restarted_before_dispatch')
        summary.cancelledClaimed += 1
      } else {
        updateOutbox.run('done', row.leaseOwner, row.claimedAt, now, row.effectId)
      }
    }

    // Reconcile every run left in `admitted` or `dispatched` without terminal conclusion
    const openRuns = db
      .prepare("SELECT run_id FROM orch_p_run WHERE lifecycle IN ('admitted', 'dispatched')")
      .all() as Array<{ run_id: string }>
    for (const { run_id: runId } of openRuns) {
      const evidence = options.findRecorderEvidence?.(runId)
      if (evidence) {
        const psPayload = {
          runId,
          step: 'provider_settled' as const,
          isError: evidence.outcome === 'failed',
          ...(evidence.reason ? { reason: evidence.reason } : {}),
          evidence: evidence.evidence
        }
        sink.execute({
          type: 'run.effect_result',
          commandId: `effect:recovery-${runId}:provider_settled`,
          actor: `effect:recovery-${runId}`,
          scope: 'system',
          at: evidence.settledAt,
          payload: psPayload,
          payloadSha256: sha256Hex(canonicalJson(psPayload))
        })
        if (evidence.contentRef || evidence.outputSeq !== undefined) {
          const finPayload = {
            runId,
            step: 'finalized' as const,
            ...(evidence.contentRef ? { contentRef: evidence.contentRef } : {}),
            ...(evidence.outputSeq !== undefined ? { outputSeq: evidence.outputSeq } : {}),
            evidence: evidence.evidence
          }
          sink.execute({
            type: 'run.effect_result',
            commandId: `effect:recovery-${runId}:finalized`,
            actor: `effect:recovery-${runId}`,
            scope: 'system',
            at: evidence.settledAt,
            payload: finPayload,
            payloadSha256: sha256Hex(canonicalJson(finPayload))
          })
        }
        const termPayload = {
          runId,
          step: evidence.outcome,
          ...(evidence.reason ? { reason: evidence.reason } : {}),
          settledAt: evidence.settledAt,
          recoveredAt: now,
          outcome: {
            status: 'available' as const,
            quality: 'exact' as const,
            source: evidence.evidence,
            value: evidence.outcome
          },
          evidence: evidence.evidence
        }
        sink.execute({
          type: 'run.effect_result',
          commandId: `effect:recovery-${runId}:${evidence.outcome}`,
          actor: `effect:recovery-${runId}`,
          scope: 'system',
          at: evidence.settledAt,
          payload: termPayload,
          payloadSha256: sha256Hex(canonicalJson(termPayload))
        })
        summary.settledFromEvidence += 1
      } else {
        const intPayload = {
          runId,
          step: 'interrupted' as const,
          reason: 'host_restarted',
          settledAt: null,
          recoveredAt: now,
          outcome: {
            status: 'unavailable' as const,
            quality: 'unavailable' as const,
            source: ['host.recovery'],
            omissionReason: 'host_restarted'
          },
          evidence: ['host.recovery']
        }
        sink.execute({
          type: 'run.effect_result',
          commandId: `effect:recovery-${runId}:interrupted`,
          actor: `effect:recovery-${runId}`,
          scope: 'system',
          at: now,
          payload: intPayload,
          payloadSha256: sha256Hex(canonicalJson(intPayload))
        })
        summary.interruptedDispatched += 1
      }
    }

    // Close every open interaction in the SAME recovery transaction (core §2.4)
    const openInteractions = db
      .prepare("SELECT run_id, question_id FROM orch_p_interaction WHERE state = 'open'")
      .all() as Array<{ run_id: string; question_id: string }>
    for (const row of openInteractions) {
      const qPayload = {
        runId: row.run_id,
        step: 'question_closed' as const,
        questionId: row.question_id,
        reason: 'host_restarted',
        evidence: ['host.recovery']
      }
      sink.execute({
        type: 'run.effect_result',
        commandId: `effect:recovery-${row.run_id}:qclosed:${row.question_id}`,
        actor: `effect:recovery-${row.run_id}`,
        scope: 'system',
        at: now,
        payload: qPayload,
        payloadSha256: sha256Hex(canonicalJson(qPayload))
      })
      summary.closedOpenQuestions += 1
    }
  })

  return summary
}

export interface TwoLedgerReconciliationSummary {
  markedNotSent: number
  writtenBack: number
  bindingConflicts: number
}

/**
 * core §2.8 + Decision G two-ledger reconciliation on startup:
 * - Conversation turn `pending` with no `turn.began` in orchestration.db -> settle `not_sent`
 * - Event log terminal while conversation turn still `pending` -> writeback conclusion
 * - `nativeSessionId` mismatch -> `conversation_binding_conflict`
 */
export async function reconcileTwoLedgersOnStartup(options: {
  sink: EventSink
  conversationStore: ConversationStore
}): Promise<TwoLedgerReconciliationSummary> {
  const { sink, conversationStore } = options
  const summary: TwoLedgerReconciliationSummary = {
    markedNotSent: 0,
    writtenBack: 0,
    bindingConflicts: 0
  }
  const stmtBoundSession = sink.handle.db.prepare(
    "SELECT payload FROM orch_event WHERE run_id = ? AND type = 'run.session_bound' ORDER BY seq DESC LIMIT 1"
  )

  const ownership = await conversationStore.loadOwnership()
  for (const conv of ownership.values()) {
    for (const turn of conv.turns) {
      if (turn.origin !== 'dispatch' || turn.delivery.status !== 'pending') continue
      const orchTurn = sink.getTurnByRunId(turn.runId)
      const orchRun = sink.getRun(turn.runId)

      if (!orchTurn && !orchRun) {
        await conversationStore.settle(
          conv.id,
          turn.runId,
          { status: 'not_sent', reason: 'orchestration_intent_absent' },
          []
        )
        summary.markedNotSent += 1
        continue
      }

      if (!orchRun || !TERMINAL_RUN_LIFECYCLES.has(orchRun.lifecycle)) {
        continue
      }

      const boundRow = stmtBoundSession.get(turn.runId) as { payload: string } | undefined
      const boundNative = boundRow
        ? (JSON.parse(boundRow.payload) as { nativeSessionId?: string | null }).nativeSessionId ?? undefined
        : undefined
      const binding = conv.bindings.find((b) => b.id === turn.bindingId)
      if (boundNative && binding?.nativeSessionId && binding.nativeSessionId !== boundNative) {
        await conversationStore.settle(
          conv.id,
          turn.runId,
          { status: 'unknown', reason: 'conversation_binding_conflict' },
          []
        )
        summary.bindingConflicts += 1
        continue
      }

      if (orchRun.lifecycle === 'settled') {
        const resolvedNative = boundNative ?? binding?.nativeSessionId
        if (resolvedNative) {
          await conversationStore.settle(
            conv.id,
            turn.runId,
            {
              status: 'accepted',
              nativeSessionId: resolvedNative,
              outcome: 'completed',
              nativeItems: []
            },
            []
          )
        } else {
          // Decision G / evidence honesty: never fabricate a synthetic nativeSessionId (`orch:<runId>`).
          await conversationStore.settle(
            conv.id,
            turn.runId,
            { status: 'unknown', reason: 'native_session_id_unavailable' },
            []
          )
        }
        summary.writtenBack += 1
      } else if (orchRun.lifecycle === 'cancelled' && orchTurn?.delivery === 'not_sent') {
        await conversationStore.settle(
          conv.id,
          turn.runId,
          { status: 'not_sent', reason: orchRun.outcome?.omissionReason ?? 'cancelled' },
          []
        )
        summary.writtenBack += 1
      } else {
        await conversationStore.settle(
          conv.id,
          turn.runId,
          { status: 'unknown', reason: orchRun.outcome?.omissionReason ?? 'host_restarted' },
          []
        )
        summary.writtenBack += 1
      }
    }
  }
  // Finish generic recovery for any remaining non-orchestration pending turns or pending forks.
  try {
    await conversationStore.recoverAll(new Set())
  } catch (error) {
    console.warn('[scry] conversation post-reconciliation recovery failed:', error)
  }
  return summary
}
