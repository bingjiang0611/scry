import { describe, expect, it } from 'vitest'
import { validateWorkflowTemplate } from '../main/workflow-template-definition'
import { batchMigrationTemplateId, workflowBatchMigrationTemplate } from './workflow-batch-migration'

const input = {
  items: [{ key: 'one', value: { key: 'one', file: 'a.ts' } }, { key: 2, value: { key: 2, file: 'b.ts' } }],
  goal: 'migrate files', instruction: 'Update each item in its candidate replica',
  check: { argv: ['node', 'check.cjs'], cwd: '.', parser: 'exit_code' as const, timeoutMs: 2000 }
}

describe('batch migration template generator', () => {
  it('generates ordinary map, candidate, filter, project, collect and guarded combine blocks', () => {
    const definition = workflowBatchMigrationTemplate(input)
    expect(definition.templateId).toBe(batchMigrationTemplateId)
    expect(validateWorkflowTemplate(JSON.stringify(definition), batchMigrationTemplateId).name).toBe(definition.name)
    const blocks = definition.body.blocks
    expect(blocks.map(block => block.kind)).toEqual(['replica', 'map', 'bind', 'bind', 'collect', 'branch', 'return'])
    const map = blocks[1]
    if (map.kind !== 'map' || map.body.kind !== 'sequence') throw new Error('map fixture')
    expect(map.key).toEqual(['key'])
    expect(map.body.blocks.map(block => block.kind)).toEqual(['bind', 'replica', 'call', 'check', 'branch'])
    const call = map.body.blocks[2]
    expect(call.kind === 'call' && call.replica).toEqual({ kind: 'ref', name: 'candidate' })
    expect(call.kind === 'call' && call.inputRefs?.map(ref => ref.nodeId)).toEqual(['goal', 'instruction', 'itemInput'])
  })

  it('does not ship check authorization and rejects duplicate or unstable keys', () => {
    const definition = workflowBatchMigrationTemplate(input)
    expect(JSON.stringify(definition)).not.toContain('authorization')
    expect(() => workflowBatchMigrationTemplate({ ...input, items: [{ key: 'same', value: 1 }, { key: 'same', value: 2 }] })).toThrow()
    expect(() => workflowBatchMigrationTemplate({ ...input, items: [{ key: Number.NaN, value: 1 }] })).toThrow()
  })

  it('retains full JSON item payload in the bounded item binding', () => {
    const definition = workflowBatchMigrationTemplate(input)
    const items = definition.parameters.items.default
    expect(items).toEqual([
      { key: 'one', payload: '{"key":"one","file":"a.ts"}' },
      { key: 2, payload: '{"key":2,"file":"b.ts"}' }
    ])
  })
})
