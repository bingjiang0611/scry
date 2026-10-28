import { describe, expect, it } from 'vitest'
import { projectSettledWorkflowTerminal } from './app-run-start'

const structuredOutput = { source: 'claude_sdk_success_result' as const, json: '{"decision":"workflow"}' }
const archiveRef = 'run:canonical-run:session:canonical-session'

describe('App-owned settled Workflow terminal projection', () => {
  it.each([
    { status: 'completed', archived: true, blocked: false, recordingFailed: false, expected: 'completed', canonical: true },
    { status: 'completed', archived: false, blocked: false, recordingFailed: false, expected: 'unknown', canonical: false },
    { status: 'completed', archived: true, blocked: true, recordingFailed: false, expected: 'blocked', canonical: false },
    { status: 'completed', archived: true, blocked: false, recordingFailed: true, expected: 'unknown', canonical: false },
    { status: 'failed', archived: true, blocked: false, recordingFailed: false, expected: 'failed', canonical: false },
    { status: 'interrupted', archived: true, blocked: false, recordingFailed: false, expected: 'interrupted', canonical: false },
    { status: 'cancelled', archived: true, blocked: false, recordingFailed: false, expected: 'unknown', canonical: false }
  ] as const)('preserves $status with archive=$archived blocked=$blocked recordingFailed=$recordingFailed', ({ status, archived, blocked, recordingFailed, expected, canonical }) => {
    const result = projectSettledWorkflowTerminal({ runId: 'canonical-run', status, items: [],
      ...(archived ? { archiveRef } : {}), structuredOutput, interactionBlocked: blocked, recordingFailed })
    expect(result.status).toBe(expected)
    expect(result.settled).toBe(true)
    if (canonical) expect(result.structuredOutput).toEqual(structuredOutput)
    else expect(result).not.toHaveProperty('structuredOutput')
    if (archived) expect(result.archiveRef).toBe(archiveRef)
    else expect(result).not.toHaveProperty('archiveRef')
    expect(result).not.toHaveProperty('interactionBlocked')
    expect(result).not.toHaveProperty('recordingFailed')
  })

  it('does not invent structured evidence for an ordinary completed run', () => {
    const items: [] = []
    const result = projectSettledWorkflowTerminal({ runId: 'ordinary-run', status: 'completed', items,
      archiveRef, interactionBlocked: false, recordingFailed: false })
    expect(result.status).toBe('completed')
    expect(result.items).toEqual(items)
    expect(result.items).not.toBe(items)
    expect(result).not.toHaveProperty('structuredOutput')
  })
})
