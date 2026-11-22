import { randomUUID } from 'node:crypto'
import { assertBoundedPayload, assertNoUsageNumbersInEvent } from './canonical-json'
import { getEffectPolicy, type EffectKind } from './effect-policy'
import { scopedNativeSessionKey, type NativeSessionIdentity } from './native-session-lookup'
import type { OrchestrationCommand, RunEffectResultPayload } from './orchestrator-commands'
import { canTransitionRun } from './run-transitions'
import {
  isReservedEvidenceRef,
  OrchestrationStoreError,
  type CommandReceiptRow,
  type InteractionProjectionRow,
  type OrchestrationEventType,
  type PendingOrchestrationEvent,
  type PendingOutboxEffect,
  type RejectionReason,
  type RetryableRejectionReason,
  type RunLifecycleState,
  type RunProjectionRow,
  type SessionProjectionRow,
  type StickyRejectionReason,
  type TurnProjectionRow
} from './types'

export interface OrchestratorReadView {
  isActorAuthorized(actor: string): boolean
  getReceipt(commandId: string, actor: string): CommandReceiptRow | undefined
  getRun(runId: string): RunProjectionRow | undefined
  getSession(sessionKey: string): SessionProjectionRow | undefined
  getNativeSession?(identity: NativeSessionIdentity): SessionProjectionRow | undefined
  getTurnByRunId?(runId: string): TurnProjectionRow | undefined
  getNextTurnOrdinal?(sessionKey: string): number
  getInteraction(runId: string, questionId: string): InteractionProjectionRow | undefined
  listNonTerminalChildRuns(parentRunId: string): RunProjectionRow[]
  listNonTerminalChildRunsBySession(sessionKey: string): RunProjectionRow[]
  hasActiveRunForSession(sessionKey: string): boolean
  activeRunCount(): number
  maxActiveRuns(): number
  isProviderAuthenticating(provider: string, profile: string | null): boolean
}

export type DecisionResult =
  | {
      kind: 'accepted'
      events: PendingOrchestrationEvent[]
      effects: PendingOutboxEffect[]
      receipt: CommandReceiptRow
    }
  | {
      kind: 'duplicate'
      receipt: CommandReceiptRow
    }
  | {
      kind: 'rejected'
      reason: RejectionReason
      sticky: boolean
      writeReceipt: boolean
      receipt?: CommandReceiptRow
      result?: Record<string, unknown>
    }

function nextId(prefix: string | undefined, tag: string, index: number): string {
  return prefix ? `${prefix}-${tag}-${index}` : randomUUID()
}

export function makeEvent(
  cmd: OrchestrationCommand,
  index: number,
  fields: {
    type: OrchestrationEventType
    stream: string
    sessionKey?: string | null
    runId?: string | null
    cwd?: string | null
    payload: Record<string, unknown>
    evidence?: string[] | null
  }
): PendingOrchestrationEvent {
  assertNoUsageNumbersInEvent(fields.type, fields.payload)
  assertBoundedPayload(fields.payload)
  if (fields.evidence?.some(isReservedEvidenceRef)) {
    throw new OrchestrationStoreError(
      'orchestration_invalid_event',
      'Reserved R10 evidence reference prefix is not allowed in P4'
    )
  }
  return {
    eventId: nextId(cmd.idPrefix, 'evt', index),
    at: cmd.at,
    type: fields.type,
    stream: fields.stream,
    sessionKey: fields.sessionKey ?? null,
    runId: fields.runId ?? null,
    cwd: fields.cwd ?? null,
    commandId: cmd.commandId,
    actor: cmd.actor,
    scope: cmd.scope,
    payload: fields.payload,
    evidence: fields.evidence ?? null,
    principal: cmd.actor,
    via: null,
    actorRunId: null
  }
}

export function makeEffect(
  cmd: OrchestrationCommand,
  index: number,
  fields: {
    kind: EffectKind
    runId?: string | null
    payload: Record<string, unknown>
    state: 'pending' | 'running' | 'done'
    expiresAt?: number | null
    leaseOwner?: string | null
    claimedAt?: number | null
  }
): PendingOutboxEffect {
  const spec = getEffectPolicy(fields.kind)
  assertBoundedPayload(fields.payload)
  return {
    effectId: nextId(cmd.idPrefix, 'eff', index),
    kind: fields.kind,
    policy: spec.policy,
    runId: fields.runId ?? null,
    payload: fields.payload,
    state: fields.state,
    expiresAt: fields.expiresAt ?? null,
    leaseOwner: fields.leaseOwner ?? null,
    claimedAt: fields.claimedAt ?? null
  }
}

