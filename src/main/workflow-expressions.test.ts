import { describe, expect, it } from 'vitest'
import { WORKFLOW_MAX_VALUE_BYTES, type WorkflowEvaluation, type WorkflowExpression, type WorkflowValue, type WorkflowValueSchema } from '../shared/workflow'
import { assertWorkflowValue, evaluateWorkflowExpression, inferWorkflowExpression, validateWorkflowExpression, workflowExpressionReferences, workflowValueKey } from './workflow-expressions'

const known = (value: WorkflowValue, derivedFrom: string[] = []): WorkflowEvaluation => ({ state: 'known', value, derivedFrom })
const field = (name: string, key: string): WorkflowExpression => ({ kind: 'field', source: { kind: 'ref', name }, path: [key] })
const run = (expression: WorkflowExpression, values: Array<[string, WorkflowEvaluation]> = []) => evaluateWorkflowExpression(validateWorkflowExpression(expression), new Map(values))

describe('finite Workflow expressions', () => {
  it('normalizes homogeneous collection alternatives without admitting descriptor literals', () => {
    const variants: WorkflowValueSchema[] = [0, false].map(key => ({ type: 'collection', items: { type: 'object', properties: { key: { type: 'enum', values: [key] } }, required: ['key'] } }))
    const scope = new Map<string, WorkflowValueSchema>([['source', { type: 'union', variants }]])
    expect(inferWorkflowExpression({ kind: 'count', value: { kind: 'ref', name: 'source' } }, scope)).toEqual({ type: 'number' })
    expect(inferWorkflowExpression({ kind: 'group', items: { kind: 'ref', name: 'source' }, key: ['key'] }, scope)).toMatchObject({ type: 'array', items: { properties: { members: { type: 'collection' } } } })
    expect(() => inferWorkflowExpression({ kind: 'group', items: { kind: 'literal', value: { kind: 'workflow_collection' } }, key: ['key'] }, scope)).toThrow()
  })
  it('keeps false/zero/null values distinct from missing bindings', () => {
    expect(run({ kind: 'ref', name: 'flag' }, [['flag', known(false)]])).toMatchObject({ state: 'known', value: false })
    expect(run({ kind: 'ref', name: 'zero' }, [['zero', known(0)]])).toMatchObject({ state: 'known', value: 0 })
    expect(run({ kind: 'ref', name: 'nil' }, [['nil', known(null)]])).toMatchObject({ state: 'known', value: null })
    expect(run({ kind: 'ref', name: 'missing' })).toMatchObject({ state: 'unknown' })
  })
  it('does not coerce missing fields or failed outcomes into false', () => {
    expect(run(field('data', 'flag'), [['data', known({})]])).toMatchObject({ state: 'unknown' })
    expect(run({ kind: 'not', value: { kind: 'ref', name: 'missing' } })).toMatchObject({ state: 'unknown' })
    expect(run({ kind: 'and', values: [{ kind: 'literal', value: false }, { kind: 'ref', name: 'failed' }] }, [['failed', { state: 'unknown', reason: 'failed outcome', derivedFrom: ['attempt-1'] }]])).toMatchObject({ state: 'unknown', derivedFrom: ['attempt-1', 'failed'] })
  })
  it('only reads own JSON fields, never array/prototype methods', () => {
    expect(run(field('data', 'constructor'), [['data', known({})]])).toMatchObject({ state: 'unknown' })
    expect(run(field('data', 'constructor'), [['data', known({ constructor: 'own data' })]])).toMatchObject({ state: 'known', value: 'own data' })
    expect(run(field('data', 'length'), [['data', known([1, 2])]])).toMatchObject({ state: 'unknown' })
    expect(run(field('data', '0'), [['data', known([false])]])).toMatchObject({ state: 'known', value: false })
  })
  it('uses persistence-stable JSON equality and fingerprints', () => {
    expect(workflowValueKey({ a: 1, b: 0 })).toBe(workflowValueKey({ b: -0, a: 1 }))
    expect(run({ kind: 'compare', operator: 'eq', left: { kind: 'literal', value: { a: 0, b: 1 } }, right: { kind: 'literal', value: { b: 1, a: -0 } } })).toMatchObject({ state: 'known', value: true })
    expect(run({ kind: 'compare', operator: 'lt', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: '2' } })).toMatchObject({ state: 'unknown' })
  })
  it('counts sealed input and concatenates without discarding falsy members', () => {
    expect(run({ kind: 'count', value: { kind: 'literal', value: [] } })).toMatchObject({ state: 'known', value: 0 })
    expect(run({ kind: 'concat', values: [{ kind: 'literal', value: [false, 0] }, { kind: 'literal', value: [null, ''] }] })).toMatchObject({ state: 'known', value: [false, 0, null, ''] })
    expect(run({ kind: 'concat', values: [{ kind: 'literal', value: 'a' }, { kind: 'literal', value: 'b' }] })).toMatchObject({ state: 'known', value: 'ab' })
  })
  it.each(['filter', 'partition'] as const)('%s retains all partitions, unknown reasons and external predicate lineage', kind => {
    const items: WorkflowValue[] = [{ id: 'a', score: 2 }, { id: 'b', score: 0 }, { id: 'c' }]
    const result = run({ kind, items: { kind: 'ref', name: 'rows' }, item: 'candidate', when: {
      kind: 'compare', operator: 'gt', left: field('candidate', 'score'), right: { kind: 'ref', name: 'threshold' }
    } }, [['rows', known(items, ['scan'])], ['threshold', known(1, ['rubric'])]])
    expect(result.state).toBe('known')
    if (result.state !== 'known') throw new Error('expected partition evidence')
    expect(result.value).toMatchObject({ matched: [{ index: 0, value: items[0], reason: 'condition_true' }], rejected: [{ index: 1, value: items[1], reason: 'condition_false' }], unknown: [{ index: 2, value: items[2] }] })
    expect((result.value as { unknown: Array<{ reason: string }> }).unknown[0].reason).toContain('score')
    expect(result.derivedFrom).toEqual(expect.arrayContaining(['scan', 'rows', 'rubric', 'threshold']))
    expect(result.derivedFrom).not.toContain('candidate')
  })
  it.each(['group', 'unique'] as const)('%s preserves contradictory members with derivedFrom indexes', kind => {
    const members = [{ id: 'x', supported: true }, { id: 'y', supported: false }, { id: 'x', supported: false }]
    const result = run({ kind, items: { kind: 'literal', value: members }, key: ['id'] })
    expect(result).toMatchObject({ state: 'known', value: [
      { key: 'x', members: [members[0], members[2]], derivedFrom: [0, 2] },
      { key: 'y', members: [members[1]], derivedFrom: [1] }
    ] })
  })
  it('rejects callbacks, executable kinds, non-JSON and expanded batches before interpretation', () => {
    expect(() => validateWorkflowExpression({ kind: 'eval', code: 'process.exit(0)' })).toThrow()
    expect(() => validateWorkflowExpression({ kind: 'literal', value: () => true })).toThrow()
    expect(() => validateWorkflowExpression({ kind: 'literal', value: Infinity })).toThrow()
    expect(() => validateWorkflowExpression({ kind: 'literal', value: Array(4097).fill(0) })).toThrow('上限')
    expect(() => assertWorkflowValue({ a: undefined })).toThrow()
    expect(() => assertWorkflowValue([NaN])).toThrow()
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    expect(() => assertWorkflowValue(cycle)).toThrow('上限')
  })
  it('applies the actual UTF-8 JSON byte bound, including multibyte text', () => {
    expect(() => assertWorkflowValue('x'.repeat(WORKFLOW_MAX_VALUE_BYTES - 2))).not.toThrow()
    expect(() => assertWorkflowValue('x'.repeat(WORKFLOW_MAX_VALUE_BYTES - 1))).toThrow('上限')
    expect(() => assertWorkflowValue('界'.repeat(2 * 1024 * 1024))).toThrow('上限')
  })

  it('infers common scalar/collection types across different frozen literal values', () => {
    const rows: WorkflowExpression = { kind: 'literal', value: [{ id: 'x', score: 2 }, { id: 'y', score: 0 }] }
    expect(() => inferWorkflowExpression({ kind: 'group', items: rows, key: ['id'] }, new Map())).not.toThrow()
    expect(() => inferWorkflowExpression({ kind: 'filter', items: rows, item: 'row', when: { kind: 'compare', operator: 'gt', left: field('row', 'score'), right: { kind: 'literal', value: 1 } } }, new Map())).not.toThrow()
    const variants: WorkflowValueSchema = { type: 'union', variants: [
      { type: 'array', items: { type: 'number' }, maxItems: 2 },
      { type: 'array', items: { type: 'number' }, maxItems: 4 }
    ] }
    const source: WorkflowExpression = { kind: 'field', source: { kind: 'ref', name: 'value' }, path: [] }
    expect(inferWorkflowExpression({ kind: 'count', value: source }, new Map([['value', variants]]))).toEqual({ type: 'number' })
  })

  it('projects ordinary arrays in order, preserves nested authority and retains unknown results', () => {
    const nested: WorkflowEvaluation = { state: 'known', value: [{ id: 'a' }], derivedFrom: ['nested'], collectionFields: [{ path: ['nested'], collection: { reference: { workflowId: 'w', key: 'nested', hash: 'h' }, count: 1, sealed: true } }] }
    const expression: WorkflowExpression = { kind: 'project', items: { kind: 'literal', value: [{ value: 2 }, { value: 0 }, { value: false }] }, item: 'row', value: field('row', 'value') }
    expect(run(expression)).toMatchObject({ state: 'known', value: [2, 0, false] })
    const nestedResult = run({ kind: 'project', items: { kind: 'literal', value: [{ nested: [] }] }, item: 'row', value: { kind: 'ref', name: 'nested' } }, [['nested', nested]])
    expect(nestedResult).toMatchObject({ state: 'known', collectionFields: [{ path: ['0', 'nested'], collection: { count: 1 } }] })
    expect(run({ kind: 'project', items: { kind: 'literal', value: [{ missing: true }] }, item: 'row', value: field('row', 'absent') })).toMatchObject({ state: 'unknown' })
  })

  it('rejects project binding collisions and expanded batches before evaluation', () => {
    expect(() => run({ kind: 'project', items: { kind: 'literal', value: [1] }, item: 'row', value: { kind: 'ref', name: 'row' } }, [['row', known(1)]])).toThrow('已存在')
    expect(() => validateWorkflowExpression({ kind: 'project', items: { kind: 'literal', value: Array(4097).fill(0) }, item: 'row', value: { kind: 'ref', name: 'row' } })).toThrow('上限')
    expect(() => run({ kind: 'project', items: { kind: 'literal', value: ['x'.repeat(WORKFLOW_MAX_VALUE_BYTES - 2)] }, item: 'row', value: { kind: 'ref', name: 'row' } })).toThrow('上限')
  })

  it('checks reference dominance, operand types and local binding shadowing', () => {
    const boolean: WorkflowValueSchema = { type: 'boolean' }
    expect(() => inferWorkflowExpression({ kind: 'ref', name: 'future' }, new Map())).toThrow('future')
    expect(() => inferWorkflowExpression({ kind: 'not', value: { kind: 'literal', value: 0 } }, new Map())).toThrow('类型')
    expect(inferWorkflowExpression({ kind: 'not', value: { kind: 'ref', name: 'flag' } }, new Map([['flag', boolean]]))).toEqual(boolean)
    const expression: WorkflowExpression = { kind: 'filter', items: { kind: 'literal', value: [true] }, item: 'flag', when: { kind: 'ref', name: 'flag' } }
    expect(() => inferWorkflowExpression(expression, new Map([['flag', boolean]]))).toThrow('已存在')
    expect(() => run(expression, [['flag', known(false)]])).toThrow('已存在')
    expect(workflowExpressionReferences({ kind: 'filter', items: { kind: 'ref', name: 'rows' }, item: 'row', when: { kind: 'compare', operator: 'eq', left: { kind: 'ref', name: 'row' }, right: { kind: 'ref', name: 'threshold' } } })).toEqual(['rows', 'threshold'])
  })
})
