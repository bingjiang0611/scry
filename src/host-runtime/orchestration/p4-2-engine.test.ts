import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunRegistry } from '../../main/run-registry'
import { AuthorityEngine } from './authority-engine'
import { canonicalJson, sha256Hex } from './canonical-json'
import { EventSink } from './event-sink'
import { INLINE_BODY_MAX_BYTES } from './types'

const PEER_A = 'a'.repeat(64)

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'scry-p4-2-engine-'))
  try {
    return await run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('P4-2 AuthorityEngine submit, pre-dispatch recheck, resolveIntent, and fence', () => {
  it('persists >16 KiB body before commit, commits 2 pre-first-token tx, and enforces pre-dispatch recheck', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)

      const timings: Array<{ commitKind: string; preFirstToken: boolean }> = []
      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine = new AuthorityEngine({
        sink,
        leaseOwner: 'daemon:test',
        onCommitTiming: (sample) => timings.push({ commitKind: sample.commitKind, preFirstToken: sample.preFirstToken })
      })
      try {
        const bigDetail = JSON.stringify({
          providerId: 'codex',
          cwd: realWs,
          prompt: 'large prompt',
          blob: 'X'.repeat(INLINE_BODY_MAX_BYTES + 2048)
        })
        const submitRes = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-big-1',
          detail: bigDetail
        })
        expect(submitRes.kind).toBe('accepted')
        if (submitRes.kind !== 'accepted') return

        const run = sink.getRun(submitRes.runId)!
        expect(run.lifecycle).toBe('recorded')
        expect(run.body?.storage).toBe('external')
        expect(sink.bodyStore.hasExternalBody(run.body!.sha256)).toBe(true)

        const dispatch = engine.beforeDispatch({
          runId: submitRes.runId,
          cwd: realWs,
          provider: 'codex',
          profile: null,
          actor: `peer:${PEER_A}`,
          authorizeWorkspace: (p) => p,
          isPeerAuthorized: (p) => p === PEER_A,
          isProviderAuthenticating: () => false,
          verifyTrustGate: () => true
        })
        expect(dispatch).toEqual({ ok: true })
        expect(sink.getRun(submitRes.runId)?.lifecycle).toBe('dispatched')
        expect(timings.filter((t) => t.preFirstToken).map((t) => t.commitKind)).toEqual([
          'intent_recorded',
          'admitted_and_dispatched'
        ])

        engine.recordTerminal({ runId: submitRes.runId, step: 'settled', evidence: ['provider:codex'] })
        expect(sink.getRun(submitRes.runId)?.lifecycle).toBe('settled')
        expect(sink.verifyReplayConsistency()).toEqual({ matches: true })
      } finally {
        sink.close()
      }
    })
  })

  it('rejects dispatch when cwd symlink target changed, grant revoked, or trust gate failed', async () => {
    await withTempDir(async (userData) => {
      const ws1 = join(userData, 'ws1')
      const ws2 = join(userData, 'ws2')
      mkdirSync(ws1, { recursive: true })
      mkdirSync(ws2, { recursive: true })
      const link = join(userData, 'ws-link')
      symlinkSync(ws1, link)

      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine = new AuthorityEngine({ sink, leaseOwner: 'daemon:test' })
      try {
        const s1 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-revoked',
          detail: JSON.stringify({ providerId: 'codex', cwd: realpathSync(ws1), prompt: 'hi' })
        })
        expect(s1.kind).toBe('accepted')
        if (s1.kind !== 'accepted') return
        const d1 = engine.beforeDispatch({
          runId: s1.runId,
          cwd: realpathSync(ws1),
          provider: 'codex',
          profile: null,
          actor: `peer:${PEER_A}`,
          authorizeWorkspace: (p) => p,
          isPeerAuthorized: () => false,
          isProviderAuthenticating: () => false,
          verifyTrustGate: () => true
        })
        expect(d1).toEqual({ ok: false, action: 'fail', reason: 'grant_revoked' })
        expect(sink.getRun(s1.runId)?.lifecycle).toBe('failed')

        const s2 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-cwd-changed',
          detail: JSON.stringify({ providerId: 'codex', cwd: link, prompt: 'hi' })
        })
        expect(s2.kind).toBe('accepted')
        if (s2.kind !== 'accepted') return
        rmSync(link)
        symlinkSync(ws2, link)
        const d2 = engine.beforeDispatch({
          runId: s2.runId,
          cwd: link,
          provider: 'codex',
          profile: null,
          actor: `peer:${PEER_A}`,
          authorizeWorkspace: (p) => realpathSync(p),
          isPeerAuthorized: () => true,
          isProviderAuthenticating: () => false,
          verifyTrustGate: () => true
        })
        expect(d2).toEqual({ ok: false, action: 'fail', reason: 'cwd_changed' })
        expect(sink.getRun(s2.runId)?.lifecycle).toBe('failed')

        const s3 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-trust-fail',
          detail: JSON.stringify({ providerId: 'codex', cwd: realpathSync(ws1), prompt: 'hi' })
        })
        expect(s3.kind).toBe('accepted')
        if (s3.kind !== 'accepted') return
        const d3 = engine.beforeDispatch({
          runId: s3.runId,
          cwd: realpathSync(ws1),
          provider: 'codex',
          profile: null,
          actor: `peer:${PEER_A}`,
          authorizeWorkspace: (p) => p,
          isPeerAuthorized: () => true,
          isProviderAuthenticating: () => false,
          verifyTrustGate: () => false
        })
        expect(d3).toEqual({ ok: false, action: 'fail', reason: 'trust_gate_rejected' })
        expect(sink.getRun(s3.runId)?.lifecycle).toBe('failed')
      } finally {
        sink.close()
      }
    })
  })

  it('writes permanent resolveIntent tombstone blocking late submit and supports legacy system receipt fallback', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      const sink = EventSink.open({ userDataDir: userData, checkpointIntervalMs: 0 })
      const engine = new AuthorityEngine({ sink, leaseOwner: 'daemon:test' })
      try {
        const resolved = engine.resolveIntent({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'lost-intent-1'
        })
        expect(resolved.state).toBe('cancelled')

        const late = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'lost-intent-1',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'late' })
        })
        expect(late).toMatchObject({ kind: 'rejected', reason: 'command_payload_conflict', sticky: true })

        // A pre-upgrade receipt has no original payload hash. Resolve it without reaccepting a send.
        const legacyPayload = {
          runId: 'legacy-run-1',
          sessionKey: null,
          provider: 'codex',
          profile: null,
          cwd: realWs,
          claimMode: 'immediate' as const,
          origin: 'remote' as const,
          shadowOnly: true
        }
        sink.execute({
          type: 'run.submit',
          commandId: 'legacy-scoped-intent-9',
          actor: 'system',
          scope: 'remote',
          at: 1_700_000_000_000,
          payload: legacyPayload,
          payloadSha256: sha256Hex(canonicalJson(legacyPayload))
        })
        const retry = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'legacy-scoped-intent-9',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'retry' })
        })
        expect(retry).toMatchObject({ kind: 'rejected', reason: 'command_payload_conflict' })
        expect(engine.resolveIntent({ peerCertSHA256: PEER_A, grantScope: 'remote', commandId: 'legacy-scoped-intent-9' }))
          .toMatchObject({ runId: 'legacy-run-1' })
      } finally {
        sink.close()
      }
    })
  })

  it('keeps tightening-only stop working during storage write-indeterminate fence', async () => {
    await withTempDir(async (userData) => {
      const ws = join(userData, 'ws')
      mkdirSync(ws, { recursive: true })
      const realWs = realpathSync(ws)
      let failNextCommit = false
      const sink = EventSink.open({
        userDataDir: userData,
        checkpointIntervalMs: 0,
        beforeCommitHook: () => {
          if (failNextCommit) throw new Error('SQLITE_IOERR: simulated disk failure')
        }
      })
      const engine = new AuthorityEngine({ sink, leaseOwner: 'daemon:test' })
      const registry = new RunRegistry<{ runId: string; done: boolean; parentRunId?: string }, { runId: string; stop(): void }>()
      let stoppedCount = 0
      try {
        const s1 = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-fence-1',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'run' })
        })
        expect(s1.kind).toBe('accepted')
        if (s1.kind !== 'accepted') return
        registry.register(
          { runId: s1.runId, done: false },
          { runId: s1.runId, stop: () => { stoppedCount += 1 } }
        )
        failNextCommit = true
        expect(() =>
          engine.beforeDispatch({
            runId: s1.runId,
            cwd: realWs,
            provider: 'codex',
            profile: null,
            actor: `peer:${PEER_A}`,
            authorizeWorkspace: (p) => p,
            isPeerAuthorized: () => true,
            isProviderAuthenticating: () => false,
            verifyTrustGate: () => true
          })
        ).toThrow()
        expect(sink.isWriteIndeterminate()).toBe(true)

        const blocked = await engine.submitAsync({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          commandId: 'intent-after-fence',
          detail: JSON.stringify({ providerId: 'codex', cwd: realWs, prompt: 'blocked' })
        })
        expect(blocked).toMatchObject({ kind: 'rejected', reason: 'orchestration_write_indeterminate', sticky: false })

        let liveAborted = false
        const stopRes = engine.stopRun({
          peerCertSHA256: PEER_A,
          grantScope: 'remote',
          runId: s1.runId,
          registry,
          stopControl: (c) => c.stop(),
          abortLive: () => {
            liveAborted = true
            return true
          }
        })
        expect(stopRes.status).toBe('requested')
        expect(stoppedCount).toBe(1)
        expect(liveAborted).toBe(true)
      } finally {
        sink.close()
      }
    })
  })
})
