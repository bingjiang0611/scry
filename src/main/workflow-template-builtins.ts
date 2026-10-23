import { createHash } from 'node:crypto'
import type { WorkflowTemplateDefinition } from '../shared/workflow-template'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'

export const builtinTemplateDomain = createHash('sha256').update('scry.workflow.builtin.v1').digest('hex')
export const candidateReviewTemplateId = '341c060d-180c-40ab-945f-a093dca23271'

// Distributed data, not another executable representation. Main runs these bytes
// through the same template validator and freezes them before any execution.
const candidateReview: WorkflowTemplateDefinition = {
  schemaVersion: 1, templateId: candidateReviewTemplateId,
  name: copy.candidateReview.name, description: copy.candidateReview.description,
  parameters: { goal: { schema: { type: 'string' } }, material: { schema: { type: 'string' } } },
  roles: [{ role: 'worker' }, { role: 'reviewer' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'candidate', role: 'worker', prompt: copy.candidateReview.author, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] },
    { kind: 'call', blockId: 'review', role: 'reviewer', prompt: copy.candidateReview.reviewer, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'review' } }
  ] }
}
const sources: ReadonlyMap<string, string> = new Map([[candidateReview.templateId, JSON.stringify(candidateReview, null, 2) + '\n']])
export const builtinTemplateIds = Object.freeze([...sources.keys()].sort())
export function builtinTemplateSource(templateId: string): string | undefined { return sources.get(templateId) }
