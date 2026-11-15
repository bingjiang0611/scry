import { describe, expect, it } from 'vitest'
import type { AgentStopState } from '@shared/runtime'
import { RUN_STOP_COPY } from './constants/copy'
import { runStopStatus } from './run-stop-status'

describe('runStopStatus with a local stop press', () => {
  it('shows the press at once without claiming the run stopped', () => {
    const status = runStopStatus(undefined, false, { runId: 'r1', status: 'sending' })
    expect(status.tone).toBe('stopping')
    expect(status.label).toBe(RUN_STOP_COPY.requesting.label)
    expect(status.providerSettled).toBe(false)
  })

  it('says the request did not go out, keeps the run unsettled, and allows another press', () => {
    const status = runStopStatus(undefined, false, { runId: 'r1', status: 'failed', reason: 'IPC 不可用' })
    expect(status.tone).toBe('unsettled')
    expect(status.hint).toContain('IPC 不可用')
    expect(status.providerSettled).toBe(false)
  })

  it('lets main’s own stop phase take over from the local press', () => {
    const state = { phase: 'interrupt_requested', providerId: 'claude' } as AgentStopState
    expect(runStopStatus(state, false, { runId: 'r1', status: 'sending' }).label).toBe('停止中')
  })

  it('still reports finalizing once the Provider has ended', () => {
    expect(runStopStatus(undefined, true, { runId: 'r1', status: 'sending' }).tone).toBe('finalizing')
  })
})
