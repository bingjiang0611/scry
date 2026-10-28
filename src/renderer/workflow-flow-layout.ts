import type { WorkflowStructureNode } from './workflow-program-structure'

export const WORKFLOW_STRUCTURE_PAGE_SIZE = 32
export const WORKFLOW_FLOW_NODE_WIDTH = 190
export const WORKFLOW_FLOW_NODE_HEIGHT = 76
const COLUMN = 234
const ROW = 104

/** Lay out one bounded page of the frozen containment tree, not a runtime DAG.
 * Off-page parents are not fabricated, and no ordering/dependency is inferred. */
export function workflowFlowLayout(nodes: readonly WorkflowStructureNode[]) {
  const ids = new Set(nodes.map(node => node.block.blockId))
  const children = new Map<string, WorkflowStructureNode[]>()
  for (const node of nodes) if (node.parentId && ids.has(node.parentId)) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const placed = new Map<string, { x: number; y: number }>()
  let row = 0
  let lastColumn = 0
  const visit = (node: WorkflowStructureNode, column: number): number => {
    lastColumn = Math.max(lastColumn, column)
    const descendants = children.get(node.block.blockId) ?? []
    const positions = descendants.map(child => visit(child, column + 1))
    const y = positions.length ? (positions[0] + positions[positions.length - 1]) / 2 : row++ * ROW
    placed.set(node.block.blockId, { x: 16 + column * COLUMN, y: 16 + y })
    return y
  }
  for (const node of nodes) if (!node.parentId || !ids.has(node.parentId)) visit(node, 0)
  const edges = nodes.flatMap(node => node.parentId && ids.has(node.parentId) ? [{ from: node.parentId, to: node.block.blockId }] : [])
  return {
    nodes: nodes.map(node => ({ ...node, ...placed.get(node.block.blockId)! })),
    edges,
    width: 32 + lastColumn * COLUMN + WORKFLOW_FLOW_NODE_WIDTH,
    height: 32 + Math.max(0, row - 1) * ROW + WORKFLOW_FLOW_NODE_HEIGHT
  }
}
