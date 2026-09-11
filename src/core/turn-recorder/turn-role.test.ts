import { describe, expect, it } from 'vitest'
import { lifecycleTraceEvents } from './recorder'

function events(payload: Record<string, unknown>) {
  return lifecycleTraceEvents({
    provider: 'codex',
    event: 'Stop',
    payload: { session_id: 'session-1', ...payload },
    runId: 'run-1',
    captureOutput: false
  }).filter((event) => event.stage === 'turn_role')
}

describe('turn_role structural input', () => {
  it('accepts a bounded role from the same session', () => {
    const [event] = events({
      turn_role: {
        session_id: 'session-1',
        role: 'approval',
        source: 'codex-guardian',
        parent_id: 'turn-1',
        reviewed_session_id: 'session-9'
      }
    })
    expect(event.runtimeMetadata).toEqual({
      role: 'approval',
      roleSource: 'codex-guardian',
      roleParentId: 'turn-1',
      reviewedSessionId: 'session-9'
    })
  })

  it('emits nothing when the host supplies no role, so absence stays absence', () => {
    expect(events({})).toEqual([])
  })

  it('marks a role from another session invalid instead of accepting it', () => {
    const [event] = events({
      turn_role: { session_id: 'other-session', role: 'main', source: 'host' }
    })
    expect(event.runtimeMetadata).toEqual({ invalid: true })
  })

  it('rejects free-form prose and oversized values as roles', () => {
    for (const role of ['approval history for command echo hi', 'a'.repeat(200), '', 42]) {
      const [event] = events({ turn_role: { session_id: 'session-1', role, source: 'host' } })
      expect(event.runtimeMetadata).toEqual({ invalid: true })
    }
  })

  it('requires a source: a role with no provenance is not observation', () => {
    const [event] = events({ turn_role: { session_id: 'session-1', role: 'main' } })
    expect(event.runtimeMetadata).toEqual({ invalid: true })
  })

  it('ignores a subagent-scoped payload, matching task_context isolation', () => {
    const scoped = lifecycleTraceEvents({
      provider: 'codex',
      event: 'Stop',
      payload: {
        session_id: 'session-1',
        agent_id: 'sub-1',
        turn_role: { session_id: 'session-1', role: 'main', source: 'host' }
      },
      runId: 'run-1',
      captureOutput: false
    }).filter((event) => event.stage === 'turn_role')
    expect(scoped).toEqual([])
  })
})
