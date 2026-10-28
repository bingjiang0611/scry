import { describe, expect, it } from 'vitest'
import type { WorkflowBlock } from '@shared/workflow'
import { workflowProgramStructure, workflowInspectionKind } from './workflow-program-structure'
import { workflowFlowLayout, WORKFLOW_FLOW_NODE_HEIGHT, WORKFLOW_FLOW_NODE_WIDTH, WORKFLOW_STRUCTURE_PAGE_SIZE } from './workflow-flow-layout'

const call = (blockId: string): WorkflowBlock => ({ kind: 'call', blockId, role: 'worker', prompt: 'fixture' })

describe('bounded frozen-program canvas', () => {
  it('draws canonical containment, never inventing call ordering or runtime branches', () => {
    const body: WorkflowBlock = { kind: 'sequence', blockId: 'root', blocks: [
      { kind: 'parallel', blockId: 'group', blocks: [call('one'), call('two')] }, call('after')
    ] }
    const input = workflowProgramStructure(body)
    const before = JSON.stringify(input)
    const graph = workflowFlowLayout(input)
    expect(graph.edges).toEqual([{ from: 'root', to: 'group' }, { from: 'group', to: 'one' }, { from: 'group', to: 'two' }, { from: 'root', to: 'after' }])
    expect(graph.edges).not.toContainEqual({ from: 'two', to: 'after' })
    expect(graph.nodes.every(node => !Object.hasOwn(node, 'state'))).toBe(true)
    expect(JSON.stringify(input)).toBe(before)
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true)
      expect(node.x + WORKFLOW_FLOW_NODE_WIDTH).toBeLessThanOrEqual(graph.width)
      expect(node.y + WORKFLOW_FLOW_NODE_HEIGHT).toBeLessThanOrEqual(graph.height)
    }
    for (let a = 0; a < graph.nodes.length; a++) for (let b = a + 1; b < graph.nodes.length; b++) {
      const first = graph.nodes[a], second = graph.nodes[b]
      expect(Math.abs(first.x - second.x) >= WORKFLOW_FLOW_NODE_WIDTH || Math.abs(first.y - second.y) >= WORKFLOW_FLOW_NODE_HEIGHT).toBe(true)
    }
  })

  it('keeps an off-page parent as provenance, not a fabricated visible node or edge', () => {
    const input = workflowProgramStructure({ kind: 'sequence', blockId: 'root', blocks: Array.from({ length: 40 }, (_, index) => call(`call_${index}`)) })
    const page = input.slice(WORKFLOW_STRUCTURE_PAGE_SIZE, WORKFLOW_STRUCTURE_PAGE_SIZE * 2)
    const graph = workflowFlowLayout(page)
    expect(graph.nodes).toHaveLength(9)
    expect(graph.nodes.every(node => node.parentId === 'root')).toBe(true)
    expect(graph.nodes.some(node => node.block.blockId === 'root')).toBe(false)
    expect(graph.edges).toEqual([])
  })

  it('bounds every page of the largest collection rather than mounting thousands of nodes', () => {
    const nodes = workflowProgramStructure({ kind: 'sequence', blockId: 'root', blocks: Array.from({ length: 4096 }, (_, index) => call(`call_${index}`)) })
    const ids: string[] = []
    for (let offset = 0; offset < nodes.length; offset += WORKFLOW_STRUCTURE_PAGE_SIZE) {
      const graph = workflowFlowLayout(nodes.slice(offset, offset + WORKFLOW_STRUCTURE_PAGE_SIZE))
      expect(graph.nodes.length).toBeLessThanOrEqual(32)
      ids.push(...graph.nodes.map(node => node.block.blockId))
    }
    expect(ids).toEqual(nodes.map(node => node.block.blockId))
  })

  it('routes classifier and platform blocks to their real ledger kind', () => {
    expect(workflowInspectionKind(call('worker'))).toBe('attempts')
    expect(workflowInspectionKind({ kind: 'classifier', blockId: 'judge', classifierId: 'judge', classifier: 'bool', prompt: 'fixture', criteria: 'fixture' })).toBe('classifiers')
    expect(workflowInspectionKind({ kind: 'check', blockId: 'check', replica: { kind: 'ref', name: 'copy' }, check: { argv: ['node', '--version'], cwd: '.', timeoutMs: 1000, parser: 'exit_code' } })).toBe('systems')
  })
})
