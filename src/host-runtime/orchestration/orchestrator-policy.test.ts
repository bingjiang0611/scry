import { describe, expect, it } from 'vitest'
import { RUN_LIFECYCLE_NEXT } from '../../main/remote/session-ledger'
import { ALL_EFFECT_KINDS, EFFECT_POLICIES, getEffectPolicy } from './effect-policy'
import { H1_RUN_NEXT, ORCH_RUN_NEXT, canTransitionH1Run, canTransitionRun } from './run-transitions'
import {
  ORCHESTRATION_EVENT_TYPES,
  RESERVED_EVIDENCE_PREFIXES,
  RESERVED_TASK_EVENT_TYPES,
  isReservedEvidenceRef,
  type RunLifecycleState,
  type RunProjectionRow
} from './types'
import { sha256Hex } from './canonical-json'
import {
  decide,
  decodeOrchestrationEvent,
  evaluatePreDispatchRecheck,
  type OrchestrationCommand,
  type OrchestratorReadView
} from './orchestrator'

const PEER_A = `peer:${'a'.repeat(64)}`
const AGENT_ACTOR = 'agent:sub-1'

function makeMinimalView(runs: Map<string, RunProjectionRow> = new Map()): OrchestratorReadView {
  return {
    isActorAuthorized: (actor) => actor === PEER_A || actor === 'system' || actor.startsWith('effect:'),
    getReceipt: () => undefined,
    getRun: (runId) => runs.get(runId),
    getSession: () => undefined,
    getInteraction: () => undefined,
    listNonTerminalChildRuns: (parentRunId) =>
      [...runs.values()].filter(
        (run) =>
          run.parentRunId === parentRunId &&
          !['settled', 'failed', 'cancelled', 'interrupted'].includes(run.lifecycle)
      ),
    listNonTerminalChildRunsBySession: (sessionKey) =>
      [...runs.values()].filter(
        (run) =>
          run.sessionKey === sessionKey &&
          run.parentRunId !== null &&
          !['settled', 'failed', 'cancelled', 'interrupted'].includes(run.lifecycle)
      ),
    hasActiveRunForSession: () => false,
    activeRunCount: () => 0,
    maxActiveRuns: () => 8,
    isProviderAuthenticating: () => false
  }
}

describe('P4-0 transition tables & effect policy', () => {
  it('shares the exact H1 run transition table with session-ledger.ts (no copied table drift)', () => {
    expect(H1_RUN_NEXT).toBe(RUN_LIFECYCLE_NEXT)
    const states = Object.keys(H1_RUN_NEXT) as Array<keyof typeof H1_RUN_NEXT>
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionH1Run(from, to)).toBe(H1_RUN_NEXT[from].includes(to))
      }
    }
  })

  it('enforces every legal and illegal P4 orchestration run transition', () => {
    const states = Object.keys(ORCH_RUN_NEXT) as RunLifecycleState[]
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionRun(from, to)).toBe(ORCH_RUN_NEXT[from].includes(to))
      }
    }
    expect(canTransitionRun('recorded', 'admitted')).toBe(true)
    expect(canTransitionRun('recorded', 'dispatched')).toBe(true)
    expect(canTransitionRun('recorded', 'cancelled')).toBe(true)
    expect(canTransitionRun('recorded', 'failed')).toBe(true)
    expect(canTransitionRun('recorded', 'settled')).toBe(false)
    expect(canTransitionRun('dispatched', 'interrupted')).toBe(true)
    expect(canTransitionRun('settled', 'cancelled')).toBe(false)
    expect(canTransitionRun('interrupted', 'settled')).toBe(false)
  })

  it('registers every EffectKind in the centralized policy table', () => {
    for (const kind of ALL_EFFECT_KINDS) {
      expect(EFFECT_POLICIES[kind]).toBeDefined()
      expect(getEffectPolicy(kind)).toEqual(EFFECT_POLICIES[kind])
    }
    expect(getEffectPolicy('provider.run.start').policy).toBe('process_bound')
    expect(getEffectPolicy('provider.run.stop').policy).toBe('process_bound')
    expect(getEffectPolicy('question.respond').policy).toBe('process_bound')
    expect(getEffectPolicy('catalog.writeback').policy).toBe('replayable')
    expect(getEffectPolicy('conversation.writeback').policy).toBe('replayable')
    expect(getEffectPolicy('catalog.scan').policy).toBe('replayable')
    expect(getEffectPolicy('legacy.mirror').policy).toBe('replayable')
    expect(() => getEffectPolicy('unknown.kind' as never)).toThrow(
      expect.objectContaining({ code: 'orchestration_invalid_effect_kind' })
    )
  })
})

