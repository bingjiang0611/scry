import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRepoBaselineStore, computeExtendedRepoConfigFingerprint } from './agent-repo-baseline'
import { canonicalJson, sha256Hex } from './canonical-json'
import { DelegationCredentialStore } from './delegation-credentials'
import { DATA_NOT_INSTRUCTIONS_NOTICE, DelegationService } from './delegation-service'
import { EventSink } from './event-sink'

const PEER_A = `peer:${'a'.repeat(64)}`

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p6-svc-'))
  const wsDir = mkdtempSync(join(tmpdir(), 'scry-p6-ws-'))
  const sink = EventSink.open({ userDataDir: dir, authorizedActors: [PEER_A], fullfsync: false })
  const creds = new DelegationCredentialStore()
  const baseline = new AgentRepoBaselineStore()
  const archives = new Map<string, string>()

  const submitParent = (runId: string, sessionKey = 'sess-parent', mode: 'default' | 'full_access' = 'default') => {
    const p = {
      runId, sessionKey, provider: 'codex', profile: null, cwd: wsDir,
      promptPreview: 'parent', claimMode: 'immediate' as const, dispatchImmediately: true,
      leaseOwner: 'daemon:test', origin: 'local' as const
    }
    expect(sink.execute({
      type: 'run.submit', commandId: `sub-${runId}`, actor: PEER_A, scope: 'local', at: 1_000,
      payload: p, payloadSha256: sha256Hex(canonicalJson(p))
    }).kind).toBe('accepted')
    return creds.issue({
      runId, sessionKey, bindingId: 'b1', principal: PEER_A,
      provider: 'codex', profile: null, cwd: wsDir, permissionMode: mode
    })
  }

  const enableProject = () => {
    const p = { cwd: wsDir, enabled: true }
    expect(sink.execute({
      type: 'delegation.set_project_policy', commandId: `pol-${wsDir}`, actor: PEER_A, scope: 'local', at: 1_005,
      payload: p, payloadSha256: sha256Hex(canonicalJson(p))
    }).kind).toBe('accepted')
  }

  const recordUserBaseline = () => {
    const fp = computeExtendedRepoConfigFingerprint('codex', wsDir, 'trust-fp-1')
    baseline.recordUserRun('codex', wsDir, fp)
  }

  const service = new DelegationService({
    sink,
    credentials: creds,
    baselineStore: baseline,
    currentTrustFingerprint: () => 'trust-fp-1',
    readArchiveFinalMessage: (childRunId) => {
      const text = archives.get(childRunId)
      if (text === undefined) return undefined
      return { status: 'available', quality: 'exact', source: [`trace-archive:${childRunId}`], value: text }
    },
    limits: {
      maxDepth: 1, maxConcurrentPerParentRun: 4, maxTotalPerParentRun: 8, maxHostAgentRuns: 8,
      writePerMinute: 6, readPerMinute: 4, interactionTimeoutMs: 50, maxWaitMs: 300
    }
  })

  const cleanup = () => {
    service.dispose()
    sink.close()
    rmSync(dir, { recursive: true, force: true })
    rmSync(wsDir, { recursive: true, force: true })
  }

  return { sink, creds, baseline, archives, service, wsDir, submitParent, enableProject, recordUserBaseline, cleanup }
}

