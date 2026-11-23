import { describe, expect, it } from 'vitest'
import {
  agentCommandId,
  PerRunRateLimiter,
  readDelegationLimits
} from './delegation-limits'

describe('P6-1 delegation limits, rate limiter, and agent command idempotency (D7, D20)', () => {
  it('computes deterministic UUID-shaped command IDs scoped to tool + actorRunId + clientRequestId', () => {
    const id1 = agentCommandId('scry_task_delegate', 'run-A', 'req-1')
    const id2 = agentCommandId('scry_task_delegate', 'run-A', 'req-1')
    const idNextRun = agentCommandId('scry_task_delegate', 'run-B', 'req-1')
    const idOtherTool = agentCommandId('scry_task_cancel', 'run-A', 'req-1')

    expect(id1).toBe(id2)
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(idNextRun).not.toBe(id1)
    expect(idOtherTool).not.toBe(id1)
  })

  it('enforces sliding-window per-run read/write rate limits with retryAfterMs', () => {
    let now = 10_000
    const limiter = new PerRunRateLimiter({ writePerMinute: 2, readPerMinute: 3, clock: () => now })

    expect(limiter.consume('run-1', 'write')).toEqual({ ok: true })
    now += 1_000
    expect(limiter.consume('run-1', 'write')).toEqual({ ok: true })
    now += 1_000
    const blocked = limiter.consume('run-1', 'write')
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfterMs).toBeGreaterThan(50_000)

    // Different run is unaffected
    expect(limiter.consume('run-2', 'write')).toEqual({ ok: true })

    // Read limit is independent of write limit
    expect(limiter.consume('run-1', 'read')).toEqual({ ok: true })
    expect(limiter.consume('run-1', 'read')).toEqual({ ok: true })
    expect(limiter.consume('run-1', 'read')).toEqual({ ok: true })
    expect(limiter.consume('run-1', 'read').ok).toBe(false)

    // After 60s window expires, writes succeed again
    now += 60_000
    expect(limiter.consume('run-1', 'write')).toEqual({ ok: true })
  })

  it('reads defaults and allows bounded env overrides for tests', () => {
    const defaults = readDelegationLimits({})
    expect(defaults).toEqual({
      maxDepth: 1,
      maxConcurrentPerParentRun: 4,
      maxTotalPerParentRun: 8,
      maxHostAgentRuns: 8,
      writePerMinute: 6,
      readPerMinute: 60,
      interactionTimeoutMs: 30 * 60_000,
      maxWaitMs: 20_000
    })

    const overridden = readDelegationLimits({
      SCRY_P6_MAX_CONCURRENT_PER_PARENT: '2',
      SCRY_P6_MAX_TOTAL_PER_PARENT: '3',
      SCRY_P6_MAX_HOST_AGENT_RUNS: '4',
      SCRY_P6_WRITE_RATE_LIMIT: '5',
      SCRY_P6_READ_RATE_LIMIT: '10',
      SCRY_P6_INTERACTION_TIMEOUT_MS: '500'
    })
    expect(overridden.maxConcurrentPerParentRun).toBe(2)
    expect(overridden.maxTotalPerParentRun).toBe(3)
    expect(overridden.maxHostAgentRuns).toBe(4)
    expect(overridden.writePerMinute).toBe(5)
    expect(overridden.readPerMinute).toBe(10)
    expect(overridden.interactionTimeoutMs).toBe(500)
  })
})
