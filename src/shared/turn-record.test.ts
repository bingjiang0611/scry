import { describe, expect, it } from 'vitest'
import { evidenceStatusMap, isAgentTurnRecord, validateAgentTurnRecord } from './turn-record'
import { creditUsageEvidence } from './credit-usage'

const availableEmpty = () => ({
  status: 'available',
  quality: 'exact',
  source: ['fixture'],
  value: []
})

function record(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    recordKind: 'agent_turn',
    sequence: 1,
    recordId: 'record-1',
    recorderVersion: '0.2.6',
    workspace: { id: 'fixture', root: '/repo' },
    provider: { id: 'codex' },
    sessionId: 'session-1',
    generation: 1,
    turnIndex: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1_000,
    status: 'completed',
    user: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'x' } },
    assistant: { status: 'available', quality: 'exact', source: ['fixture'], value: { text: 'y' } },
    tools: availableEmpty(),
    skills: availableEmpty(),
    mcps: availableEmpty(),
    hooks: availableEmpty(),
    usage: { status: 'unavailable', quality: 'unavailable', source: [] },
    files: availableEmpty(),
    diff: availableEmpty(),
    dangerousOperations: availableEmpty(),
    errors: availableEmpty()
  }
}

describe('AgentTurnRecord strict schema-v1 validation', () => {
  it('keeps legacy root prompts valid while validating supplemental Steer status and image identity', () => {
    const steer = { messageId: 'message-1', prompt: 'supplement', status: 'unknown', message: 'native response unconfirmed', attachments: [{ name: 'screen.png', mimeType: 'image/png', size: 9, sha256: `sha256:${'a'.repeat(64)}` }] }
    const withSteer = (value: unknown) => ({ ...record(), user: { status: 'available', quality: 'exact', source: ['scry_provider_adapter'], value: { text: 'original', steers: [value] } } })
    expect(isAgentTurnRecord(record())).toBe(true)
    expect(isAgentTurnRecord(withSteer(steer))).toBe(true)
    expect(isAgentTurnRecord(withSteer({ ...steer, status: 'completed' }))).toBe(false)
    expect(isAgentTurnRecord(withSteer({ ...steer, status: ['accepted'] }))).toBe(false)
    expect(isAgentTurnRecord(withSteer({ ...steer, attachments: [{ ...steer.attachments[0], mimeType: ['image/png'] }] }))).toBe(false)
    expect(isAgentTurnRecord(withSteer({ ...steer, attachments: [{ ...steer.attachments[0], sha256: 'fake hash' }] }))).toBe(false)
    expect(isAgentTurnRecord(withSteer({ ...steer, attachments: [{ ...steer.attachments[0], size: -1 }] }))).toBe(false)
  })

  it('keeps legacy records valid and validates independent credits without accepting USD/unit/provider confusion', () => {
    expect(isAgentTurnRecord(record())).toBe(true)
    const valid = record()
    valid.provider = { id: 'qoder' }
    const credits = creditUsageEvidence([{ id: 'request', runId: 'run', credits: 1.25 }], 'qoder_sdk')
    valid.usage = { status: 'partial', quality: 'exact', source: ['qoder_sdk'], value: { credits }, omissionReason: 'main requests only' }
    expect(isAgentTurnRecord(valid)).toBe(true)
    for (const value of [{ ...credits.value, unit: 'usd' }, { ...credits.value, amount: -1 }, { ...credits.value, amount: Infinity }]) {
      expect(isAgentTurnRecord({ ...valid, usage: { ...valid.usage as object, value: { credits: { ...credits, value } } } })).toBe(false)
    }
    expect(isAgentTurnRecord({ ...valid, provider: { id: 'codex' } })).toBe(false)
  })

  it.each([
    ['durationMs', Number.NaN],
    ['status', 'unknown'],
    ['startedAt', 'not-a-date'],
    ['recorderVersion', '']
  ])('rejects malformed top-level %s', (field, value) => {
    const malformed = record()
    malformed[field] = value
    const result = validateAgentTurnRecord(malformed)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((issue) => issue.path === `$.${field}`)).toBe(true)
  })

  it('binds provider.modelStatus to the observed model instead of allowing silent absence', () => {
    const observed = record()
    observed.provider = { id: 'codex', model: 'gpt-6-astra', modelStatus: 'observed', modelSource: 'provider_model_event' }
    expect(isAgentTurnRecord(observed)).toBe(true)

    const billed = record()
    billed.provider = { id: 'codex', model: 'gpt-6-astra', modelStatus: 'observed', modelSource: 'usage_event' }
    expect(isAgentTurnRecord(billed)).toBe(true)

    for (const status of ['unobserved', 'incomplete', 'conflict']) {
      const gap = record()
      gap.provider = { id: 'codex', modelStatus: status, modelOmissionReason: 'provider exposed no model id' }
      expect(isAgentTurnRecord(gap)).toBe(true)

      // A gap may never carry a model, a source, or an empty reason: each of
      // those is how "unknown" used to be laundered into a usable value.
      const withModel = record()
      withModel.provider = { id: 'codex', model: 'gpt-6-astra', modelStatus: status, modelOmissionReason: 'x' }
      expect(isAgentTurnRecord(withModel)).toBe(false)
      const withSource = record()
      withSource.provider = { id: 'codex', modelStatus: status, modelSource: 'usage_event', modelOmissionReason: 'x' }
      expect(isAgentTurnRecord(withSource)).toBe(false)
      const withoutReason = record()
      withoutReason.provider = { id: 'codex', modelStatus: status }
      expect(isAgentTurnRecord(withoutReason)).toBe(false)
    }

    const observedWithoutModel = record()
    observedWithoutModel.provider = { id: 'codex', modelStatus: 'observed', modelSource: 'usage_event' }
    expect(isAgentTurnRecord(observedWithoutModel)).toBe(false)
    const sourceWithoutStatus = record()
    sourceWithoutStatus.provider = { id: 'codex', model: 'gpt-6-astra', modelSource: 'usage_event' }
    expect(isAgentTurnRecord(sourceWithoutStatus)).toBe(false)
    // Legacy records that never had the field stay valid; absence is not a claim.
    expect(isAgentTurnRecord(record())).toBe(true)
  })

  it('only accepts a structural turn role, never a role without observation', () => {
    const observed = record()
    observed.turnRoleStatus = 'observed'
    observed.turnRole = { role: 'approval', source: 'codex-guardian', parentId: 'turn-1', reviewedSessionId: 'session-9' }
    expect(isAgentTurnRecord(observed)).toBe(true)

    for (const status of ['unobserved', 'conflict']) {
      const gap = record()
      gap.turnRoleStatus = status
      expect(isAgentTurnRecord(gap)).toBe(true)
      const withRole = record()
      withRole.turnRoleStatus = status
      withRole.turnRole = { role: 'main', source: 'host' }
      expect(isAgentTurnRecord(withRole)).toBe(false)
    }

    const roleWithoutStatus = record()
    roleWithoutStatus.turnRole = { role: 'main', source: 'host' }
    expect(isAgentTurnRecord(roleWithoutStatus)).toBe(false)

    // Free-form prose is not a role: identity cannot come from prompt text.
    const prose = record()
    prose.turnRoleStatus = 'observed'
    prose.turnRole = { role: 'approval history for command ...', source: 'text-regex' }
    expect(isAgentTurnRecord(prose)).toBe(false)
  })

  it('rejects impossible evidence state/value combinations and malformed nested calls', () => {
    const missingValue = record()
    missingValue.tools = { status: 'available', quality: 'exact', source: ['fixture'] }
    expect(isAgentTurnRecord(missingValue)).toBe(false)

    const malformedCall = record()
    malformedCall.tools = {
      status: 'partial',
      quality: 'exact',
      source: ['fixture'],
      omissionReason: 'bounded',
      value: [{ name: 'Bash', status: 'invented' }]
    }
    expect(isAgentTurnRecord(malformedCall)).toBe(false)
  })

  it('validates complete intervention request/response contracts', () => {
    const valid = record()
    valid.interventions = {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: [{
        kind: 'clarification',
        source: 'AskUserQuestion',
        resolution: 'answered',
        openedAt: '2026-01-01T00:00:00.000Z',
        closedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        request: {
          runId: 'run-1',
          questionId: 'question-1',
          providerId: 'codex',
          questionKind: 'clarification',
          questions: [{
            question: 'Proceed?',
            header: 'Decision',
            options: [{ label: 'Yes', description: 'Continue' }],
            multiSelect: false
          }]
        },
        response: {
          runId: 'run-1',
          questionId: 'question-1',
          behavior: 'answered',
          answers: { 'Proceed?': 'Yes' }
        }
      }]
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const missingQuestions = structuredClone(valid)
    ;((missingQuestions.interventions as { value: Array<{ request: Record<string, unknown> }> }).value)[0].request = {}
    expect(isAgentTurnRecord(missingQuestions)).toBe(false)

    const mismatchedResponse = structuredClone(valid)
    ;((mismatchedResponse.interventions as { value: Array<{ response: { questionId: string } }> }).value)[0].response.questionId = 'other'
    expect(isAgentTurnRecord(mismatchedResponse)).toBe(false)
  })

  it('reports modelSegments in the unified evidence map without rejecting older omission', () => {
    const legacy = record()
    if (!isAgentTurnRecord(legacy)) throw new Error('legacy fixture should remain valid')
    expect(evidenceStatusMap(legacy).modelSegments).toBe('unavailable/unavailable')
  })
})

