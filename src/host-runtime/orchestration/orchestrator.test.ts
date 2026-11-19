import { describe, expect, it } from 'vitest'
import type {
  CommandReceiptRow,
  InteractionProjectionRow,
  RunProjectionRow,
  SessionProjectionRow
} from './types'
import { canonicalJson, sha256Hex } from './canonical-json'
import {
  decide,
  isRetryableRejection,
  isStickyRejection,
  type OrchestrationCommand,
  type OrchestratorReadView
} from './orchestrator'

const PEER_A = `peer:${'a'.repeat(64)}`
const PEER_B = `peer:${'b'.repeat(64)}`

function makeView(overrides: Partial<{
  receipts: Map<string, CommandReceiptRow>
  runs: Map<string, RunProjectionRow>
  sessions: Map<string, SessionProjectionRow>
  interactions: Map<string, InteractionProjectionRow>
  activeRunsCount: number
  maxActiveRuns: number
  providerAuthenticating: boolean
  authorizedActors: Set<string>
}> = {}): OrchestratorReadView {
  const receipts = overrides.receipts ?? new Map<string, CommandReceiptRow>()
  const runs = overrides.runs ?? new Map<string, RunProjectionRow>()
  const sessions = overrides.sessions ?? new Map<string, SessionProjectionRow>()
  const interactions = overrides.interactions ?? new Map<string, InteractionProjectionRow>()
  const authorizedActors = overrides.authorizedActors ?? new Set([PEER_A, PEER_B, 'system'])

  return {
    isActorAuthorized: (actor) => actor.startsWith('effect:') || authorizedActors.has(actor),
    getReceipt: (commandId, actor) => receipts.get(`${actor}\0${commandId}`),
    getRun: (runId) => runs.get(runId),
    getSession: (sessionKey) => sessions.get(sessionKey),
    getInteraction: (runId, questionId) => interactions.get(`${runId}\0${questionId}`),
    listNonTerminalChildRuns: () => [],
    listNonTerminalChildRunsBySession: () => [],
    hasActiveRunForSession: (sessionKey) =>
      [...runs.values()].some(
        (run) =>
          run.sessionKey === sessionKey &&
          !['settled', 'failed', 'cancelled', 'interrupted'].includes(run.lifecycle)
      ),
    activeRunCount: () =>
      overrides.activeRunsCount ??
      [...runs.values()].filter(
        (run) => !['settled', 'failed', 'cancelled', 'interrupted'].includes(run.lifecycle)
      ).length,
    maxActiveRuns: () => overrides.maxActiveRuns ?? 8,
    isProviderAuthenticating: () => overrides.providerAuthenticating ?? false
  }
}

function submitCmd(overrides: Partial<Extract<OrchestrationCommand, { type: 'run.submit' }>> = {}): OrchestrationCommand {
  const payload = overrides.payload ?? {
    runId: 'remote-run-1',
    sessionKey: 'session-1',
    provider: 'claude',
    profile: 'default',
    cwd: '/tmp/ws',
    promptPreview: 'hello world',
    body: { storage: 'inline' as const, sha256: sha256Hex('hello world'), bytes: 11, inline: 'hello world' },
    claimMode: 'immediate' as const,
    leaseOwner: 'daemon-1'
  }
  return {
    type: 'run.submit',
    commandId: overrides.commandId ?? 'cmd-1',
    actor: overrides.actor ?? PEER_A,
    scope: overrides.scope ?? 'remote',
    at: overrides.at ?? 1_700_000_000_000,
    payload,
    payloadSha256: overrides.payloadSha256 ?? sha256Hex(canonicalJson(payload))
  }
}

