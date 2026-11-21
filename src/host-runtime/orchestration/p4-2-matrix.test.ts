import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorityEngine } from './authority-engine'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { decodeOrchestrationEvent, evaluatePreDispatchRecheck } from './orchestrator-commands'
import {
  ORCHESTRATION_EVENT_TYPES,
  RESERVED_EVIDENCE_PREFIXES,
  RESERVED_TASK_EVENT_TYPES
} from './types'

const PEER_A = 'a'.repeat(64)

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p4-2-matrix-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-2 plan §10 test matrix: idempotency, pruning, out-of-order, evidence, R1-R12, negative controls', () => {
  it('preserves permanent command receipts across restart and event pruning, while retryable rejections leave no receipt', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const detail = JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'prune-safe intent' })
      let runId = ''

      const sink1 = EventSink.open({ userDataDir: userData, maxActiveRuns: 1, checkpointIntervalMs: 0 })
      const engine1 = new AuthorityEngine({ sink: sink1, clock: () => 1_700_000_000_000 })
      try {
        // Retryable rejection (capacity_exceeded after first run active) leaves NO receipt
        const s1 = await engine1.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-1',
          detail
        })
        expect(s1.kind).toBe('accepted')
        if (s1.kind !== 'accepted') return
        runId = s1.runId

        const capRejected = await engine1.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-2',
          detail
        })
        expect(capRejected).toEqual({ kind: 'rejected', reason: 'capacity_exceeded', sticky: false })
        expect(sink1.getReceipt('cmd-2', `peer:${PEER_A}`)).toBeUndefined()

        // Complete run 1, then cmd-2 succeeds on retry!
        expect(
          engine1.beforeDispatch({
            runId,
            cwd: realWs,
            provider: 'codex',
            profile: null,
            actor: `peer:${PEER_A}`,
            authorizeWorkspace: (p) => p,
            isPeerAuthorized: () => true,
            isProviderAuthenticating: () => false
          })
        ).toEqual({ ok: true })
        engine1.recordTerminal({ runId, step: 'settled', evidence: ['provider:codex'] })

        const retryAccepted = await engine1.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-2',
          detail
        })
        expect(retryAccepted.kind).toBe('accepted')

        // Prune older events -> receipts MUST survive pruning
        const pruned = sink1.pruneEvents({ olderThanAt: 1_700_000_000_001 })
        expect(pruned.deletedEvents).toBeGreaterThan(0)
      } finally {
        sink1.close()
      }

      // Reopen after restart -> duplicate cmd-1 returns original runId; mismatched detail conflicts
      const sink2 = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine2 = new AuthorityEngine({ sink: sink2 })
      try {
        const dup = await engine2.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-1',
          detail
        })
        expect(dup).toMatchObject({ kind: 'duplicate', runId })

        const conflict = await engine2.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-1',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'DIFFERENT' })
        })
        expect(conflict).toMatchObject({ kind: 'rejected', reason: 'command_payload_conflict', sticky: true })
      } finally {
        sink2.close()
      }
    })
  })

  it('rejects out-of-order terminal transitions and late question answers after close, preserving null outputSeq != 0', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine = new AuthorityEngine({ sink })
      try {
        const s1 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-ooo-1',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'ooo' })
        })
        expect(s1.kind).toBe('accepted')
        if (s1.kind !== 'accepted') return
        expect(sink.getRun(s1.runId)?.outputSeq).toBeNull()

        expect(
          engine.beforeDispatch({
            runId: s1.runId,
            cwd: realWs,
            provider: 'codex',
            profile: null,
            actor: `peer:${PEER_A}`,
            authorizeWorkspace: (p) => p,
            isPeerAuthorized: () => true,
            isProviderAuthenticating: () => false
          })
        ).toEqual({ ok: true })

        engine.recordProgress({ runId: s1.runId, step: 'question_opened', commandSuffix: 'q1', questionId: 'q-ooo' })
        engine.recordProgress({
          runId: s1.runId,
          step: 'question_closed',
          commandSuffix: 'q1',
          questionId: 'q-ooo',
          reason: 'withdrawn'
        })
        const lateAnswer = engine.answerQuestion({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          runId: s1.runId,
          questionId: 'q-ooo',
          answerId: 'ans-late',
          answerSha256: 'b'.repeat(64)
        })
        expect(lateAnswer).toMatchObject({ kind: 'rejected', reason: 'illegal_transition', sticky: true })

        engine.recordTerminal({ runId: s1.runId, step: 'cancelled', reason: 'user_stop', evidence: ['host.stop'] })
        // Late settled after cancelled -> rejected as illegal_transition
        const lateSettle = sink.execute({
          type: 'run.effect_result',
          commandId: 'eff-late-settle',
          actor: 'effect:late',
          scope: 'system',
          at: Date.now(),
          payload: { runId: s1.runId, step: 'settled' },
          payloadSha256: sha256Hex(canonicalJson({ runId: s1.runId, step: 'settled' }))
        })
        expect(lateSettle).toMatchObject({ kind: 'rejected', reason: 'illegal_transition', sticky: true })
        expect(sink.getRun(s1.runId)?.lifecycle).toBe('cancelled')
        expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        sink.close()
      }
    })
  })

  it('enforces R1-R12 non-emission invariants and proves negative controls fail without required checks', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine = new AuthorityEngine({ sink })
      try {
        const s1 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'cmd-r-check',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'r-invariants' })
        })
        expect(s1.kind).toBe('accepted')
        if (s1.kind !== 'accepted') return
        expect(
          engine.beforeDispatch({
            runId: s1.runId,
            cwd: realWs,
            provider: 'codex',
            profile: null,
            actor: `peer:${PEER_A}`,
            authorizeWorkspace: (p) => p,
            isPeerAuthorized: () => true,
            isProviderAuthenticating: () => false
          })
        ).toEqual({ ok: true })
        engine.recordTerminal({ runId: s1.runId, step: 'settled', evidence: ['provider:codex'] })

        // Verify R1-R12 non-emission across all recorded events
        for (const evt of sink.listEvents()) {
          expect(ORCHESTRATION_EVENT_TYPES.has(evt.type)).toBe(true)
          expect(evt.actor.startsWith('agent:')).toBe(false)
          expect(evt.principal).toBe(evt.actor)
          expect(evt.via).toBeNull()
          expect(evt.actorRunId).toBeNull()
          for (const reserved of RESERVED_TASK_EVENT_TYPES) {
            expect(evt.type).not.toBe(reserved)
          }
          for (const ref of evt.evidence ?? []) {
            for (const prefix of RESERVED_EVIDENCE_PREFIXES) {
              expect(ref.startsWith(prefix)).toBe(false)
            }
          }
        }
        for (const reserved of RESERVED_TASK_EVENT_TYPES) {
          expect(decodeOrchestrationEvent({ type: reserved, payload: {} })).toEqual({
            ok: false,
            reason: 'unknown_event_type'
          })
        }

        // Negative controls (plan §10): each security/correctness invariant fails if its check flips
        expect(
          evaluatePreDispatchRecheck({
            actor: `peer:${PEER_A}`,
            principal: `peer:${PEER_A}`,
            cwdMatches: false,
            workspaceAuthorized: true,
            grantValid: true,
            operationGateAcquired: true,
            trustGatePassed: true
          })
        ).toEqual({ ok: false, action: 'fail', reason: 'cwd_changed' })
        expect(
          evaluatePreDispatchRecheck({
            actor: `peer:${PEER_A}`,
            principal: `peer:${PEER_A}`,
            cwdMatches: true,
            workspaceAuthorized: false,
            grantValid: true,
            operationGateAcquired: true,
            trustGatePassed: true
          })
        ).toEqual({ ok: false, action: 'fail', reason: 'workspace_not_authorized' })
        expect(
          evaluatePreDispatchRecheck({
            actor: `peer:${PEER_A}`,
            principal: `peer:${PEER_A}`,
            cwdMatches: true,
            workspaceAuthorized: true,
            grantValid: false,
            operationGateAcquired: true,
            trustGatePassed: true
          })
        ).toEqual({ ok: false, action: 'fail', reason: 'grant_revoked' })
        expect(
          evaluatePreDispatchRecheck({
            actor: `peer:${PEER_A}`,
            principal: `peer:${PEER_A}`,
            cwdMatches: true,
            workspaceAuthorized: true,
            grantValid: true,
            operationGateAcquired: false,
            trustGatePassed: true
          })
        ).toEqual({ ok: false, action: 'requeue', reason: 'provider_authenticating' })
      } finally {
        sink.close()
      }
    })
  })
})
