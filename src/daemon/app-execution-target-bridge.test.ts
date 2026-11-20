import { describe, expect, it } from 'vitest'
import {
  createAppExecutionTargetBridge,
  EXECUTION_TARGET_CALL_TIMEOUT_MS,
  EXECUTION_TARGET_SUBMIT_TIMEOUT_MS,
  MAX_EXECUTION_TARGET_RESULT_BYTES
} from './app-execution-target-bridge'
import { DEFAULT_MAX_FRAME } from '../main/remote/inner-mtls-protocol'

const TARGET = { id: 'conn-mac2', binding: 'b'.repeat(64) }

describe('AppExecutionTargetBridge edge contracts (W10 follow-ups)', () => {
  it('uses >=45s default timeout and a wider mobileSubmit timeout above App lane ceilings', () => {
    expect(EXECUTION_TARGET_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000)
    expect(EXECUTION_TARGET_SUBMIT_TIMEOUT_MS).toBeGreaterThan(EXECUTION_TARGET_CALL_TIMEOUT_MS)
    expect(MAX_EXECUTION_TARGET_RESULT_BYTES).toBeLessThan(DEFAULT_MAX_FRAME)
  })

  it('returns [] from executionTargets on gateway_offline, timeout, and bridge_busy without erroring', async () => {
    const bridge = createAppExecutionTargetBridge({
      isPrimaryAppPeer: (peer) => peer === 'app-1',
      callTimeoutMs: 40,
      detachGraceMs: 5_000
    })
    try {
      // 1. App disconnects while discovery is in-flight -> returns [] instead of rejecting.
      const poll1 = bridge.localHandlers.poll('app-1', 5_000)
      const discOffline = bridge.client.executionTargets()
      const work1 = await poll1
      expect(work1.calls).toHaveLength(1)
      bridge.onPeerDisconnected('app-1')
      await expect(discOffline).resolves.toEqual([])

      // 2. App stalls past timeout during discovery -> returns [] instead of rejecting.
      const poll2 = bridge.localHandlers.poll('app-1', 5_000)
      const discTimeout = bridge.client.executionTargets()
      const work2 = await poll2
      expect(work2.calls).toHaveLength(1)
      await expect(discTimeout).resolves.toEqual([])

      // 3. Queue saturated (bridge_busy) -> discovery still returns [], while target request rejects.
      const bridgeBusy = createAppExecutionTargetBridge({
        isPrimaryAppPeer: (peer) => peer === 'app-1',
        callTimeoutMs: 5_000,
        detachGraceMs: 5_000
      })
      try {
        await bridgeBusy.localHandlers.poll('app-1', 0)
        const fillers = Array.from({ length: 64 }, () =>
          bridgeBusy.client.mobileRequest(TARGET, { op: 'projects' }).catch(() => undefined)
        )
        await expect(bridgeBusy.client.executionTargets()).resolves.toEqual([])
        await expect(bridgeBusy.client.mobileRequest(TARGET, { op: 'projects' })).rejects.toThrow('execution_target_bridge_busy')
        bridgeBusy.close()
        await Promise.all(fillers)
      } finally {
        bridgeBusy.close()
      }
    } finally {
      bridge.close()
    }
  })

  it('gives mobileSubmit its own wider deadline beyond callTimeoutMs', async () => {
    const bridge = createAppExecutionTargetBridge({
      isPrimaryAppPeer: (peer) => peer === 'app-1',
      callTimeoutMs: 40,
      submitTimeoutMs: 250,
      detachGraceMs: 5_000
    })
    try {
      const poll = bridge.localHandlers.poll('app-1', 5_000)
      const submit = bridge.client.mobileSubmit({
        target: TARGET,
        phonePeerFingerprint: 'a'.repeat(64),
        phoneIntentId: '123e4567-e89b-42d3-a456-426614174000',
        payloadHash: 'c'.repeat(64),
        request: { op: 'submit', intentId: '123e4567-e89b-42d3-a456-426614174000', detail: '{}' }
      })
      const work = await poll
      expect(work.calls).toHaveLength(1)
      // Wait past callTimeoutMs (40ms) but well before submitTimeoutMs (250ms).
      await new Promise((r) => setTimeout(r, 80))
      const ack = bridge.localHandlers.submitResult('app-1', {
        callId: work.calls[0]!.callId,
        ok: true,
        result: { runId: 'run-slow-submit', status: 'recorded' }
      })
      expect(ack).toEqual({ accepted: true })
      await expect(submit).resolves.toEqual({ runId: 'run-slow-submit', status: 'recorded' })
    } finally {
      bridge.close()
    }
  })

  it('supersedes an older waiting poll when a new poll arrives so stale polls cannot steal work', async () => {
    const bridge = createAppExecutionTargetBridge({
      isPrimaryAppPeer: (peer) => peer === 'app-1',
      callTimeoutMs: 5_000,
      detachGraceMs: 5_000
    })
    try {
      const stalePoll = bridge.localHandlers.poll('app-1', 5_000)
      const freshPoll = bridge.localHandlers.poll('app-1', 5_000)

      // The older waiting poll must wake immediately with no calls.
      await expect(stalePoll).resolves.toEqual({ calls: [] })

      const req = bridge.client.mobileRequest(TARGET, { op: 'projects' })
      const delivered = await freshPoll
      expect(delivered.calls).toHaveLength(1)
      bridge.localHandlers.submitResult('app-1', {
        callId: delivered.calls[0]!.callId,
        ok: true,
        result: { projects: [] }
      })
      await expect(req).resolves.toEqual({ projects: [] })
    } finally {
      bridge.close()
    }
  })

  it('cancels a waiting poll immediately when its connection signal aborts', async () => {
    const bridge = createAppExecutionTargetBridge({
      isPrimaryAppPeer: (peer) => peer === 'app-1',
      callTimeoutMs: 5_000,
      detachGraceMs: 5_000
    })
    try {
      const conn1 = new AbortController()
      const deadPoll = bridge.localHandlers.poll('app-1', 5_000, conn1.signal)
      conn1.abort()
      await expect(deadPoll).resolves.toEqual({ calls: [] })

      // A call queued during the brief gap before the replacement poll reconnects must go to poll #2.
      const req = bridge.client.mobileRequest(TARGET, { op: 'projects' })
      const work = await bridge.localHandlers.poll('app-1', 5_000)
      expect(work.calls).toHaveLength(1)
      bridge.localHandlers.submitResult('app-1', {
        callId: work.calls[0]!.callId,
        ok: true,
        result: { projects: ['ok'] }
      })
      await expect(req).resolves.toEqual({ projects: ['ok'] })
    } finally {
      bridge.close()
    }
  })

  it('enforces ownerPeer binding on submitResult and immediately rejects oversized results', async () => {
    const bridge = createAppExecutionTargetBridge({
      isPrimaryAppPeer: (peer) => peer === 'app-a' || peer === 'app-b',
      callTimeoutMs: 10_000,
      detachGraceMs: 5_000
    })
    try {
      const poll = bridge.localHandlers.poll('app-a', 5_000)
      const req = bridge.client.mobileRequest(TARGET, { op: 'projects' })
      const work = await poll
      const callId = work.calls[0]!.callId

      // Different authorized peer cannot hijack or resolve app-a's in-flight call.
      expect(bridge.localHandlers.submitResult('app-b', {
        callId,
        ok: true,
        result: { projects: ['hijacked'] }
      })).toEqual({ accepted: false })

      // Oversized result from the owning peer fails the call immediately (not after 10s timeout).
      const started = Date.now()
      const oversized = 'x'.repeat(MAX_EXECUTION_TARGET_RESULT_BYTES + 1)
      expect(() => bridge.localHandlers.submitResult('app-a', {
        callId,
        ok: true,
        result: { blob: oversized }
      })).toThrow('execution_target_response_too_large')
      await expect(req).rejects.toThrow('execution_target_response_too_large')
      expect(Date.now() - started).toBeLessThan(1_000)
    } finally {
      bridge.close()
    }
  })
})