export function acceptDecision(
  cmd: OrchestrationCommand,
  events: PendingOrchestrationEvent[],
  effects: PendingOutboxEffect[],
  result: Record<string, unknown> | null
): DecisionResult {
  return {
    kind: 'accepted',
    events,
    effects,
    receipt: {
      commandId: cmd.commandId,
      actor: cmd.actor,
      type: cmd.type,
      payloadSha256: cmd.payloadSha256,
      acceptedAt: cmd.at,
      status: 'accepted',
      reason: null,
      result,
      resultSeq: null,
      principal: cmd.actor,
      via: null,
      actorRunId: null
    }
  }
}

export function stickyReject(
  cmd: OrchestrationCommand,
  reason: StickyRejectionReason,
  options: { writeReceipt: boolean; overrideReceipt?: Partial<CommandReceiptRow>; result?: Record<string, unknown> }
): DecisionResult {
  const receipt: CommandReceiptRow | undefined = options.writeReceipt
    ? {
        commandId: options.overrideReceipt?.commandId ?? cmd.commandId,
        actor: options.overrideReceipt?.actor ?? cmd.actor,
        type: options.overrideReceipt?.type ?? cmd.type,
        payloadSha256: options.overrideReceipt?.payloadSha256 ?? cmd.payloadSha256,
        acceptedAt: cmd.at,
        status: 'rejected',
        reason,
        result: options.overrideReceipt?.result ?? options.result ?? null,
        resultSeq: null,
        principal: cmd.actor,
        via: null,
        actorRunId: null
      }
    : undefined
  return {
    kind: 'rejected',
    reason,
    sticky: true,
    writeReceipt: options.writeReceipt,
    ...(receipt ? { receipt } : {}),
    ...(options.result ? { result: options.result } : {})
  }
}

export function retryableReject(reason: RetryableRejectionReason): DecisionResult {
  return { kind: 'rejected', reason, sticky: false, writeReceipt: false }
}

