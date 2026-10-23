import type { WorkflowSequenceBlock, WorkflowRoleBinding, WorkflowValue, WorkflowValueSchema } from './workflow'

export const WORKFLOW_TEMPLATE_MAX_BYTES = 4 * 1024 * 1024

export type WorkflowTemplateScope = { kind: 'personal' } | { kind: 'project'; workspace: string }
export type WorkflowTemplateRef = {
  scope: WorkflowTemplateScope
  domainId: string
  templateId: string
  revisionHash: string
}
export interface WorkflowTemplateDefinition {
  schemaVersion: 1
  templateId: string
  name: string
  description: string
  parameters: Record<string, { schema: WorkflowValueSchema; default?: WorkflowValue }>
  /** Suggestions only. No profile, runtime identity, permission or execution grant. */
  roles: Array<Pick<WorkflowRoleBinding, 'role'> & Partial<Pick<WorkflowRoleBinding, 'providerId' | 'requestedModel'>>>
  body: WorkflowSequenceBlock
}
export type WorkflowTemplateSource =
  | { kind: 'saved'; ref: WorkflowTemplateRef }
  | { kind: 'draft'; draftId: string; draftRevision: number; candidateHash: string }
/** Source bytes live in the App-owned immutable snapshot. Parameter values live
 * once, in the program's leading typed bind nodes, not in a second executable form. */
export interface WorkflowTemplateInstance {
  ref: WorkflowTemplateRef
  origin: WorkflowTemplateSource
  parameterNames: string[]
  commandId: string
  requestHash: string
}
export interface WorkflowTemplateInstantiation {
  source: WorkflowTemplateSource
  commandId: string
  cwd: string
  userGoal: string
  parameters: Record<string, WorkflowValue>
  orchestrator: WorkflowRoleBinding
  roles: WorkflowRoleBinding[]
}
export type WorkflowTemplateSnapshot = {
  ref: WorkflowTemplateRef
  source: string
} & ({ state: 'valid'; definition: WorkflowTemplateDefinition } | { state: 'invalid'; error: string })

export interface WorkflowTemplateDraft {
  draftId: string
  draftRevision: number
  candidateHash: string
  domainId: string
  templateId: string
  scope: WorkflowTemplateScope
  base: WorkflowTemplateRef | null
  source: string
  validation: { state: 'valid' } | { state: 'invalid'; error: string }
}
export type WorkflowTemplatePublication =
  | { state: 'published'; ref: WorkflowTemplateRef; verification: 'write' | 'reconciled_content' }
  | { state: 'conflict'; currentRevisionHash: string | null }
  | { state: 'unknown'; observedRevisionHash: string | null; reason: string }

export interface WorkflowTemplateApi {
  read(scope: WorkflowTemplateScope, templateId: string): Promise<WorkflowTemplateSnapshot | null>
  list(scope: WorkflowTemplateScope, cursor?: string): Promise<{ templateIds: string[]; nextCursor?: string }>
  saveDraft(request: { source: string; scope: WorkflowTemplateScope; base?: WorkflowTemplateRef; draftId?: string; expectedDraftRevision?: number }): Promise<WorkflowTemplateDraft>
  draft(draftId: string): Promise<WorkflowTemplateDraft>
  publish(request: { draftId: string; draftRevision: number; candidateHash: string; commandId: string }): Promise<WorkflowTemplatePublication>
}
