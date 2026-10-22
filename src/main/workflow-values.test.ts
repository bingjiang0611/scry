import { describe, expect, it } from 'vitest'
import { WORKFLOW_MAX_OUTPUT_LENGTH, type WorkflowValueSchema } from '../shared/workflow'
import { decodeWorkflowOutput, validateWorkflowValueSchema, workflowStructuredOutputPrompt } from './workflow-values'

const verdict = validateWorkflowValueSchema({ type: 'object', properties: {
  status: { type: 'enum', values: ['confirmed', 'refuted', 'unknown'] },
  score: { type: 'enum', values: [0, null] },
  accepted: { type: 'boolean' }
} })

describe('Workflow finite data contracts', () => {
  it('preserves explicit unknown, null, false and zero without coercion or defaults', () => {
    const value = { status: 'unknown', score: null, accepted: false }
    expect(decodeWorkflowOutput(JSON.stringify(value), verdict)).toEqual(value)
    expect(decodeWorkflowOutput('{"status":"refuted","score":0,"accepted":false}', verdict)).toEqual({ status: 'refuted', score: 0, accepted: false })
  })

  it('requires each declared field by default and rejects an undeclared field', () => {
    expect(() => decodeWorkflowOutput('{"status":"unknown","accepted":false}', verdict)).toThrow('score')
    expect(() => decodeWorkflowOutput('{"status":"unknown","score":null,"accepted":false,"passed":true}', verdict)).toThrow('passed')
  })

  it('keeps an optional missing field absent rather than manufacturing a value', () => {
    const schema = validateWorkflowValueSchema({ type: 'object', properties: { score: { type: 'number' } }, required: [] })
    expect(decodeWorkflowOutput('{}', schema)).toEqual({})
    expect(Object.hasOwn(decodeWorkflowOutput('{}', schema) as object, 'score')).toBe(false)
  })

  it.each(['true', '0', 'null'])('does not coerce the string %s into a scalar', text => {
    expect(() => decodeWorkflowOutput(JSON.stringify(text), { type: 'boolean' })).toThrow('boolean')
  })

  it('rejects JSON fragments, Markdown fences and explanatory trailing text', () => {
    for (const text of ['```json\nfalse\n```', 'result: false', 'false, true', 'false done', '']) {
      expect(() => decodeWorkflowOutput(text, { type: 'boolean' })).toThrow('JSON')
    }
    expect(() => decodeWorkflowOutput(undefined, { type: 'boolean' })).toThrow('JSON')
  })

  it('rejects non-finite JSON numeric results and oversized complete values', () => {
    expect(() => decodeWorkflowOutput('1e400', { type: 'number' })).toThrow('number')
    expect(() => decodeWorkflowOutput(JSON.stringify('x'.repeat(WORKFLOW_MAX_OUTPUT_LENGTH)), { type: 'string' })).toThrow('上限')
  })

  it('enforces the whole array bound, including zero and the 4096 maximum', () => {
    const empty = validateWorkflowValueSchema({ type: 'array', items: { type: 'number' }, maxItems: 0 })
    expect(decodeWorkflowOutput('[]', empty)).toEqual([])
    expect(() => decodeWorkflowOutput('[0]', empty)).toThrow('array')
    const full = validateWorkflowValueSchema({ type: 'array', items: { type: 'number' } })
    expect(decodeWorkflowOutput(JSON.stringify(Array(4096).fill(0)), full)).toHaveLength(4096)
    expect(() => decodeWorkflowOutput(JSON.stringify(Array(4097).fill(0)), full)).toThrow('array')
    expect(() => validateWorkflowValueSchema({ type: 'array', items: { type: 'number' }, maxItems: 4097 })).toThrow('4096')
  })

  it('refuses executable/foreign schema extensions and inconsistent required fields', () => {
    for (const extension of ['$ref', 'eval', 'javascript', 'validator', 'additionalProperties']) {
      expect(() => validateWorkflowValueSchema({ type: 'boolean', [extension]: true })).toThrow(extension)
    }
    expect(() => validateWorkflowValueSchema({ type: 'object', properties: {}, required: ['missing'] })).toThrow('必需字段')
    expect(() => validateWorkflowValueSchema({ type: 'object', properties: { x: { type: 'number' } }, required: ['x', 'x'] })).toThrow('重复')
    expect(() => validateWorkflowValueSchema({ type: 'enum', values: [0, 0] })).toThrow('枚举')
    expect(() => validateWorkflowValueSchema({ type: 'enum', values: [Infinity] })).toThrow('枚举')
  })

  it('bounds schema recursion and node expansion before execution', () => {
    let deep: unknown = { type: 'number' }
    for (let i = 0; i < 17; i++) deep = { type: 'array', items: deep }
    expect(() => validateWorkflowValueSchema(deep)).toThrow('上限')
    expect(() => validateWorkflowValueSchema({ type: 'object', properties: Object.fromEntries(Array.from({ length: 256 }, (_, i) => ['p' + i, { type: 'number' }])) })).toThrow('上限')
  })

  it('treats own prototype-looking field names as data, never prototype operations', () => {
    const schema = validateWorkflowValueSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"boolean"}}}'))
    const value = decodeWorkflowOutput('{"__proto__":false}', schema)
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, '__proto__')).toBe(true)
  })

  it('puts the exact frozen schema into the model instruction', () => {
    const schema: WorkflowValueSchema = { type: 'boolean' }
    expect(workflowStructuredOutputPrompt('review', schema)).toContain(JSON.stringify(schema))
    expect(workflowStructuredOutputPrompt('review', schema)).toMatch(/^review\n/)
  })
})