export function decideRunEffectResult(
  cmd: Extract<OrchestrationCommand, { type: 'run.effect_result' }>,
  view: OrchestratorReadView
): DecisionResult {
  const p: RunEffectResultPayload = cmd.payload
  const run = view.getRun(p.runId)
  if (!run) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })

  const events: PendingOrchestrationEvent[] = []
  const stream = `run:${run.runId}`
  const common = { stream, sessionKey: run.sessionKey, runId: run.runId, cwd: run.cwd, evidence: p.evidence ?? null }

  const pushTerminalTurnDelivery = (delivery: 'accepted' | 'not_sent' | 'unknown'): void => {
    if (!run.sessionKey) return
    events.push(
      makeEvent(cmd, events.length, {
        type: 'turn.delivery',
        stream: `session:${run.sessionKey}`,
        sessionKey: run.sessionKey,
        runId: run.runId,
        cwd: run.cwd,
        payload: {
          runId: run.runId,
          delivery,
          ...(p.reason ? { reason: p.reason } : {}),
          ...(p.outcome ? { outcome: p.outcome } : {})
        },
        evidence: p.evidence ?? null
      })
    )
  }

  switch (p.step) {
    case 'admitted': {
      if (!canTransitionRun(run.lifecycle, 'admitted')) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      events.push(makeEvent(cmd, 0, { ...common, type: 'run.admitted', payload: { runId: run.runId } }))
      return acceptDecision(cmd, events, [], { runId: run.runId, lifecycle: 'admitted' })
    }
    case 'dispatched': {
      if (!canTransitionRun(run.lifecycle, 'dispatched')) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      events.push(makeEvent(cmd, 0, { ...common, type: 'run.dispatched', payload: { runId: run.runId } }))
      return acceptDecision(cmd, events, [], { runId: run.runId, lifecycle: 'dispatched' })
    }
    case 'admitted_and_dispatched': {
      if (!canTransitionRun(run.lifecycle, 'admitted')) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      events.push(makeEvent(cmd, 0, { ...common, type: 'run.admitted', payload: { runId: run.runId } }))
      events.push(makeEvent(cmd, 1, { ...common, type: 'run.dispatched', payload: { runId: run.runId } }))
      return acceptDecision(cmd, events, [], { runId: run.runId, lifecycle: 'dispatched' })
    }
    case 'session_bound': {
      // Align with H1: progress/binding only valid after dispatch (not while still recorded).
      if (run.lifecycle !== 'dispatched') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      const identity = p.attachNative && !run.sessionKey && p.nativeSessionId && run.provider && run.cwd !== null
        ? { sessionId: p.nativeSessionId, provider: run.provider, profile: run.profile, cwd: run.cwd }
        : undefined
      const existing = identity ? view.getNativeSession?.(identity) ??
        (p.catalogRunId ? view.getNativeSession?.({ ...identity, sessionId: p.catalogRunId }) : undefined) : undefined
      const attach = identity && (!existing?.activeRunId || existing.activeRunId === run.runId)
      const sessionKey = attach
        ? existing?.sessionKey ?? (view.getSession(identity.sessionId) ? scopedNativeSessionKey(identity) : identity.sessionId)
        : run.sessionKey
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: 'run.session_bound',
          sessionKey,
          payload: {
            runId: run.runId, nativeSessionId: p.nativeSessionId ?? null, bindingId: p.bindingId ?? null,
            ...(p.catalogRunId ? { appRunId: p.catalogRunId } : {}),
            ...(attach ? { attachNative: true, provider: run.provider, profile: run.profile } : {})
          }
        })
      )
      if (attach && sessionKey) {
        events.push(makeEvent(cmd, 1, {
          type: 'turn.began', stream: `session:${sessionKey}`, runId: run.runId, sessionKey, cwd: run.cwd,
          payload: {
            sessionKey, runId: run.runId, ordinal: view.getNextTurnOrdinal?.(sessionKey) ?? 1,
            ordinalOrigin: existing?.legacy ? 'since_import' : 'native',
            userTextPreview: run.promptPreview, author: 'user'
          }
        }))
      }
      return acceptDecision(cmd, events, [], { runId: run.runId })
    }
    case 'question_opened': {
      if (run.lifecycle !== 'dispatched' || !p.questionId) {
        return stickyReject(cmd, p.questionId ? 'illegal_transition' : 'invalid_target', { writeReceipt: true })
      }
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: 'run.question_opened',
          payload: {
            runId: run.runId,
            questionId: p.questionId,
            kind: p.questionKind ?? 'question',
            source: p.questionSource ?? 'provider'
          }
        })
      )
      return acceptDecision(cmd, events, [], { runId: run.runId, questionId: p.questionId })
    }
    case 'question_closed': {
      if (!p.questionId || !view.getInteraction(run.runId, p.questionId)) {
        return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      }
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: 'run.question_closed',
          payload: { runId: run.runId, questionId: p.questionId, ...(p.reason ? { reason: p.reason } : {}) }
        })
      )
      return acceptDecision(cmd, events, [], { runId: run.runId, questionId: p.questionId })
    }
    case 'provider_settled': {
      if (run.lifecycle !== 'dispatched') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      const payload: Record<string, unknown> = {
        runId: run.runId,
        isError: Boolean(p.isError),
        ...(p.providerResultRef ? { providerResultRef: p.providerResultRef } : {}),
        ...(p.reason ? { reason: p.reason } : {}),
        ...(p.extra ? p.extra : {})
      }
      events.push(makeEvent(cmd, 0, { ...common, type: 'run.provider_settled', payload }))
      return acceptDecision(cmd, events, [], { runId: run.runId })
    }
    case 'transcript_referenced': {
      if (cmd.actor !== 'system' || !p.transcript) return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
      const event = makeEvent(cmd, 0, {
        ...common,
        type: 'run.transcript_referenced',
        payload: { runId: run.runId, transcript: p.transcript }
      })
      return acceptDecision(cmd, [event], [], { runId: run.runId })
    }
    case 'finalized': {
      if (run.lifecycle !== 'dispatched') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: 'run.finalized',
          payload: {
            runId: run.runId,
            ...(p.outputSeq !== undefined ? { outputSeq: p.outputSeq } : {}),
            ...(p.contentRef ? { contentRef: p.contentRef } : {})
          }
        })
      )
      return acceptDecision(cmd, events, [], { runId: run.runId })
    }
    case 'content_gap': {
      if (run.lifecycle !== 'dispatched') return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: 'run.content_gap',
          payload: { runId: run.runId, status: 'partial', reason: p.gapReason ?? 'output_capture_failed' }
        })
      )
      return acceptDecision(cmd, events, [], { runId: run.runId })
    }
    case 'settled':
    case 'failed':
    case 'cancelled':
    case 'interrupted': {
      const target: RunLifecycleState = p.step
      if (!canTransitionRun(run.lifecycle, target)) return stickyReject(cmd, 'illegal_transition', { writeReceipt: true })
      const settledAt = target === 'interrupted' ? null : (p.settledAt === undefined ? cmd.at : p.settledAt)
      const recoveredAt = target === 'interrupted' ? (p.recoveredAt ?? cmd.at) : (p.recoveredAt ?? null)
      // data §3.2: never fabricate `exact` when outcome evidence was not supplied.
      const outcome = p.outcome ?? (
        target === 'interrupted'
          ? { status: 'unavailable', quality: 'unavailable', source: ['host.recovery'], omissionReason: p.reason ?? 'host_restarted' }
          : { status: 'unavailable', quality: 'unavailable', source: p.evidence ?? [], omissionReason: 'outcome_evidence_absent' }
      )
      events.push(
        makeEvent(cmd, 0, {
          ...common,
          type: `run.${target}` as OrchestrationEventType,
          payload: {
            runId: run.runId,
            ...(p.reason ? { reason: p.reason } : {}),
            ...(p.detail ? { detail: p.detail } : {}),
            settledAt,
            recoveredAt,
            outcome,
            ...(p.historicalBackfill ? { historicalBackfill: true } : {})
          }
        })
      )
      if (p.delivery) pushTerminalTurnDelivery(p.delivery)
      else if (target === 'settled') pushTerminalTurnDelivery('accepted')
      else if (target === 'cancelled' && run.lifecycle === 'recorded') pushTerminalTurnDelivery('not_sent')
      else if (target === 'interrupted') pushTerminalTurnDelivery('unknown')
      return acceptDecision(cmd, events, [], { runId: run.runId, lifecycle: target })
    }
  }
}