describe('P4-0 pure orchestrator decide()', () => {
  it('accepts immediate run.submit with pre-allocated canonical id and claimed outbox row', () => {
    const decision = decide(submitCmd(), makeView())
    expect(decision.kind).toBe('accepted')
    if (decision.kind !== 'accepted') return
    expect(decision.events.map((e) => e.type)).toEqual(['run.intent_recorded', 'turn.began'])
    expect(decision.events[0].runId).toBe('remote-run-1')
    expect(decision.events[0].principal).toBe(PEER_A)
    expect(decision.events[0].via).toBeNull()
    expect(decision.events[0].actorRunId).toBeNull()
    expect(decision.events[1].payload).toMatchObject({ author: 'user' })
    expect(decision.effects).toHaveLength(1)
    expect(decision.effects[0]).toMatchObject({
      kind: 'provider.run.start',
      policy: 'process_bound',
      state: 'running',
      leaseOwner: 'daemon-1'
    })
    expect(decision.receipt.status).toBe('accepted')
  })

  it('queues pending run.submit with bounded TTL when claimMode is queued', () => {
    const cmd = submitCmd({
      payload: {
        runId: 'remote-run-2',
        sessionKey: 'session-1',
        provider: 'claude',
        profile: 'default',
        cwd: '/tmp/ws',
        promptPreview: 'queued',
        body: { storage: 'inline', sha256: sha256Hex('queued'), bytes: 6, inline: 'queued' },
        claimMode: 'queued',
        pendingTtlMs: 60_000
      }
    })
    const decision = decide(cmd, makeView())
    expect(decision.kind).toBe('accepted')
    if (decision.kind !== 'accepted') return
    expect(decision.effects[0]).toMatchObject({
      kind: 'provider.run.start',
      state: 'pending',
      expiresAt: 1_700_000_060_000,
      leaseOwner: null
    })
  })

  it('replays identical receipt for same commandId + same payload, and sticky-rejects payload conflict', () => {
    const cmd = submitCmd()
    const existing: CommandReceiptRow = {
      commandId: cmd.commandId,
      actor: cmd.actor,
      type: 'run.submit',
      payloadSha256: cmd.payloadSha256,
      acceptedAt: 1_700_000_000_000,
      status: 'accepted',
      reason: null,
      result: { runId: 'remote-run-1' },
      resultSeq: 2,
      principal: cmd.actor,
      via: null,
      actorRunId: null
    }
    const view = makeView({ receipts: new Map([[`${cmd.actor}\0${cmd.commandId}`, existing]]) })

    expect(decide(cmd, view)).toEqual({ kind: 'duplicate', receipt: existing })

    const modified = submitCmd({
      payload: {
        runId: 'remote-run-other',
        sessionKey: 'session-1',
        provider: 'claude',
        profile: 'default',
        cwd: '/tmp/ws',
        promptPreview: 'different prompt',
        body: { storage: 'inline', sha256: sha256Hex('different prompt'), bytes: 16, inline: 'different prompt' },
        claimMode: 'immediate',
        leaseOwner: 'daemon-1'
      }
    })
    const conflict = decide(modified, view)
    expect(conflict.kind).toBe('rejected')
    if (conflict.kind !== 'rejected') return
    expect(conflict.reason).toBe('command_payload_conflict')
    expect(conflict.sticky).toBe(true)
    expect(isStickyRejection(conflict.reason)).toBe(true)
  })

  it('writes tombstone receipt on resolveIntent when absent, causing late submit to conflict', () => {
    const resolveCmd: OrchestrationCommand = {
      type: 'run.resolve_intent',
      commandId: 'resolve-1',
      actor: PEER_A,
      scope: 'remote',
      at: 1_700_000_000_000,
      payload: { targetCommandId: 'scoped-intent-99', tombstoneRunId: 'remote-run-tombstone' },
      payloadSha256: sha256Hex('resolve-1')
    }
    const res = decide(resolveCmd, makeView())
    expect(res.kind).toBe('rejected')
    if (res.kind !== 'rejected') return
    expect(res.sticky).toBe(true)
    expect(res.writeReceipt).toBe(true)
    expect(res.receipt).toMatchObject({
      commandId: 'scoped-intent-99',
      actor: PEER_A,
      type: 'run.submit',
      payloadSha256: 'resolved_absent',
      status: 'rejected',
      reason: 'resolved_absent',
      result: { runId: 'remote-run-tombstone', state: 'cancelled' }
    })

    const receipts = new Map([[`${PEER_A}\0scoped-intent-99`, res.receipt!]])
    const lateRes = decide(submitCmd({ commandId: 'scoped-intent-99' }), makeView({ receipts }))
    expect(lateRes.kind).toBe('rejected')
    if (lateRes.kind !== 'rejected') return
    expect(lateRes.reason).toBe('command_payload_conflict')
    expect(lateRes.sticky).toBe(true)
  })

  it('does not write receipts for retryable rejections', () => {
    const busyRun: RunProjectionRow = {
      runId: 'remote-run-busy',
      sessionKey: 'session-1',
      ownerActor: PEER_A,
      scope: 'remote',
      origin: 'remote',
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: 'busy',
      lifecycle: 'dispatched',
      stopState: null,
      outputSeq: 0,
      intentSeq: 1,
      body: null,
      settledAt: null,
      recoveredAt: null,
      outcome: null,
      revSeq: 2,
      parentRunId: null
    }

    for (const [label, view, expectedReason] of [
      ['active session run', makeView({ runs: new Map([[busyRun.runId, busyRun]]) }), 'session_run_active'],
      ['capacity full', makeView({ activeRunsCount: 8, maxActiveRuns: 8 }), 'capacity_exceeded'],
      ['provider authenticating', makeView({ providerAuthenticating: true }), 'provider_authenticating'],
      ['unauthorized actor', makeView({ authorizedActors: new Set() }), 'device_not_authorized']
    ] as const) {
      const res = decide(submitCmd(), view)
      expect(res.kind, label).toBe('rejected')
      if (res.kind !== 'rejected') continue
      expect(res.reason, label).toBe(expectedReason)
      expect(res.sticky, label).toBe(false)
      expect(res.writeReceipt, label).toBe(false)
      expect(isRetryableRejection(res.reason), label).toBe(true)
    }
  })

  it('enforces illegal_transition as sticky rejection and forbids usage numbers in provider_settled', () => {
    const settledRun: RunProjectionRow = {
      runId: 'remote-run-1',
      sessionKey: 'session-1',
      ownerActor: PEER_A,
      scope: 'remote',
      origin: 'remote',
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: 'hi',
      lifecycle: 'settled',
      stopState: null,
      outputSeq: 5,
      intentSeq: 1,
      body: null,
      settledAt: 1_700_000_001_000,
      recoveredAt: null,
      outcome: { status: 'available', quality: 'exact', source: ['provider-result:remote-run-1'], value: 'settled' },
      revSeq: 4,
      parentRunId: null
    }
    const illegalCmd: OrchestrationCommand = {
      type: 'run.effect_result',
      commandId: 'effect:eff-1:cancelled',
      actor: 'effect:eff-1',
      scope: 'system',
      at: 1_700_000_002_000,
      payload: { runId: 'remote-run-1', step: 'cancelled', reason: 'too_late' },
      payloadSha256: sha256Hex('illegal')
    }
    const res = decide(illegalCmd, makeView({ runs: new Map([[settledRun.runId, settledRun]]) }))
    expect(res.kind).toBe('rejected')
    if (res.kind === 'rejected') {
      expect(res.reason).toBe('illegal_transition')
      expect(res.sticky).toBe(true)
      expect(res.writeReceipt).toBe(true)
    }

    const dispatchedRun: RunProjectionRow = { ...settledRun, lifecycle: 'dispatched', settledAt: null, outcome: null }
    const usageCmd: OrchestrationCommand = {
      type: 'run.effect_result',
      commandId: 'effect:eff-2:provider_settled',
      actor: 'effect:eff-2',
      scope: 'system',
      at: 1_700_000_002_000,
      payload: {
        runId: 'remote-run-1',
        step: 'provider_settled',
        isError: false,
        providerResultRef: 'provider-result:remote-run-1',
        extra: { inputTokens: 100 }
      },
      payloadSha256: sha256Hex('usage')
    }
    expect(() => decide(usageCmd, makeView({ runs: new Map([[dispatchedRun.runId, dispatchedRun]]) }))).toThrow(
      expect.objectContaining({ code: 'orchestration_usage_forbidden_in_event' })
    )
  })

  it('handles dispatch barrier, interrupted settledAt=null, question.answer, and imported inferred outcome', () => {
    const recordedRun: RunProjectionRow = {
      runId: 'remote-run-10',
      sessionKey: 'session-10',
      ownerActor: PEER_A,
      scope: 'remote',
      origin: 'remote',
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: 'go',
      lifecycle: 'recorded',
      stopState: null,
      outputSeq: 0,
      intentSeq: 1,
      body: null,
      settledAt: null,
      recoveredAt: null,
      outcome: null,
      revSeq: 1,
      parentRunId: null
    }

    const barrier = decide(
      {
        type: 'run.effect_result',
        commandId: 'effect:eff-10:admitted_and_dispatched',
        actor: 'effect:eff-10',
        scope: 'system',
        at: 1_700_000_001_000,
        payload: { runId: 'remote-run-10', step: 'admitted_and_dispatched' },
        payloadSha256: sha256Hex('barrier')
      },
      makeView({ runs: new Map([[recordedRun.runId, recordedRun]]) })
    )
    expect(barrier.kind).toBe('accepted')
    if (barrier.kind === 'accepted') {
      expect(barrier.events.map((e) => e.type)).toEqual(['run.admitted', 'run.dispatched'])
    }

    const dispatchedRun: RunProjectionRow = { ...recordedRun, lifecycle: 'dispatched' }
    const interrupted = decide(
      {
        type: 'run.effect_result',
        commandId: 'effect:recovery:interrupted',
        actor: 'system',
        scope: 'system',
        at: 1_700_000_010_000,
        payload: { runId: 'remote-run-10', step: 'interrupted', reason: 'host_restarted' },
        payloadSha256: sha256Hex('interrupted')
      },
      makeView({ runs: new Map([[dispatchedRun.runId, dispatchedRun]]) })
    )
    expect(interrupted.kind).toBe('accepted')
    if (interrupted.kind === 'accepted') {
      expect(interrupted.events[0].payload.settledAt).toBeNull()
      expect(interrupted.events[0].payload.recoveredAt).toBe(1_700_000_010_000)
      expect(interrupted.events[0].payload.outcome).toMatchObject({
        status: 'unavailable',
        quality: 'unavailable',
        omissionReason: 'host_restarted'
      })
    }

    const openInteraction: InteractionProjectionRow = {
      runId: 'remote-run-10',
      questionId: 'q-1',
      kind: 'approval',
      source: 'provider',
      state: 'open',
      answerId: null,
      answerSha256: null,
      openedSeq: 3,
      closedSeq: null,
      answeredBy: null
    }
    const answered = decide(
      {
        type: 'question.answer',
        commandId: 'ans-1',
        actor: PEER_A,
        scope: 'remote',
        at: 1_700_000_003_000,
        payload: { runId: 'remote-run-10', questionId: 'q-1', answerId: 'a-1', answerSha256: sha256Hex('yes') },
        payloadSha256: sha256Hex('ans-1')
      },
      makeView({
        runs: new Map([[dispatchedRun.runId, dispatchedRun]]),
        interactions: new Map([[`${dispatchedRun.runId}\0q-1`, openInteraction]])
      })
    )
    expect(answered.kind).toBe('accepted')
    if (answered.kind === 'accepted') {
      expect(answered.events[0].payload).toMatchObject({ answeredBy: PEER_A })
      expect(answered.effects[0].kind).toBe('question.respond')
    }

    const imported = decide(
      {
        type: 'session.import',
        commandId: 'imp-1',
        actor: 'system',
        scope: 'system',
        at: 1_700_000_004_000,
        payload: {
          sessionKey: 'legacy-1',
          ts: 1_699_000_000_000,
          lastRunOutcome: { status: 'available', quality: 'exact', source: ['app-sessions:abc'], value: 'settled' }
        },
        payloadSha256: sha256Hex('imp-1')
      },
      makeView()
    )
    expect(imported.kind).toBe('accepted')
    if (imported.kind === 'accepted') {
      expect(imported.events[0].payload.lastRunOutcome).toMatchObject({ quality: 'inferred' })
    }
  })
})
