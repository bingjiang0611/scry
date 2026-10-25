import type { WorkflowBlock } from './workflow'
import { workflowChildBlocks } from './workflow'

/** Portable syntax excludes host-resolved paths/fingerprints. Main freezes
 * these again for every instance; a template never supplies execution authority. */
export function workflowSystemSourceBody(body: WorkflowBlock): WorkflowBlock {
  const result = structuredClone(body), pending = [result]
  while (pending.length) {
    const block = pending.pop()!
    if (block.kind === 'check') delete block.authorization
    pending.push(...workflowChildBlocks(block))
  }
  return result
}
