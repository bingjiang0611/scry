import { workflowChildBlocks, type WorkflowBlock, type WorkflowPlanPreview } from '../shared/workflow'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import type { WorkflowStoreRecord } from './workflow-store-contracts'

/** Resolve facts by durable array boundaries, not their self-labelled revision.
 * A legacy first entry or proven pure prefix may omit zero system boundaries;
 * later SystemStep-bearing history must retain both explicit boundaries. */
export function governingWorkflowSystemPreview(record: WorkflowStoreRecord, kind: 'intent' | 'outcome', index: number): WorkflowPlanPreview {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(copy.invalid)
  const key = kind === 'intent' ? 'systemIntentOffset' : 'systemOutcomeOffset'
  const revisions = record.revisions ?? []
  const maximum = kind === 'intent' ? record.systemIntents?.length ?? 0 : record.systemOutcomes?.length ?? 0
  if (index >= maximum) throw new Error(copy.invalid)
  let previous = 0
  const legacyPrefix = workflowLegacySystemPrefixLength(record)
  for (const [position, revision] of revisions.entries()) {
    const offset = revision[key]
    if (position === 0 && offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset !== 0)) throw new Error(copy.invalid)
    if (position > 0 && offset === undefined && position >= legacyPrefix) throw new Error(copy.invalid)
    if (position > 0 && offset !== undefined && (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < previous)) throw new Error(copy.invalid)
    if (offset !== undefined && offset > maximum) throw new Error(copy.invalid)
    if (offset !== undefined) previous = offset
  }
  const found = [...revisions].reverse().find(revision => (revision[key] ?? 0) <= index)
  if (found) return found.preview
  if (!revisions.length) return record.preview
  throw new Error(copy.invalid)
}

/** Missing later boundaries are only historical evidence before the first
 * declared SystemStep. A later mixed revision must not invalidate that prefix. */
export function workflowLegacySystemPrefixLength(record: Pick<WorkflowStoreRecord, 'revisions'>): number {
  const revisions = record.revisions ?? []
  if (!revisions.some((revision, index) => index > 0 && (revision.systemIntentOffset === undefined || revision.systemOutcomeOffset === undefined))) return 0
  const firstSystem = revisions.findIndex(revision => workflowPreviewHasSystemEffects(revision.preview))
  return firstSystem < 0 ? revisions.length : firstSystem
}

export function workflowPreviewHasSystemEffects(preview: WorkflowPlanPreview): boolean {
  const pending: WorkflowBlock[] = [preview.program.body]
  while (pending.length) {
    const block = pending.pop()!
    if (block.kind === 'replica' || block.kind === 'check' || block.kind === 'verification' || (block.kind === 'call' && block.replica)) return true
    pending.push(...workflowChildBlocks(block))
  }
  return false
}