describe('P6-1 DelegationService tools, credentials, edge-triggered wait, pagination, and timeout', () => {
  it('enforces required clientRequestId, idempotency per run, additionalProperties:false, and baseline gate', async () => {
    const ctx = setup()
    try {
      const cred = ctx.submitParent('run-1')
      ctx.enableProject()

      // Missing user run baseline -> trust_gate_rejected
      const noBase = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'do work', clientRequestId: 'req-0'
      })
      expect(noBase).toMatchObject({ ok: false, code: 'trust_gate_rejected' })

      ctx.recordUserBaseline()

      // Missing clientRequestId -> invalid_request
      const noId = await ctx.service.callTool(cred.runId, 'scry_task_delegate', { task: 'do work' })
      expect(noId).toMatchObject({ ok: false, code: 'invalid_request' })

      // Unknown extra property -> invalid_request (additionalProperties: false)
      const extraProp = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'do work', clientRequestId: 'req-1', bogus: 1
      })
      expect(extraProp).toMatchObject({ ok: false, code: 'invalid_request' })

      // Valid delegate -> awaiting_confirmation
      const r1 = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'inspect module', title: 'Inspect', clientRequestId: 'req-1'
      })
      expect(r1).toMatchObject({ ok: true, data: { status: 'awaiting_confirmation', stateVersion: 1 } })
      const taskId1 = (r1 as { ok: true; data: { taskId: string } }).data.taskId

      // Same run + same clientRequestId + same payload -> same taskId
      const r2 = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'inspect module', title: 'Inspect', clientRequestId: 'req-1'
      })
      expect(r2).toMatchObject({ ok: true, data: { taskId: taskId1 } })

      // Same run + same clientRequestId + different payload -> command_payload_conflict
      const rConflict = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'different work', title: 'Inspect', clientRequestId: 'req-1'
      })
      expect(rConflict).toMatchObject({ ok: false, code: 'command_payload_conflict' })

      // Next run with SAME clientRequestId -> NEW task
      const settle = { runId: 'run-1', step: 'settled' as const, settledAt: 2_000 }
      ctx.sink.execute({
        type: 'run.effect_result', commandId: 'settle-r1', actor: 'effect:r1', scope: 'system', at: 2_000,
        payload: settle, payloadSha256: sha256Hex(canonicalJson(settle))
      })
      ctx.creds.revokeRun('run-1')

      // Revoked credential rejected with 0 new rows
      const afterRevoke = await ctx.service.callTool('run-1', 'scry_capabilities', {})
      expect(afterRevoke).toMatchObject({ ok: false, code: 'caller_not_active' })

      const cred2 = ctx.submitParent('run-2')
      const r3 = await ctx.service.callTool(cred2.runId, 'scry_task_delegate', {
        task: 'inspect module', title: 'Inspect', clientRequestId: 'req-1'
      })
      expect(r3.ok).toBe(true)
      expect((r3 as { ok: true; data: { taskId: string } }).data.taskId).not.toBe(taskId1)
    } finally {
      ctx.cleanup()
    }
  })

  it('supports edge-triggered wait on stateVersion, cross-session isolation, read rate limit, and 1024-char result pagination', async () => {
    const ctx = setup()
    try {
      const cred = ctx.submitParent('run-w1')
      const otherCred = ctx.submitParent('run-other', 'sess-other')
      ctx.enableProject()
      ctx.recordUserBaseline()

      const del = await ctx.service.callTool(cred.runId, 'scry_task_delegate', {
        task: 'generate report', clientRequestId: 'req-w1'
      })
      expect(del.ok).toBe(true)
      const taskId = (del as { ok: true; data: { taskId: string } }).data.taskId
      const taskRow = ctx.sink.getTask(taskId)!

      // Other session cannot see task
      const leak = await ctx.service.callTool(otherCred.runId, 'scry_task_status', { taskId })
      expect(leak).toMatchObject({ ok: false, code: 'task_not_found' })

      // Edge-triggered wait wakes immediately when peer confirms task
      const waitPromise = ctx.service.callTool(cred.runId, 'scry_task_status', {
        taskId, mode: 'wait', sinceVersion: 1, timeoutMs: 250
      })
      setTimeout(() => {
        const cp = {
          taskId, questionId: taskRow.confirmationQuestionId!, answerId: 'ans-w1',
          answerSha256: sha256Hex('ok'), approved: true, childSessionKey: 'sess-cw1', childRunId: 'run-cw1'
        }
        ctx.sink.execute({
          type: 'task.confirm', commandId: 'conf-w1', actor: PEER_A, scope: 'local', at: 1_500,
          payload: cp, payloadSha256: sha256Hex(canonicalJson(cp))
        })
      }, 20)
      const waited = await waitPromise
      expect(waited).toMatchObject({ ok: true, data: { taskId, status: 'queued', waitTimedOut: false } })

      // Wait with no change times out without cancelling child
      const timedOut = await ctx.service.callTool(cred.runId, 'scry_task_status', {
        taskId, mode: 'wait', sinceVersion: 2, timeoutMs: 30
      })
      expect(timedOut).toMatchObject({ ok: true, data: { taskId, status: 'queued', waitTimedOut: true } })

      // Paginated result read (1024 chars per page) + data-not-instructions notice
      const bigReply = 'A'.repeat(1024) + 'B'.repeat(200)
      ctx.archives.set('run-cw1', bigReply)
      const page1 = await ctx.service.callTool(cred.runId, 'scry_task_result_read', { taskId, offset: 0 })
      expect(page1).toMatchObject({
        ok: true,
        data: {
          status: 'available',
          content: 'A'.repeat(1024),
          nextOffset: 1024,
          notice: DATA_NOT_INSTRUCTIONS_NOTICE
        }
      })
      const page2 = await ctx.service.callTool(cred.runId, 'scry_task_result_read', { taskId, offset: 1024 })
      expect(page2).toMatchObject({
        ok: true,
        data: {
          status: 'available',
          content: 'B'.repeat(200),
          nextOffset: null,
          notice: DATA_NOT_INSTRUCTIONS_NOTICE
        }
      })

      // 5th read in same minute hits readPerMinute=4 -> limit_exceeded
      const rateLimited = await ctx.service.callTool(cred.runId, 'scry_capabilities', {})
      expect(rateLimited).toMatchObject({ ok: false, code: 'limit_exceeded' })
    } finally {
      ctx.cleanup()
    }
  })
})
