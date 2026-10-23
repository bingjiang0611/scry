import { WORKFLOW_MAX_BATCH } from '../shared/workflow'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import type { WorkflowTemplateInstance, WorkflowTemplateRef, WorkflowTemplateScope, WorkflowTemplateSource } from '../shared/workflow-template'

export const templateHashPattern = /^[a-f0-9]{64}$/
export const templateIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
export function templateObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error(copy.invalid)
  return value as Record<string, unknown>
}
export function templateScope(value: unknown): WorkflowTemplateScope {
  const scope = templateObject(value, ['kind', 'workspace'])
  if (scope.kind === 'personal' && scope.workspace === undefined) return { kind: 'personal' }
  if (scope.kind === 'project' && typeof scope.workspace === 'string' && scope.workspace.length > 0 && scope.workspace.length <= 4096) return { kind: 'project', workspace: scope.workspace }
  throw new Error(copy.invalid)
}
export function templateReference(value: unknown): WorkflowTemplateRef {
  const ref = templateObject(value, ['scope', 'domainId', 'templateId', 'revisionHash'])
  if (typeof ref.templateId !== 'string' || !templateIdPattern.test(ref.templateId) || typeof ref.domainId !== 'string' || !templateHashPattern.test(ref.domainId) || typeof ref.revisionHash !== 'string' || !templateHashPattern.test(ref.revisionHash)) throw new Error(copy.ledger)
  return { scope: templateScope(ref.scope), domainId: ref.domainId, templateId: ref.templateId, revisionHash: ref.revisionHash }
}
export function templateSource(value: unknown): WorkflowTemplateSource {
  const source = templateObject(value, ['kind', 'ref', 'draftId', 'draftRevision', 'candidateHash'])
  if (source.kind === 'saved' && Object.keys(source).length === 2) return { kind: 'saved', ref: templateReference(source.ref) }
  if (source.kind === 'draft' && Object.keys(source).length === 4 && typeof source.draftId === 'string' && templateIdPattern.test(source.draftId) && Number.isSafeInteger(source.draftRevision) && (source.draftRevision as number) >= 1 && typeof source.candidateHash === 'string' && templateHashPattern.test(source.candidateHash)) return { kind: 'draft', draftId: source.draftId, draftRevision: source.draftRevision as number, candidateHash: source.candidateHash }
  throw new Error(copy.invalid)
}
export function templateInstance(value: unknown): WorkflowTemplateInstance {
  const instance = templateObject(value, ['ref', 'origin', 'parameterNames', 'commandId', 'requestHash'])
  const ref = templateReference(instance.ref), origin = templateSource(instance.origin)
  if (origin.kind === 'saved' && JSON.stringify(origin.ref) !== JSON.stringify(ref)) throw new Error(copy.ledger)
  if (typeof instance.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(instance.commandId) || typeof instance.requestHash !== 'string' || !templateHashPattern.test(instance.requestHash) || !Array.isArray(instance.parameterNames) || instance.parameterNames.length > WORKFLOW_MAX_BATCH || !instance.parameterNames.every(name => typeof name === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(name)) || new Set(instance.parameterNames).size !== instance.parameterNames.length) throw new Error(copy.invalid)
  return { ref, origin, parameterNames: [...instance.parameterNames] as string[], commandId: instance.commandId, requestHash: instance.requestHash }
}
