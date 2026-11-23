import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { agentCommandId } from './delegation-limits'
import { EventSink } from './event-sink'
import { evaluatePreDispatchRecheck } from './orchestrator-commands'

const PEER_A = `peer:${'a'.repeat(64)}`
const AGENT_1 = 'agent:sess-p#b1'

function withSink<T>(fn: (sink: EventSink) => T, maxTotalPerParentRun = 8): T {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p6-rev-'))
  const sink = EventSink.open({
    userDataDir: dir,
    authorizedActors: [PEER_A],
    fullfsync: false,
    delegationLimits: {
      maxDepth: 1, maxConcurrentPerParentRun: 4, maxTotalPerParentRun, maxHostAgentRuns: 8,
      writePerMinute: 6, readPerMinute: 60, interactionTimeoutMs: 60_000, maxWaitMs: 20_000
    }
  })
  try {
    return fn(sink)
  } finally {
    sink.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function submitParent(sink: EventSink, runId: string, sessionKey = 'sess-p', cwd = '/repo/rev') {
  const p = {
    runId, sessionKey, provider: 'codex', profile: null, cwd,
    claimMode: 'immediate' as const, dispatchImmediately: true, leaseOwner: 'daemon:test', origin: 'local' as const
  }
  expect(sink.execute({
    type: 'run.submit', commandId: `sub-${runId}`, actor: PEER_A, scope: 'local', at: 1_000,
    payload: p, payloadSha256: sha256Hex(canonicalJson(p))
  }).kind).toBe('accepted')
}

function enableProject(sink: EventSink, cwd = '/repo/rev') {
  const p = { cwd, enabled: true }
  expect(sink.execute({
    type: 'delegation.set_project_policy', commandId: `pol-${cwd}`, actor: PEER_A, scope: 'local', at: 1_005,
    payload: p, payloadSha256: sha256Hex(canonicalJson(p))
  }).kind).toBe('accepted')
}

describe('P6-1 independent review blocker fixes', () => {
  it('B1: evaluatePreDispatchRecheck fails closed when agent repoFingerprintMatchesUserRun is undefined', () => {
    expect(evaluatePreDispatchRecheck({
      actor: AGENT_1,
      principal: PEER_A,
      cwdMatches: true,
      workspaceAuthorized: true,
      grantValid: true,
      operationGateAcquired: true,
      trustGatePassed: true
    })).toEqual({ ok: false, action: 'fail', reason: 'trust_gate_rejected' })
  })

  it('B2 & M1: rejects remote task.confirm, peer task.settle, and raw question.answer on scry_orchestrator confirmations', () => {
    withSink((sink) => {
      submitParent(sink, 'run-p1')
      enableProject(sink)
      const rp = {
        taskId: 't1', parentSessionKey: 'sess-p', parentRunId: 'run-p1', provider: 'codex', profile: null,
        cwd: '/repo/rev', permissionMode: 'default' as const, permissionModeSource: 'inherited' as const,
        confirmationQuestionId: 'q-t1'
      }
      expect(sink.execute({
        type: 'task.request', commandId: agentCommandId('scry_task_delegate', 'run-p1', 'r1'),
        actor: AGENT_1, principal: PEER_A, via: 'v1', actorRunId: 'run-p1', scope: 'local', at: 1_100,
        payload: rp, payloadSha256: sha256Hex(canonicalJson(rp))
      }).kind).toBe('accepted')

      // Remote peer cannot confirm
      const cp = {
        taskId: 't1', questionId: 'q-t1', answerId: 'a1', answerSha256: sha256Hex('ok'),
        approved: true, childSessionKey: 'sess-c1', childRunId: 'run-c1'
      }
      expect(sink.execute({
        type: 'task.confirm', commandId: 'c-remote', actor: PEER_A, scope: 'remote', at: 1_200,
        payload: cp, payloadSha256: sha256Hex(canonicalJson(cp))
      })).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      // Raw question.answer cannot answer scry_orchestrator confirmations
      const qa = { runId: 'run-p1', questionId: 'q-t1', answerId: 'a-raw', answerSha256: sha256Hex('raw') }
      expect(sink.execute({
        type: 'question.answer', commandId: 'qa-raw', actor: PEER_A, scope: 'local', at: 1_205,
        payload: qa, payloadSha256: sha256Hex(canonicalJson(qa))
      })).toMatchObject({ kind: 'rejected', reason: 'illegal_transition' })

      // Peer cannot forge task.settle
      const sp = { taskId: 't1', status: 'completed' as const }
      expect(sink.execute({
        type: 'task.settle', commandId: 'settle-peer', actor: PEER_A, scope: 'local', at: 1_210,
        payload: sp, payloadSha256: sha256Hex(canonicalJson(sp))
      })).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })
    })
  })

  it('B3: allows subsequent parent session run to request cancel and requires exact cancelConfirmationQuestionId', () => {
    withSink((sink) => {
      submitParent(sink, 'run-p1')
      enableProject(sink)
      const rp = {
        taskId: 't-cross', parentSessionKey: 'sess-p', parentRunId: 'run-p1', provider: 'codex', profile: null,
        cwd: '/repo/rev', permissionMode: 'default' as const, permissionModeSource: 'inherited' as const,
        confirmationQuestionId: 'q-t-cross'
      }
      expect(sink.execute({
        type: 'task.request', commandId: agentCommandId('scry_task_delegate', 'run-p1', 'rc'),
        actor: AGENT_1, principal: PEER_A, via: 'v1', actorRunId: 'run-p1', scope: 'local', at: 1_100,
        payload: rp, payloadSha256: sha256Hex(canonicalJson(rp))
      }).kind).toBe('accepted')
      const cp = {
        taskId: 't-cross', questionId: 'q-t-cross', answerId: 'a1', answerSha256: sha256Hex('ok'),
        approved: true, childSessionKey: 'sess-cc', childRunId: 'run-cc'
      }
      expect(sink.execute({
        type: 'task.confirm', commandId: 'conf-cc', actor: PEER_A, scope: 'local', at: 1_150,
        payload: cp, payloadSha256: sha256Hex(canonicalJson(cp))
      }).kind).toBe('accepted')
      const disp = { runId: 'run-cc', step: 'admitted_and_dispatched' as const }
      expect(sink.execute({
        type: 'run.effect_result', commandId: 'disp-cc', actor: 'effect:cc', scope: 'system', at: 1_160,
        payload: disp, payloadSha256: sha256Hex(canonicalJson(disp))
      }).kind).toBe('accepted')
      // End run-p1, start run-p2 in SAME session
      const endP1 = { runId: 'run-p1', step: 'settled' as const, settledAt: 1_200 }
      expect(sink.execute({
        type: 'run.effect_result', commandId: 'end-p1', actor: 'effect:p1', scope: 'system', at: 1_200,
        payload: endP1, payloadSha256: sha256Hex(canonicalJson(endP1))
      }).kind).toBe('accepted')
      submitParent(sink, 'run-p2')

      // run-p2 requests cancel of task created by run-p1 (D21/L2)
      const cancelReq = { taskId: 't-cross', parentSessionKey: 'sess-p', confirmationQuestionId: 'q-cancel-2' }
      expect(sink.execute({
        type: 'task.cancel_request', commandId: agentCommandId('scry_task_cancel', 'run-p2', 'c1'),
        actor: AGENT_1, principal: PEER_A, via: 'v2', actorRunId: 'run-p2', scope: 'local', at: 1_300,
        payload: cancelReq, payloadSha256: sha256Hex(canonicalJson(cancelReq))
      }).kind).toBe('accepted')

      // Wrong questionId is rejected
      const wrongQ = {
        taskId: 't-cross', questionId: 'q-wrong', questionRunId: 'run-p2',
        answerId: 'ac1', answerSha256: sha256Hex('ok'), approved: true
      }
      expect(sink.execute({
        type: 'task.confirm_cancel', commandId: 'cc-wrong', actor: PEER_A, scope: 'local', at: 1_310,
        payload: wrongQ, payloadSha256: sha256Hex(canonicalJson(wrongQ))
      })).toMatchObject({ kind: 'rejected', reason: 'invalid_target' })

      // Exact questionId on run-p2 succeeds
      const rightQ = { ...wrongQ, questionId: 'q-cancel-2' }
      expect(sink.execute({
        type: 'task.confirm_cancel', commandId: 'cc-right', actor: PEER_A, scope: 'local', at: 1_320,
        payload: rightQ, payloadSha256: sha256Hex(canonicalJson(rightQ))
      }).kind).toBe('accepted')
      expect(sink.getRun('run-cc')?.stopState).toBe('requested')
    })
  })

  it('B4 & B5: returns sticky limit_exceeded at maxTotalPerParentRun and voids recorded child runs in session.stop_subtasks', () => {
    withSink((sink) => {
      submitParent(sink, 'run-p1')
      enableProject(sink)
      const mk = (id: string) => ({
        taskId: id, parentSessionKey: 'sess-p', parentRunId: 'run-p1', provider: 'codex', profile: null,
        cwd: '/repo/rev', permissionMode: 'default' as const, permissionModeSource: 'inherited' as const,
        confirmationQuestionId: `q-${id}`
      })
      const p1 = mk('t1')
      expect(sink.execute({
        type: 'task.request', commandId: agentCommandId('scry_task_delegate', 'run-p1', 't1'),
        actor: AGENT_1, principal: PEER_A, via: 'v1', actorRunId: 'run-p1', scope: 'local', at: 1_100,
        payload: p1, payloadSha256: sha256Hex(canonicalJson(p1))
      }).kind).toBe('accepted')

      // 2nd task exceeds maxTotalPerParentRun=1 -> sticky limit_exceeded (B4)
      const p2 = mk('t2')
      expect(sink.execute({
        type: 'task.request', commandId: agentCommandId('scry_task_delegate', 'run-p1', 't2'),
        actor: AGENT_1, principal: PEER_A, via: 'v1', actorRunId: 'run-p1', scope: 'local', at: 1_110,
        payload: p2, payloadSha256: sha256Hex(canonicalJson(p2))
      })).toMatchObject({ kind: 'rejected', reason: 'limit_exceeded', sticky: true })

      // Confirm t1 so child run stays recorded (undispatched), then session.stop_subtasks voids it (B5)
      const cp = {
        taskId: 't1', questionId: 'q-t1', answerId: 'a1', answerSha256: sha256Hex('ok'),
        approved: true, childSessionKey: 'sess-c1', childRunId: 'run-c1'
      }
      expect(sink.execute({
        type: 'task.confirm', commandId: 'conf-t1', actor: PEER_A, scope: 'local', at: 1_120,
        payload: cp, payloadSha256: sha256Hex(canonicalJson(cp))
      }).kind).toBe('accepted')

      const stopPayload = { sessionKey: 'sess-p', reason: 'stop_all' }
      expect(sink.execute({
        type: 'session.stop_subtasks', commandId: 'stop-all', actor: PEER_A, scope: 'local', at: 1_130,
        payload: stopPayload, payloadSha256: sha256Hex(canonicalJson(stopPayload))
      }).kind).toBe('accepted')
      expect(sink.getRun('run-c1')?.lifecycle).toBe('cancelled')
      expect(sink.getTask('t1')?.status).toBe('cancelled')
      expect(sink.verifyReplayConsistency().matches).toBe(true)
    }, 1)
  })
})