describe('AgentTurnRecord model timing compatibility', () => {
  it('accepts old schema v1 records that predate modelTiming', () => {
    expect(isAgentTurnRecord(record())).toBe(true)
  })

  it('accepts valid optional compactions and rejects malformed token counts', () => {
    const valid = record()
    valid.compactions = {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: [{
        eventId: 'compact-1',
        at: '2026-01-01T00:00:00.000Z',
        trigger: 'auto',
        preTokens: 100,
        postTokens: 20
      }]
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.compactions as { value: Array<{ preTokens: number }> }).value)[0].preTokens = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })

  it('accepts valid optional timing and rejects malformed timing instead of treating it as zero', () => {
    const valid = record()
    valid.modelTiming = {
      status: 'available',
      quality: 'estimated',
      source: ['scry_provider_adapter'],
      value: {
        method: 'response_intervals',
        cumulativeMs: 500,
        occupiedMs: 500,
        overlapMs: 0,
        totalCalls: 1,
        timedCalls: 1,
        root: { totalCalls: 1, timedCalls: 1, cumulativeMs: 500 },
        subagents: { totalCalls: 0, timedCalls: 0 },
        calls: [{
          responseId: 'response-1',
          scope: 'root',
          completedAt: '2026-01-01T00:00:00.500Z',
          durationMs: 500,
          source: 'observed',
          boundary: 'turn_or_activity_end'
        }]
      }
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.modelTiming as { value: { cumulativeMs: unknown } }).value).cumulativeMs = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })

  it('accepts valid optional model segments and rejects malformed ordering', () => {
    const valid = record()
    valid.modelSegments = {
      status: 'available',
      quality: 'exact',
      source: ['fixture'],
      value: [{ order: 0, at: '2026-01-01T00:00:00.000Z', kind: 'text', text: 'working' }]
    }
    expect(isAgentTurnRecord(valid)).toBe(true)

    const malformed = structuredClone(valid)
    ;((malformed.modelSegments as { value: Array<{ order: number }> }).value)[0].order = -1
    expect(isAgentTurnRecord(malformed)).toBe(false)
  })
})
