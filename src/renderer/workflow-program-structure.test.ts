import { describe, expect, it } from 'vitest'
import type { WorkflowBlock } from '@shared/workflow'
import { workflowProgramStructure } from './workflow-program-structure'

const call = (blockId: string): WorkflowBlock => ({ kind: 'call', blockId, role: 'worker', prompt: 'fixture' })
const value = { kind: 'literal' as const, value: true }

describe('frozen program structure projection', () => {
  it('retains the exact source objects and structural parents, not input-reference edges', () => {
    const branch: WorkflowBlock = { kind: 'branch', blockId: 'choice', when: value,
      then: call('yes'), else: call('no'), unknown: 'blocked' }
    const consumer: WorkflowBlock = { kind: 'call', blockId: 'consumer', role: 'worker', prompt: 'fixture', inputRefs: [{ nodeId: 'yes' }] }
    const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'parallel', blockId: 'parallel', blocks: [branch, call('sibling')] }, consumer
    ] }
    const before = JSON.stringify(body)
    const nodes = workflowProgramStructure(body)
    expect(nodes.map(node => [node.block.blockId, node.parentId, node.depth])).toEqual([
      ['root', undefined, 0], ['parallel', 'root', 1], ['choice', 'parallel', 2],
      ['yes', 'choice', 3], ['no', 'choice', 3], ['sibling', 'parallel', 2], ['consumer', 'root', 1]
    ])
    expect(nodes[2].block).toBe(branch)
    expect(nodes[6].block).toBe(consumer)
    expect(JSON.stringify(body)).toBe(before)
    expect(nodes.every(node => !Object.hasOwn(node, 'state'))).toBe(true)
  })

  it('shows a map/loop body once instead of inventing runtime instances', () => {
    const loop: WorkflowBlock = { kind: 'loop', blockId: 'loop', initial: {}, stateSchema: {}, invariants: {}, outcome: 'outcome', maxIterations: 5,
      body: call('loop_body'), until: value, carry: {}, result: value, progress: 'bounded_only',
      policy: { error: 'fail_closed', unknown: 'block', stop: 'cancel', logicalExit: 'report_partial' } }
    const body: WorkflowBlock = { kind: 'map', blockId: 'map', items: { kind: 'literal', value: [] }, item: 'item', key: ['id'], maxItems: 100, body: loop }
    expect(workflowProgramStructure(body).map(node => node.block.blockId)).toEqual(['map', 'loop', 'loop_body'])
  })
})
