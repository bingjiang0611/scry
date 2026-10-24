import type { WorkflowBlock, WorkflowExpression } from '@shared/workflow'
import { workflowChildBlocks, workflowExpressionReferences } from '@shared/workflow'

/** Exact contiguous changed span, not a minimum-edit/LCS claim. Both complete
 * sources remain available to review. Work is linear in the bounded source. */
export function templateSourceDifference(before: string, after: string) {
  const left = before.split('\n'), right = after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++
  return { prefix, suffix, removed: left.slice(prefix, left.length - suffix).join('\n'), added: right.slice(prefix, right.length - suffix).join('\n'),
    removedLines: left.length - prefix - suffix, addedLines: right.length - prefix - suffix }
}
export function templateStructure(root: WorkflowBlock) {
  const rows: Array<{ id: string; kind: string; depth: number; inputs: string[] }> = []
  const stack = [{ block: root, depth: 0 }]
  while (stack.length) {
    const { block, depth } = stack.pop()!
    const expressions: WorkflowExpression[] = block.kind === 'call' ? block.replica ? [block.replica] : [] : block.kind === 'bind' ? [block.value] : block.kind === 'branch' ? [block.when]
      : block.kind === 'verification' ? [...Object.values(block.required).map(entry => entry.result), ...(block.baseline ? [block.baseline] : [])]
      : block.kind === 'check' ? [block.replica] : block.kind === 'replica' ? block.source ? [block.source] : []
      : block.kind === 'map' || block.kind === 'collect' ? [block.items]
      : block.kind === 'loop' ? [...Object.values(block.initial), ...Object.values(block.invariants), block.until, ...Object.values(block.carry), block.result,
        ...(block.progress === 'bounded_only' ? [] : [block.progress.baseline, block.progress.key, block.progress.improved])] : []
    const inputs = block.kind === 'call' ? [...new Set([...(block.inputRefs ?? []).map(ref => [ref.nodeId, ...(ref.path ?? [])].join('.')), ...expressions.flatMap(workflowExpressionReferences)])]
      : block.kind === 'return' ? [[block.ref.nodeId, ...(block.ref.path ?? [])].join('.')] : [...new Set(expressions.flatMap(workflowExpressionReferences))]
    rows.push({ id: block.blockId, kind: block.kind, depth, inputs })
    stack.push(...workflowChildBlocks(block).map(child => ({ block: child, depth: depth + 1 })).reverse())
  }
  return rows
}
