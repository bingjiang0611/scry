import { describe, expect, it } from 'vitest'
import { parseMcp, type TraceEvent } from '../../shared/trace.js'
import { isToolContent } from '../../shared/tool-content.js'
import { aggregateTurnEvidence } from './aggregate.js'
import { captureToolContent, sanitizeToolEvents } from './tool-content.js'

const policy = { toolOutput: 'full' as const }
function events(output?: string, input: unknown = { command: 'echo hello' }): TraceEvent[] {
  return [
    { id: 'a', runId: 'r', ts: '2026-01-01T00:00:00Z', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 't', input },
    { id: 'b', runId: 'r', ts: '2026-01-01T00:00:01Z', kind: 'tool', stage: 'tool_result', toolUseId: 't', output }
  ]
}

describe('full raw tool content', () => {
  it('keeps output beyond 500 characters, independently of input', () => {
    const output = '正文😀'.repeat(400)
    const evidence = aggregateTurnEvidence({ events: events(output), toolContentPolicy: policy })
    const call = evidence.tools.value![0]
    expect(call.outputContent).toMatchObject({ content: output, savedBytes: Buffer.byteLength(output), storage: 'complete', sourceCompleteness: 'unknown' })
    expect(call.inputContent?.content).toBe('{"command":"echo hello"}')
    expect(call.input).toBeUndefined()
    expect(call.outputSummary?.length).toBe(501)
    expect(isToolContent(call.outputContent)).toBe(true)
  })

  it('preserves nested objects, headers, URL query/userinfo, form and private keys', () => {
    const secrets = ['password-value', 'auth-value', 'cookie-value', 'query-value', 'uri-value', 'form-value', 'pem-value']
    const input = { nested: { password: secrets[0] }, token: 'token-value' }
    const output = `${'x'.repeat(600)}\nAuthorization: Bearer ${secrets[1]}\nCookie: sid=${secrets[2]}\nhttps://user:${secrets[4]}@example.com/path?q=${secrets[3]}&foo=bar\npassword=${secrets[5]}\n-----BEGIN PRIVATE KEY-----\n${secrets[6]}\n-----END PRIVATE KEY-----`
    const safe = sanitizeToolEvents(events(output, input), policy, 'fixture')
    const serialized = JSON.stringify(safe)
    for (const secret of [...secrets, 'token-value']) expect(serialized).toContain(secret)
    expect(safe[1].outputContent?.redaction).toBe('disabled')
    expect(safe[1].output).toBe(output)
    expect(safe[0].input).toEqual(input)
    expect(sanitizeToolEvents(safe, policy, 'fixture')).toEqual(safe)
  })

  it('preserves body-derived Agent display aliases and correlation IDs', () => {
    const raw = events('ok', { description: 'password=AGENT_SENTINEL' })
    raw[0].kind = 'agent'
    raw[0].name = 'password=AGENT_SENTINEL'
    raw[0].stage = 'agent:password=AGENT_SENTINEL'
    const safe = sanitizeToolEvents(raw, policy, 'fixture')
    expect(JSON.stringify(safe)).toContain('AGENT_SENTINEL')
    expect(safe[0].toolUseId).toBe('t')
    expect(JSON.stringify(aggregateTurnEvidence({ events: raw, toolContentPolicy: policy }))).toContain('AGENT_SENTINEL')
  })

  it('preserves the preferred mcpCalls array as well as scalar aliases', () => {
    const raw = events('ok')
    Object.assign(raw[0], parseMcp('mcp__server__password=MCP_SENTINEL'), { tool: 'mcp__server__password=MCP_SENTINEL' })
    expect(JSON.stringify(raw)).toContain('MCP_SENTINEL')
    const safe = sanitizeToolEvents(raw, policy, 'fixture')
    expect(JSON.stringify(safe)).toContain('MCP_SENTINEL')
    const aggregated = aggregateTurnEvidence({ events: raw, toolContentPolicy: policy })
    expect(aggregated.mcps.value).toHaveLength(1)
    expect(JSON.stringify(aggregated)).toContain('MCP_SENTINEL')
  })

  it('replaying captured JSON with a smaller field budget yields a fragment, not an exception or complete JSON', () => {
    const raw = events('ok')
    raw[0].inputContent = captureToolContent({ a: '1234567890' }, { source: 'fixture', maxBytes: 100 })
    const safe = sanitizeToolEvents(raw, { ...policy, toolContentFieldBytes: 5 }, 'fixture')
    expect(safe[0].inputContent).toMatchObject({ content: '{"a":', encoding: 'json-fragment', storage: 'truncated', reasons: ['field_budget'] })
    expect(isToolContent(safe[0].inputContent)).toBe(true)
  })

  it('does not parse or reformat JSON-like text and preserves historical redaction provenance', () => {
    const text = '  { "token": "SYNTHETIC_SECRET", "amount": 9007199254740993 }\n'
    const field = captureToolContent(text, { source: 'fixture' })
    expect(field.content).toBe(text)
    expect(field.redaction).toBe('disabled')
    const historical = { ...captureToolContent('[REDACTED]', { source: 'legacy' }), redaction: 'applied' as const }
    const source = events()
    source[1].outputContent = historical
    expect(sanitizeToolEvents(source, { toolOutput: 'full-redacted' }, 'replay')[1].outputContent).toEqual(historical)
  })

  it('cuts UTF-8 safely and labels JSON fragments', () => {
    const text = captureToolContent('中😀文', { source: 'fixture', maxBytes: 5 })
    expect(text).toMatchObject({ content: '中', savedBytes: 3, storage: 'truncated', reasons: ['field_budget'] })
    const json = captureToolContent({ text: '中😀文' }, { source: 'fixture', maxBytes: 12 })
    expect(json.encoding).toBe('json-fragment')
    expect(json.content).not.toContain('�')
    expect(isToolContent(json)).toBe(true)
  })

  it('fails closed on cycles, accessors and unsupported values without invoking them', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    let accessed = false
    const getter = Object.defineProperty({}, 'payload', { enumerable: true, get() { accessed = true; return 'secret' } })
    for (const value of [cycle, getter, 1n]) {
      expect(captureToolContent(value, { source: 'fixture' })).toMatchObject({ savedBytes: 0, storage: 'omitted', redaction: 'disabled', reasons: ['serialization_failed'] })
    }
    expect(accessed).toBe(false)
  })

  it('separates missing, upstream limitation, field and turn budgets', () => {
    const source = events('y'.repeat(500), undefined)
    delete source[0].input
    source[1].runtimeMetadata = { scryCaptureLimitations: [{ field: 'tool_response', reason: 'byte_limit', status: 'partial' }] }
    const call = aggregateTurnEvidence({ events: source, toolContentPolicy: { ...policy, toolContentFieldBytes: 100, toolContentTurnBytes: 20 } }).tools.value![0]
    expect(call.inputContent).toMatchObject({ storage: 'omitted', reasons: ['provider_missing'] })
    expect(call.outputContent).toMatchObject({ savedBytes: 20, sourceCompleteness: 'partial', reasons: ['source_truncated', 'field_budget', 'turn_budget'] })
    expect(call.outputSummary).toBe('y'.repeat(20))
  })

  it('preserves empty output as actual content and legacy modes unchanged', () => {
    expect(aggregateTurnEvidence({ events: events(''), toolContentPolicy: policy }).tools.value![0].outputContent)
      .toMatchObject({ content: '', storage: 'complete', savedBytes: 0 })
    const input = events('x'.repeat(1000))
    const legacy = aggregateTurnEvidence({ events: input })
    for (const toolOutput of ['none', 'summary'] as const) {
      expect(aggregateTurnEvidence({ events: input, toolContentPolicy: { toolOutput } })).toEqual(legacy)
    }
  })
})
