import { workflowChildBlocks, type WorkflowBlock } from '@shared/workflow'
import type { WorkflowExecutionInspectionKind } from '@shared/workflow-inspection'

export type WorkflowStructureNode = { block: WorkflowBlock; depth: number; parentId?: string }
export function workflowInspectionKind(block: WorkflowBlock): WorkflowExecutionInspectionKind {
  if (block.kind === 'classifier') return 'classifiers'
  if (block.kind === 'replica' || block.kind === 'combine' || block.kind === 'check' || block.kind === 'verification') return 'systems'
  return 'attempts'
}

/** Structural edges only. Runtime instances come from the canonical ledger. */
export function workflowProgramStructure(body: WorkflowBlock): WorkflowStructureNode[] {
  const pending: WorkflowStructureNode[] = [{ block: body, depth: 0 }]
  const nodes: WorkflowStructureNode[] = []
  while (pending.length) {
    const node = pending.pop()!
    nodes.push(node)
    const children = workflowChildBlocks(node.block)
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ block: children[index], depth: node.depth + 1, parentId: node.block.blockId })
    }
  }
  return nodes
}
