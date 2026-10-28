import { createHash } from 'node:crypto'
import type { WorkflowTemplateDefinition } from '../shared/workflow-template'
import { workflowTemplateCopy as templateCopy } from '../shared/constants/copy'
import { WORKFLOW_QUALITY_TEMPLATE_COPY as qualityCopy } from '../shared/constants/workflow-quality-template-copy'

export const builtinTemplateDomain = createHash('sha256').update('scry.workflow.builtin.v1').digest('hex')
export const candidateReviewTemplateId = '341c060d-180c-40ab-945f-a093dca23271'
export const adversarialReviewTemplateId = '6b0f2a54-9d63-4c8a-9f16-1f6d0a4a2c11'
export const multiAngleTemplateId = 'b0c6c9f2-6a1b-4c3e-8f4b-2b7d51a0d9e3'
export const researchTemplateId = 'c7d1d4a7-9a4c-4cc2-8c7f-1c5d5a1df4e2'

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
        outputSchema: { type: 'object', properties: { refutation: { type: 'string' }, feedback: { type: 'string' } }, required: ['refutation', 'feedback'] },
        inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] },
      { kind: 'call', blockId: 'evidence', role: 'reviewer', prompt: qualityCopy.adversarial.auditor,
        outputSchema: { type: 'object', properties: { refutation: { type: 'string' }, feedback: { type: 'string' } }, required: ['refutation', 'feedback'] },
        inputRefs: [{ nodeId: 'goal' }, { nodeId: 'material' }, { nodeId: 'candidate' }] }
    ] },
    { kind: 'call', blockId: 'adjudicate', role: 'summarizer', prompt: qualityCopy.adversarial.adjudicator,
      outputSchema: { type: 'object', properties: { refutation: { type: 'string' }, feedback: { type: 'string' } }, required: ['refutation', 'feedback'] },
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
      outputSchema: { type: 'object', properties: { acceptable: { type: 'boolean' }, plan: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' }, maxItems: 32 } }, required: ['acceptable', 'plan', 'constraints'] },
      inputRefs: [{ nodeId: 'goal' }, { nodeId: 'minimalDraft' }, { nodeId: 'resilienceDraft' }, { nodeId: 'behaviourDraft' }, { nodeId: 'crossReview' }] },
    { kind: 'branch', blockId: 'constraintGate', when: { kind: 'field', source: { kind: 'ref', name: 'arbitrate' }, path: ['acceptable'] },
      then: { kind: 'sequence', blockId: 'acceptablePlan', blocks: [
        { kind: 'call', blockId: 'improve', role: 'orchestrator', prompt: qualityCopy.multiAngle.improve,
          inputRefs: [{ nodeId: 'goal' }, { nodeId: 'arbitrate' }, { nodeId: 'crossReview' }] },
        { kind: 'call', blockId: 'revalidate', role: 'reviewer', prompt: qualityCopy.multiAngle.revalidate,
          inputRefs: [{ nodeId: 'goal' }, { nodeId: 'arbitrate' }, { nodeId: 'improve' }] }
      ] },
      else: { kind: 'call', blockId: 'noAcceptablePlan', role: 'orchestrator', prompt: qualityCopy.multiAngle.noPlan,
        inputRefs: [{ nodeId: 'goal' }, { nodeId: 'arbitrate' }] },
      unknown: 'blocked' },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'constraintGate' } }
  ] }
}

const research: WorkflowTemplateDefinition = {
  schemaVersion: 1, templateId: researchTemplateId, name: qualityCopy.research.name, description: qualityCopy.research.description,
  parameters: { question: { schema: { type: 'string' } }, material: { schema: { type: 'string' } } },
  roles: [{ role: 'worker' }, { role: 'reviewer' }, { role: 'summarizer' }],
  body: { kind: 'sequence', blockId: 'root', blocks: [
    { kind: 'parallel', blockId: 'sources', blocks: [
      { kind: 'call', blockId: 'sourceA', role: 'worker', prompt: qualityCopy.research.sourceA, inputRefs: [{ nodeId: 'question' }, { nodeId: 'material' }] },
      { kind: 'call', blockId: 'sourceB', role: 'worker', prompt: qualityCopy.research.sourceB, inputRefs: [{ nodeId: 'question' }, { nodeId: 'material' }] }
    ] },
    { kind: 'call', blockId: 'review', role: 'reviewer', prompt: qualityCopy.research.review, inputRefs: [{ nodeId: 'question' }, { nodeId: 'sourceA' }, { nodeId: 'sourceB' }] },
    { kind: 'call', blockId: 'brief', role: 'summarizer', prompt: qualityCopy.research.brief, inputRefs: [{ nodeId: 'question' }, { nodeId: 'sourceA' }, { nodeId: 'sourceB' }, { nodeId: 'review' }] },
    { kind: 'return', blockId: 'finish', ref: { nodeId: 'brief' } }
  ] }
}

const sources: ReadonlyMap<string, string> = new Map([candidateReview, adversarialReview, multiAngle, research]
  .map(template => [template.templateId, JSON.stringify(template, null, 2) + '\n']))
export const builtinTemplateIds = Object.freeze([...sources.keys()].sort())
export type BuiltinTemplateFamily = 'code_audit' | 'change_review' | 'research' | 'multi_option_tradeoff'
export const builtinTemplateFamilies: ReadonlyMap<BuiltinTemplateFamily, string> = new Map([
  ['change_review', candidateReviewTemplateId], ['code_audit', adversarialReviewTemplateId], ['multi_option_tradeoff', multiAngleTemplateId], ['research', researchTemplateId]
])
export function builtinTemplateSource(templateId: string): string | undefined { return sources.get(templateId) }
