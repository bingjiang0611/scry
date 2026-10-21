import { describe, expect, it } from 'vitest'
import type { WorkflowLiveObservation } from '../shared/workflow'
import { workflowLiveDiagnostics, WorkflowLiveObservationTracker } from './workflow-live-observation'

const identity = (attemptId: string, runId = `workflow-${attemptId}`) => ({
  taskId: `workflow-1:node-${attemptId}`, attemptId, runId, providerId: 'pi' as const
})

const context = { epoch: 'live-root', revision: 1, observedAt: 100 }
const observe = (tracker: WorkflowLiveObservationTracker, ...events: WorkflowLiveObservation[]) => {
  for (const event of events) tracker.observe(event)
}

describe('WorkflowLiveObservationTracker', () => {
  it('does not accept Pi evidence for a different provider', () => {
    const tracker = new WorkflowLiveObservationTracker({ ...identity('wrong-provider'), providerId: 'codex' })
    expect(tracker.observe({ source: 'pi_native', kind: 'model_progress', channel: 'text' })).toBe(false)
    expect(tracker.snapshot().status).toBe('unavailable')
  })

  it('accepts Claude model progress and rejects wrong provider/lifecycle pairs', () => {
    const claude = new WorkflowLiveObservationTracker({ ...identity('claude-root'), providerId: 'claude' })
    expect(claude.observe({ source: 'claude_native', kind: 'model_progress', channel: 'text' })).toBe(true)
    expect(claude.observe({ source: 'claude_native', kind: 'model_progress', channel: 'thinking' })).toBe(true)
    expect(claude.observe({ source: 'claude_native', kind: 'tool_started', toolCallId: 'tool-not-supported' } as never)).toBe(false)
    expect(claude.snapshot()).toMatchObject({ source: ['claude_native'], status: 'model_progress', modelProgressCount: 2 })

    const pi = new WorkflowLiveObservationTracker(identity('wrong-claude-source'))
    expect(pi.observe({ source: 'claude_native', kind: 'model_progress', channel: 'text' })).toBe(false)
    expect(pi.snapshot().status).toBe('unavailable')
  })

  it('tracks Claude pending-call activity without claiming physical start, and closes only a returned ID', () => {
    const tracker = new WorkflowLiveObservationTracker({ ...identity('claude-pending'), providerId: 'claude' })
    expect(tracker.observe({ source: 'claude_native', kind: 'tool_activity', toolCallId: 'call-1' })).toBe(true)
    expect(tracker.observe({ source: 'claude_native', kind: 'tool_activity', toolCallId: 'call-1' })).toBe(false)
    expect(tracker.snapshot()).toMatchObject({ status: 'tool_wait', activeToolIds: ['call-1'], trackedToolCount: 1 })
    expect(tracker.observe({ source: 'claude_native', kind: 'tool_returned', toolCallId: 'call-1' })).toBe(true)
    expect(tracker.observe({ source: 'claude_native', kind: 'tool_returned', toolCallId: 'call-1' })).toBe(false)
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', activeToolIds: [] })
  })

  it('bounds Claude pending-call IDs and preserves uncertainty after overflowed calls return', () => {
    const oversized = new WorkflowLiveObservationTracker({ ...identity('claude-oversized'), providerId: 'claude' })
    oversized.observe({ source: 'claude_native', kind: 'tool_activity', toolCallId: 'x'.repeat(1024 * 1024) })
    expect(JSON.stringify(oversized.snapshot()).length).toBeLessThan(4096)
    expect(oversized.snapshot()).toMatchObject({ status: 'unknown', truncated: true, trackedToolCount: 0 })
    const tracker = new WorkflowLiveObservationTracker({ ...identity('claude-overflow'), providerId: 'claude' })
    for (let index = 0; index < 33; index++) tracker.observe({ source: 'claude_native', kind: 'tool_activity', toolCallId: `call-${index}` })
    for (let index = 0; index < 32; index++) tracker.observe({ source: 'claude_native', kind: 'tool_returned', toolCallId: `call-${index}` })
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', truncated: true, trackedToolCount: 0 })
  })

  it('rejects Claude lifecycle-shaped aliases and cross-provider activity', () => {
    const claude = new WorkflowLiveObservationTracker({ ...identity('claude-gates'), providerId: 'claude' })
    expect(claude.observe({ source: 'claude_native', kind: 'tool_started', toolCallId: 'call-1' } as never)).toBe(false)
    expect(claude.observe({ source: 'pi_native', kind: 'tool_activity', toolCallId: 'call-1' } as never)).toBe(false)
    expect(claude.snapshot().activeToolIds).toEqual([])
  })

  it('ignores late Claude observations after the attempt closes', () => {
    const tracker = new WorkflowLiveObservationTracker({ ...identity('claude-late'), providerId: 'claude' })
    tracker.close()
    expect(tracker.observe({ source: 'claude_native', kind: 'model_progress', channel: 'text' })).toBe(false)
    expect(tracker.snapshot()).toMatchObject({ status: 'unavailable', modelProgressCount: 0, source: [] })
  })

  it('bounds native ID bytes and reports the observation gap rather than leaking the payload', () => {
    const tracker = new WorkflowLiveObservationTracker(identity('oversize'))
    tracker.observe({ source: 'pi_native', kind: 'tool_started', toolCallId: 'x'.repeat(1024 * 1024) })
    expect(JSON.stringify(tracker.snapshot()).length).toBeLessThan(4096)
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', truncated: true })
  })

  it('does not hide an untracked active tool after the bounded ID set overflows', () => {
    const tracker = new WorkflowLiveObservationTracker(identity('overflow'))
    for (let index = 0; index < 33; index++) tracker.observe({ source: 'pi_native', kind: 'tool_started', toolCallId: `tool-${index}` })
    for (let index = 0; index < 32; index++) tracker.observe({ source: 'pi_native', kind: 'tool_ended', toolCallId: `tool-${index}` })
    tracker.observe({ source: 'pi_native', kind: 'model_progress', channel: 'text' })
    expect(tracker.snapshot()).toMatchObject({ status: 'unknown', truncated: true, trackedToolCount: 0 })
    expect(tracker.snapshot().activeToolIds).toEqual([])
  })

  it('keeps colliding tool IDs and late events fenced to their attempt', () => {
    const first = new WorkflowLiveObservationTracker(identity('attempt-a'))
    const second = new WorkflowLiveObservationTracker(identity('attempt-b'))
    const start = { source: 'pi_native', kind: 'tool_started', toolCallId: 'same-id' } as const
    observe(first, start)
    observe(second, start)
    expect(first.snapshot().activeToolIds).toEqual(['same-id'])
    expect(second.snapshot().activeToolIds).toEqual(['same-id'])
    expect(first.observe({ source: 'pi_native', kind: 'tool_ended', toolCallId: 'same-id' })).toBe(true)
    expect(second.snapshot().status).toBe('tool_wait')
    first.close()
    expect(first.observe({ source: 'pi_native', kind: 'model_progress', channel: 'text' })).toBe(false)
    expect(first.snapshot().modelProgressCount).toBe(0)
  })

  it('preserves overlapping tools and permissions, then becomes unknown instead of guessing model resumed', () => {
    const tracker = new WorkflowLiveObservationTracker(identity('attempt-overlap'))
    observe(tracker,
      { source: 'pi_native', kind: 'tool_started', toolCallId: 'tool-a' },
      { source: 'pi_native', kind: 'tool_started', toolCallId: 'tool-b' },
      { source: 'main_permission', kind: 'permission_started', permissionId: 'permission-a' },
      { source: 'main_permission', kind: 'permission_started', permissionId: 'permission-b' })
    expect(tracker.snapshot()).toMatchObject({ status: 'permission_wait', activeToolIds: ['tool-a', 'tool-b'], activePermissionIds: ['permission-a', 'permission-b'] })
    tracker.observe({ source: 'main_permission', kind: 'permission_ended', permissionId: 'permission-a' })
    expect(tracker.snapshot().status).toBe('permission_wait')
    tracker.observe({ source: 'main_permission', kind: 'permission_ended', permissionId: 'permission-b' })
    expect(tracker.snapshot()).toMatchObject({ status: 'tool_wait', activeToolIds: ['tool-a', 'tool-b'], activePermissionIds: [] })
    tracker.observe({ source: 'pi_native', kind: 'tool_ended', toolCallId: 'tool-a' })
    tracker.observe({ source: 'pi_native', kind: 'tool_ended', toolCallId: 'tool-b' })
    expect(tracker.snapshot().status).toBe('unknown')
  })

  it('counts only genuine native deltas and reports unsupported automatic stall detection', () => {
    const tracker = new WorkflowLiveObservationTracker(identity('attempt-progress'))
    expect(tracker.snapshot().status).toBe('unavailable')
    observe(tracker,
      { source: 'pi_native', kind: 'model_progress', channel: 'text' },
      { source: 'pi_native', kind: 'model_progress', channel: 'thinking' })
    expect(tracker.snapshot()).toMatchObject({ status: 'model_progress', modelProgressCount: 2 })
    const diagnostics = workflowLiveDiagnostics([tracker.snapshot()], context)
    expect(diagnostics).toMatchObject({ status: 'model_progress', coverage: 'partial', automaticStall: 'unsupported' })
    // Buffered snapshots, heartbeats, retries and empty deltas have no observation variant;
    // they therefore cannot increment modelProgressCount or establish model/quota waiting.
    expect(tracker.snapshot().modelProgressCount).toBe(2)
  })

  it('keeps missing provider callbacks unavailable rather than inventing coverage', () => {
    const tracker = new WorkflowLiveObservationTracker(identity('attempt-no-native'))
    const diagnostics = workflowLiveDiagnostics([tracker.snapshot()], context)
    expect(diagnostics.status).toBe('unavailable')
    expect(diagnostics.coverage).toBe('unavailable')
    expect(diagnostics.automaticStall).toBe('unsupported')
  })
})