describe('P4-0 multi-agent reservations (core §2.10 R1-R12)', () => {
  it('excludes reserved task.* events from P4 whitelist and rejects agent: actors retryably', () => {
    for (const reserved of RESERVED_TASK_EVENT_TYPES) {
      expect(ORCHESTRATION_EVENT_TYPES.has(reserved as never)).toBe(false)
    }

    const agentCmd: OrchestrationCommand = {
      type: 'run.submit',
      commandId: 'agent-cmd-1',
      actor: AGENT_ACTOR,
      scope: 'system',
      at: 1_700_000_000_000,
      payload: {
        runId: 'run-a',
        sessionKey: 'session-1',
        provider: 'claude',
        profile: null,
        cwd: '/tmp/ws',
        claimMode: 'immediate'
      },
      payloadSha256: sha256Hex('agent-cmd-1')
    }
    const res = decide(agentCmd, makeMinimalView())
    expect(res).toEqual({
      kind: 'rejected',
      reason: 'agent_commands_unsupported',
      sticky: false,
      writeReceipt: false
    })
  })

  it('cascades run.stop to non-terminal child runs and keeps descendants empty in P4', () => {
    const parentRun: RunProjectionRow = {
      runId: 'run-parent',
      sessionKey: 'session-1',
      ownerActor: PEER_A,
      scope: 'local',
      origin: 'local',
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: 'p',
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
    const childRun: RunProjectionRow = { ...parentRun, runId: 'run-child', parentRunId: 'run-parent' }
    const stopCmd: OrchestrationCommand = {
      type: 'run.stop',
      commandId: 'stop-1',
      actor: PEER_A,
      scope: 'local',
      at: 1_700_000_005_000,
      payload: { runId: 'run-parent' },
      payloadSha256: sha256Hex('stop-1')
    }

    const empty = decide(stopCmd, makeMinimalView(new Map([[parentRun.runId, parentRun]])))
    expect(empty.kind).toBe('accepted')
    if (empty.kind === 'accepted') {
      expect(empty.events).toHaveLength(1)
      expect(empty.effects).toHaveLength(1)
    }

    const cascaded = decide(stopCmd, makeMinimalView(new Map([[parentRun.runId, parentRun], [childRun.runId, childRun]])))
    expect(cascaded.kind).toBe('accepted')
    if (cascaded.kind === 'accepted') {
      expect(cascaded.events).toHaveLength(2)
      expect(cascaded.events[1]).toMatchObject({
        type: 'run.stop_requested',
        runId: 'run-child',
        payload: expect.objectContaining({ cascadeRoot: 'run-parent' })
      })
      expect(cascaded.effects).toHaveLength(2)
    }
  })

  it('evaluates R4 agent-only recheck lines only for agent: actors and R9 decoder tolerates optional fields', () => {
    expect(
      evaluatePreDispatchRecheck({
        actor: PEER_A,
        principal: PEER_A,
        cwdMatches: true,
        workspaceAuthorized: true,
        grantValid: true,
        operationGateAcquired: true,
        trustGatePassed: true,
        callerRunTerminal: true
      })
    ).toEqual({ ok: true })

    expect(
      evaluatePreDispatchRecheck({
        actor: AGENT_ACTOR,
        principal: PEER_A,
        cwdMatches: true,
        workspaceAuthorized: true,
        grantValid: true,
        operationGateAcquired: true,
        trustGatePassed: true,
        callerRunTerminal: true
      })
    ).toEqual({ ok: false, action: 'fail', reason: 'caller_run_gone' })

    expect(
      decodeOrchestrationEvent({
        type: 'run.stop_requested',
        payload: { runId: 'run-1', cascadeRoot: 'run-0', futureOptionalField: 42 }
      }).ok
    ).toBe(true)

    expect(decodeOrchestrationEvent({ type: 'task.requested', payload: {} })).toEqual({
      ok: false,
      reason: 'unknown_event_type'
    })
  })

  it('reserves R10 task-result: evidence refs and rejects them in P4 events', () => {
    expect(RESERVED_EVIDENCE_PREFIXES).toContain('task-result:')
    expect(isReservedEvidenceRef('task-result:task-1')).toBe(true)
    expect(isReservedEvidenceRef('provider-result:run-1')).toBe(false)

    const dispatchedRun: RunProjectionRow = {
      runId: 'run-r10',
      sessionKey: 'session-r10',
      ownerActor: PEER_A,
      scope: 'remote',
      origin: 'remote',
      provider: 'claude',
      profile: 'default',
      cwd: '/tmp/ws',
      promptPreview: 'p',
      lifecycle: 'dispatched',
      stopState: null,
      outputSeq: null,
      intentSeq: 1,
      body: null,
      settledAt: null,
      recoveredAt: null,
      outcome: null,
      revSeq: 2,
      parentRunId: null
    }
    expect(() =>
      decide(
        {
          type: 'run.effect_result',
          commandId: 'effect:r10:settled',
          actor: 'effect:r10',
          scope: 'system',
          at: 1_700_000_005_000,
          payload: { runId: 'run-r10', step: 'settled', evidence: ['task-result:sub-1'] },
          payloadSha256: sha256Hex('r10')
        },
        makeMinimalView(new Map([[dispatchedRun.runId, dispatchedRun]]))
      )
    ).toThrow(expect.objectContaining({ code: 'orchestration_invalid_event', message: expect.stringMatching(/R10/) }))
  })
})
