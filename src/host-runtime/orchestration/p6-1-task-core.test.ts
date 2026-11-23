import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './canonical-json'
import { agentCommandId } from './delegation-limits'
import { EventSink } from './event-sink'
import { recoverOrchestrationOnStartup } from './recovery'

const PEER_A = `peer:${'a'.repeat(64)}`
const AGENT_1 = 'agent:sess-parent#bind-1'

function withSink<T>(fn: (sink: EventSink, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p6-core-'))
  const sink = EventSink.open({ userDataDir: dir, authorizedActors: [PEER_A], fullfsync: false })
  try {
    return fn(sink, dir)
  } finally {
    sink.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function submitParentRun(sink: EventSink, runId = 'run-parent-1', sessionKey = 'sess-parent', cwd = '/repo/p6') {
  const payload = {
    runId,
    sessionKey,
    provider: 'codex',
    profile: null,
    cwd,
    promptPreview: 'delegate work',
    claimMode: 'immediate' as const,
    dispatchImmediately: true,
    leaseOwner: 'daemon:test',
    origin: 'local' as const
  }
  const res = sink.execute({
    type: 'run.submit',
    commandId: `submit-${runId}`,
    actor: PEER_A,
    scope: 'local',
    at: 1_000,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
  expect(res.kind).toBe('accepted')
}

function setProjectDelegation(sink: EventSink, cwd: string, enabled: boolean, actor = PEER_A, scope: 'local' | 'remote' = 'local') {
  const payload = { cwd, enabled }
  return sink.execute({
    type: 'delegation.set_project_policy',
    commandId: `pol-${cwd}-${enabled}-${actor}-${scope}`,
    actor,
    scope,
    at: 1_010,
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload))
  })
}

describe('P6-1 orchestration core: tasks, switches, confirmation, L4, R8, read-only child', () => {
  it('enforces local-peer-only switches for project delegation and session full_access', () => {
    withSink((sink) => {
      // Remote peer rejected
      const remoteRes = setProjectDelegation(sink, '/repo/p6', true, PEER_A, 'remote')
      expect(remoteRes).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      // Agent actor rejected
      const agentRes = setProjectDelegation(sink, '/repo/p6', true, AGENT_1, 'local')
      expect(agentRes).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      // Local peer accepted
      const ok = setProjectDelegation(sink, '/repo/p6', true, PEER_A, 'local')
      expect(ok.kind).toBe('accepted')
      expect(sink.isProjectDelegationEnabled('/repo/p6')).toBe(true)

      const faPayload = { sessionKey: 'sess-parent', enabled: true }
      const faRemote = sink.execute({
        type: 'delegation.set_session_full_access',
        commandId: 'fa-remote',
        actor: PEER_A,
        scope: 'remote',
        at: 1_020,
        payload: faPayload,
        payloadSha256: sha256Hex(canonicalJson(faPayload))
      })
      expect(faRemote).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      const faOk = sink.execute({
        type: 'delegation.set_session_full_access',
        commandId: 'fa-local',
        actor: PEER_A,
        scope: 'local',
        at: 1_021,
        payload: faPayload,
        payloadSha256: sha256Hex(canonicalJson(faPayload))
      })
      expect(faOk.kind).toBe('accepted')
      expect(sink.isSessionFullAccessEnabled('sess-parent')).toBe(true)
    })
  })

  it('requires Scry peer confirmation before creating child session/run, rejects agent answers, and enforces read-only child session', () => {
    withSink((sink) => {
      submitParentRun(sink)
      expect(setProjectDelegation(sink, '/repo/p6', true).kind).toBe('accepted')

      const reqPayload = {
        taskId: 'task-1',
        parentSessionKey: 'sess-parent',
        parentRunId: 'run-parent-1',
        provider: 'codex',
        profile: null,
        cwd: '/repo/p6',
        title: 'Inspect module',
        permissionMode: 'default' as const,
        permissionModeSource: 'inherited' as const,
        confirmationQuestionId: 'q-confirm-task-1'
      }
      const cmdId = agentCommandId('scry_task_delegate', 'run-parent-1', 'req-1')
      const reqCmd = {
        type: 'task.request' as const,
        commandId: cmdId,
        actor: AGENT_1,
        principal: PEER_A,
        via: 'via-1',
        actorRunId: 'run-parent-1',
        scope: 'local' as const,
        at: 1_100,
        payload: reqPayload,
        payloadSha256: sha256Hex(canonicalJson(reqPayload))
      }
      const r1 = sink.execute(reqCmd)
      expect(r1.kind).toBe('accepted')
      // Idempotent duplicate returns same receipt
      const r2 = sink.execute(reqCmd)
      expect(r2.kind).toBe('duplicate')
      // Same commandId with different payload -> command_payload_conflict
      const conflictPayload = { ...reqPayload, title: 'Different title' }
      const rConflict = sink.execute({
        ...reqCmd,
        payload: conflictPayload,
        payloadSha256: sha256Hex(canonicalJson(conflictPayload))
      })
      expect(rConflict).toMatchObject({ kind: 'rejected', reason: 'command_payload_conflict', sticky: true })

      // Before confirmation: task is awaiting_confirmation, no child run created
      const taskPending = sink.getTask('task-1')
      expect(taskPending?.status).toBe('awaiting_confirmation')
      expect(taskPending?.childRunId).toBeNull()
      expect(sink.getInteraction('run-parent-1', 'q-confirm-task-1')?.state).toBe('open')

      // Agent cannot confirm its own task (D8)
      const confirmPayload = {
        taskId: 'task-1',
        questionId: 'q-confirm-task-1',
        answerId: 'ans-1',
        answerSha256: sha256Hex('approve'),
        approved: true,
        childSessionKey: 'sess-child-1',
        childRunId: 'run-child-1',
        leaseOwner: 'daemon:test'
      }
      const agentConfirm = sink.execute({
        type: 'task.confirm',
        commandId: 'confirm-by-agent',
        actor: AGENT_1,
        scope: 'local',
        at: 1_200,
        payload: confirmPayload,
        payloadSha256: sha256Hex(canonicalJson(confirmPayload))
      })
      expect(agentConfirm).toMatchObject({ kind: 'rejected', reason: 'device_not_authorized' })

      // Peer confirms -> child session + child run + turn(author=agent) + task.child_bound
      const peerConfirm = sink.execute({
        type: 'task.confirm',
        commandId: 'confirm-by-peer',
        actor: PEER_A,
        scope: 'local',
        at: 1_201,
        payload: confirmPayload,
        payloadSha256: sha256Hex(canonicalJson(confirmPayload))
      })
      expect(peerConfirm.kind).toBe('accepted')

      const taskBound = sink.getTask('task-1')
      expect(taskBound?.status).toBe('queued')
      expect(taskBound?.childSessionKey).toBe('sess-child-1')
      expect(taskBound?.childRunId).toBe('run-child-1')
      expect(taskBound?.stateVersion).toBeGreaterThan(1)

      const childSession = sink.getSession('sess-child-1')
      expect(childSession?.lineage).toEqual({
        kind: 'delegated',
        source: { sessionKey: 'sess-parent', runId: 'run-parent-1' },
        taskId: 'task-1'
      })
      expect(childSession?.createdBy).toBe(AGENT_1)

      const childRun = sink.getRun('run-child-1')
      expect(childRun?.origin).toBe('agent')
      expect(childRun?.parentRunId).toBe('run-parent-1')

      const childTurn = sink.getTurnByRunId('run-child-1')
      expect(childTurn?.author).toBe('agent')

      // Peer cannot send to a delegated child session (D10)
      const sendToChildPayload = {
        runId: 'run-illegal-peer',
        sessionKey: 'sess-child-1',
        provider: 'codex',
        profile: null,
        cwd: '/repo/p6',
        claimMode: 'queued' as const
      }
      const illegalSend = sink.execute({
        type: 'run.submit',
        commandId: 'send-to-delegated',
        actor: PEER_A,
        scope: 'local',
        at: 1_300,
        payload: sendToChildPayload,
        payloadSha256: sha256Hex(canonicalJson(sendToChildPayload))
      })
      expect(illegalSend).toMatchObject({ kind: 'rejected', reason: 'delegated_session_read_only', sticky: true })

      // Parent session cannot be archived while subtask is non-terminal
      const archivePayload = { sessionKey: 'sess-parent' }
      const archiveRes = sink.execute({
        type: 'session.archive',
        commandId: 'archive-parent',
        actor: PEER_A,
        scope: 'local',
        at: 1_310,
        payload: archivePayload,
        payloadSha256: sha256Hex(canonicalJson(archivePayload))
      })
      expect(archiveRes).toMatchObject({ kind: 'rejected', reason: 'active_subtasks_present' })

      expect(sink.verifyReplayConsistency().matches).toBe(true)
    })
  })

  it('voids awaiting_confirmation and undispatched child runs on parent end (L4), keeps dispatched child running, and handles session.stop_subtasks + R8 restart', () => {
    withSink((sink) => {
      submitParentRun(sink)
      expect(setProjectDelegation(sink, '/repo/p6', true).kind).toBe('accepted')

      const makeTask = (id: string, qid: string) => {
        const p = {
          taskId: id,
          parentSessionKey: 'sess-parent',
          parentRunId: 'run-parent-1',
          provider: 'codex',
          profile: null,
          cwd: '/repo/p6',
          permissionMode: 'default' as const,
          permissionModeSource: 'inherited' as const,
          confirmationQuestionId: qid
        }
        return sink.execute({
          type: 'task.request',
          commandId: agentCommandId('scry_task_delegate', 'run-parent-1', id),
          actor: AGENT_1,
          principal: PEER_A,
          via: 'via-1',
          actorRunId: 'run-parent-1',
          scope: 'local',
          at: 2_000,
          payload: p,
          payloadSha256: sha256Hex(canonicalJson(p))
        })
      }

      expect(makeTask('t-await', 'q-await').kind).toBe('accepted')
      expect(makeTask('t-queued', 'q-queued').kind).toBe('accepted')
      expect(makeTask('t-running', 'q-running').kind).toBe('accepted')

      // Confirm t-queued (stays recorded/queued) and t-running (advance to dispatched)
      for (const [id, qid, cSess, cRun] of [
        ['t-queued', 'q-queued', 'sess-c-q', 'run-c-q'],
        ['t-running', 'q-running', 'sess-c-r', 'run-c-r']
      ] as const) {
        const cp = {
          taskId: id, questionId: qid, answerId: `ans-${id}`, answerSha256: sha256Hex('ok'),
          approved: true, childSessionKey: cSess, childRunId: cRun
        }
        expect(sink.execute({
          type: 'task.confirm', commandId: `c-${id}`, actor: PEER_A, scope: 'local', at: 2_100,
          payload: cp, payloadSha256: sha256Hex(canonicalJson(cp))
        }).kind).toBe('accepted')
      }

      const dispPayload = { runId: 'run-c-r', step: 'admitted_and_dispatched' as const }
      expect(sink.execute({
        type: 'run.effect_result', commandId: 'disp-c-r', actor: 'effect:c-r', scope: 'system', at: 2_200,
        payload: dispPayload, payloadSha256: sha256Hex(canonicalJson(dispPayload))
      }).kind).toBe('accepted')
      expect(sink.getTask('t-running')?.status).toBe('running')

      // Parent run settles -> L4 voids t-await & t-queued (caller_run_ended), leaves t-running running!
      const settleParent = { runId: 'run-parent-1', step: 'settled' as const, settledAt: 2_300 }
      expect(sink.execute({
        type: 'run.effect_result', commandId: 'settle-parent', actor: 'effect:parent', scope: 'system', at: 2_300,
        payload: settleParent, payloadSha256: sha256Hex(canonicalJson(settleParent))
      }).kind).toBe('accepted')

      expect(sink.getTask('t-await')?.status).toBe('cancelled')
      expect(sink.getTask('t-await')?.reason).toBe('caller_run_ended')
      expect(sink.getInteraction('run-parent-1', 'q-await')?.state).toBe('closed')
      expect(sink.getTask('t-queued')?.status).toBe('cancelled')
      expect(sink.getRun('run-c-q')?.lifecycle).toBe('cancelled')
      expect(sink.getTask('t-running')?.status).toBe('running')
      expect(sink.getRun('run-c-r')?.lifecycle).toBe('dispatched')

      // Session-level stop_subtasks stops t-running even after parent ended
      const stopAllPayload = { sessionKey: 'sess-parent', reason: 'user_stop_all' }
      const stopAll = sink.execute({
        type: 'session.stop_subtasks', commandId: 'stop-all-1', actor: PEER_A, scope: 'local', at: 2_400,
        payload: stopAllPayload, payloadSha256: sha256Hex(canonicalJson(stopAllPayload))
      })
      expect(stopAll.kind).toBe('accepted')
      expect(sink.getRun('run-c-r')?.stopState).toBe('requested')

      // R8 restart recovery on a dispatched child run -> unavailable(host_restarted)
      recoverOrchestrationOnStartup({ sink, leaseOwner: 'daemon:restarted', now: 3_000 })
      expect(sink.getTask('t-running')?.status).toBe('unavailable')
      expect(sink.getTask('t-running')?.reason).toBe('host_restarted')

      expect(sink.verifyReplayConsistency().matches).toBe(true)
    })
  })
})