export function decideCatalogChange(
  cmd: Extract<OrchestrationCommand, { type: 'session.discover' | 'session.withdraw' }>,
  view: OrchestratorReadView
): DecisionResult {
  if (cmd.type === 'session.withdraw') {
    const { sessionKey } = cmd.payload
    const session = view.getSession(sessionKey)
    if (cmd.actor !== 'system' || session?.catalog?.nativeSessionId !== null || session.activeRunId) {
      return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
    }
    const event = makeEvent(cmd, 0, {
      type: 'session.withdrawn', stream: `session:${sessionKey}`, sessionKey, cwd: session.cwd,
      payload: { sessionKey }
    })
    return acceptDecision(cmd, [event], [], { sessionKey })
  }
  const p = cmd.payload
  if (p.conversationId && (cmd.actor !== 'system' || p.conversationId !== p.sessionKey)) {
    return stickyReject(cmd, 'invalid_target', { writeReceipt: true })
  }
  const event = makeEvent(cmd, 0, {
    type: 'session.discovered',
    stream: `session:${p.sessionKey}`,
    sessionKey: p.sessionKey,
    cwd: p.cwd,
    payload: {
      sessionKey: p.sessionKey,
      ...(p.conversationId ? { conversationId: p.conversationId } : {}),
      provider: p.provider,
      profile: p.profile ?? null,
      cwd: p.cwd,
      title: p.title ?? null,
      ...(p.catalog ? { catalog: p.catalog } : {}),
      ...(p.display ? { display: p.display } : {}),
      ...(p.transcript ? { transcript: p.transcript } : {})
    },
    evidence: p.evidence ?? null
  })
  return acceptDecision(cmd, [event], [], { sessionKey: p.sessionKey })
}
