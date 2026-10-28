import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKFLOW_MAX_VALUE_BYTES } from '../shared/workflow'
import { runAgent } from './agent-runner'

const sdk = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdk.query }))
const schema = { type: 'object', properties: { decision: { type: 'string' } } }
const success = (structured_output?: unknown) => ({
  type: 'result', subtype: 'success', is_error: false, session_id: 'structured-session',
  result: 'plain text is not a canonical candidate', ...(structured_output === undefined ? {} : { structured_output })
})
function query(messages: unknown[], afterYield?: () => void) {
  return {
    close: vi.fn(), interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) { yield message; afterYield?.() }
    }
  }
}
beforeEach(() => sdk.query.mockReset())

describe('canonical structured SDK result', () => {
  it('captures the success-result JSON once, independently of later SDK object mutation', async () => {
    const candidate = { decision: 'workflow', nested: { value: 'original' } }
    sdk.query.mockReturnValue(query([success(candidate)], () => { candidate.nested.value = 'changed' }))
    const result = await runAgent('author', 'structured-result', vi.fn(), { authoringSchema: schema }).promise
    expect(result).toHaveProperty('structuredOutput', {
      source: 'claude_sdk_success_result', json: '{"decision":"workflow","nested":{"value":"original"}}'
    })
    expect(result.status).toBe('completed')
  })

  it.each([
    { name: 'ordinary query', options: {}, message: success({ decision: 'direct' }), status: 'completed' },
    { name: 'missing SDK field', options: { authoringSchema: schema }, message: success(), status: 'completed' },
    { name: 'failed SDK turn', options: { authoringSchema: schema }, message: { ...success({ decision: 'direct' }), subtype: 'error_during_execution' }, status: 'failed' },
    { name: 'SDK error flag', options: { authoringSchema: schema }, message: { ...success({ decision: 'direct' }), is_error: true }, status: 'failed' }
  ])('does not invent a candidate for $name', async ({ options, message, status }) => {
    sdk.query.mockReturnValue(query([message]))
    const result = await runAgent('author', 'no-canonical-result', vi.fn(), options).promise
    expect(result).not.toHaveProperty('structuredOutput')
    expect(result.status).toBe(status)
  })

  it('rejects oversized UTF-8 result JSON instead of truncating or using assistant text', async () => {
    sdk.query.mockReturnValue(query([success({ value: '界'.repeat(Math.ceil(WORKFLOW_MAX_VALUE_BYTES / 3)) })]))
    await expect(runAgent('author', 'oversized-result', vi.fn(), { authoringSchema: schema }).promise).rejects.toThrow('4 MiB')
  })

  it('does not publish a canonical candidate after interruption', async () => {
    sdk.query.mockReturnValue(query([success({ decision: 'direct' })]))
    const handle = runAgent('author', 'interrupted-result', vi.fn(), { authoringSchema: schema })
    handle.interrupt()
    const result = await handle.promise
    expect(result.status).toBe('interrupted')
    expect(result).not.toHaveProperty('structuredOutput')
  })
})
