import { createHash } from 'node:crypto'
import type { WorkflowTemplateDefinition } from '../shared/workflow-template'
import { workflowTemplateCopy as templateCopy } from '../shared/constants/copy'
import { WORKFLOW_QUALITY_TEMPLATE_COPY as qualityCopy } from '../shared/constants/workflow-quality-template-copy'

export const builtinTemplateDomain = createHash('sha256').update('scry.workflow.builtin.v1').digest('hex')
export const candidateReviewTemplateId = '341c060d-180c-40ab-945f-a093dca23271'
export const adversarialReviewTemplateId = '6b0f2a54-9d63-4c8a-9f16-1f6d0a4a2c11'
export const multiAngleTemplateId = 'b0c6c9f2-6a1b-4c3e-8f4b-2b7d51a0d9e3'

const candidateCopy = templateCopy.candidateReview

// Distributed data, not another executable representation. Main runs these bytes
// through the same template validator and freezes them before any execution.
const candidateReview: WorkflowTemplateDefinition = {
  schemaVersion: 1, templateId: candidateReviewTemplateId,
  name: candidateCopy.name, description: candidateCopy.description,
  parameters: { goal: { schema: { type: 'string' } }, material: { schema: { type: 'string' } } },
  roles: [{ role: 'worker' }, { role: 'reviewer' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'candidate', role: 'worker', prompt: candidateCopy.author, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] },
    { kind: 'call', blockId: 'review', role: 'reviewer', prompt: candidateCopy.reviewer, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'review' } }
  ] }
}

// Two reviewers with different mandates plus an adjudicator: a single opinion can
// never be presented as a passing check, and disagreement survives to the output.
const adversarialReview: WorkflowTemplateDefinition = {
  schemaVersion: 1, templateId: adversarialReviewTemplateId,
  name: qualityCopy.adversarial.name, description: qualityCopy.adversarial.description,
  parameters: { goal: { schema: { type: 'string' } }, material: { schema: { type: 'string' } } },
  roles: [{ role: 'worker' }, { role: 'reviewer' }, { role: 'summarizer' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'call', blockId: 'candidate', role: 'worker', prompt: candidateCopy.author, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] },
    { kind: 'parallel', blockId: 'reviews', blocks: [
      { kind: 'call', blockId: 'counterexamples', role: 'reviewer', prompt: qualityCopy.adversarial.hunter,
        inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] },
      { kind: 'call', blockId: 'evidence', role: 'reviewer', prompt: qualityCopy.adversarial.auditor,
        inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] }
    ] },
    { kind: 'call', blockId: 'adjudicate', role: 'summarizer', prompt: qualityCopy.adversarial.adjudicator,
      inputRefs: [{ nodeId: 'goal' }, { nodeId: 'candidate' }, { nodeId: 'counterexamples' }, { nodeId: 'evidence' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'adjudicate' } }
  ] }
}

// Three independent angles stay private to the program; only the arbitrated and
// improved single plan leaves the program.
const multiAngle: WorkflowTemplateDefinition = {
  schemaVersion: 1, templateId: multiAngleTemplateId,
  name: qualityCopy.multiAngle.name, description: qualityCopy.multiAngle.description,
  parameters: { goal: { schema: { type: 'string' } }, material: { schema: { type: 'string' } } },
  roles: [{ role: 'worker' }, { role: 'reviewer' }, { role: 'summarizer' }, { role: 'orchestrator' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'parallel', blockId: 'drafts', blocks: [
      { kind: 'call', blockId: 'minimalDraft', role: 'worker', prompt: qualityCopy.multiAngle.angleA, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] },
      { kind: 'call', blockId: 'resilienceDraft', role: 'worker', prompt: qualityCopy.multiAngle.angleB, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] },
      { kind: 'call', blockId: 'behaviourDraft', role: 'worker', prompt: qualityCopy.multiAngle.angleC, inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }] }
    ] },
    { kind: 'call', blockId: 'crossReview', role: 'reviewer', prompt: qualityCopy.multiAngle.crossReview,
      inputRefs: [{ nodeId: 'goal' }, { nodeId: 'minimalDraft' }, { nodeId: 'resilienceDraft' }, { nodeId: 'behaviourDraft' }] },
    { kind: 'call', blockId: 'arbitrate', role: 'summarizer', prompt: qualityCopy.multiAngle.arbitrate,
      inputRefs: [{ nodeId: 'goal' }, { nodeId: 'minimalDraft' }, { nodeId: 'resilienceDraft' }, { nodeId: 'behaviourDraft' }, { nodeId: 'crossReview' }] },
    { kind: 'call', blockId: 'improve', role: 'orchestrator', prompt: qualityCopy.multiAngle.improve,
      inputRefs: [{ nodeId: 'goal' }, { nodeId: 'arbitrate' }, { nodeId: 'crossReview' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'improve' } }
  ] }
}

const sources: ReadonlyMap<string, string> = new Map([candidateReview, adversarialReview, multiAngle]
  .map(template => [template.templateId, JSON.stringify(template, null, 2) + '\n']))
export const builtinTemplateIds = Object.freeze([...sources.keys()].sort())
export function builtinTemplateSource(templateId: string): string | undefined { return sources.get(templateId) }
