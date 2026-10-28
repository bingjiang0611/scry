import type { WorkflowTemplateDefinition } from '../shared/workflow-template'
import type { WorkflowCheckRequest } from '../shared/workflow-check'
import { workflowBatchMigrationTemplate, type WorkflowBatchMigrationInput } from '../shared/workflow-batch-migration'
import { workflowCheckFixTemplate } from '../shared/workflow-check-fix'
import { builtinTemplateFamilies, builtinTemplateIds, builtinTemplateSource } from './workflow-template-builtins'

export type WorkflowTemplateFamily = 'code_audit' | 'change_review' | 'research' | 'multi_option_tradeoff' | 'check_fix' | 'batch_migration'
export type WorkflowTemplateRegistryEntry = Readonly<{
  family: WorkflowTemplateFamily
  kind: 'builtin' | 'project'
  templateId?: string
  source?: string
  create?: (input: WorkflowTemplateFactoryInput) => WorkflowTemplateDefinition
}>
export type WorkflowTemplateFactoryInput = WorkflowCheckRequest | WorkflowBatchMigrationInput

const entries: Readonly<Record<WorkflowTemplateFamily, WorkflowTemplateRegistryEntry>> = {
  code_audit: { family: 'code_audit', kind: 'builtin', templateId: builtinTemplateFamilies.get('code_audit') },
  change_review: { family: 'change_review', kind: 'builtin', templateId: builtinTemplateFamilies.get('change_review') },
  research: { family: 'research', kind: 'builtin', templateId: builtinTemplateFamilies.get('research') },
  multi_option_tradeoff: { family: 'multi_option_tradeoff', kind: 'builtin', templateId: builtinTemplateFamilies.get('multi_option_tradeoff') },
  check_fix: { family: 'check_fix', kind: 'project', create: input => workflowCheckFixTemplate(input as WorkflowCheckRequest) as WorkflowTemplateDefinition },
  batch_migration: { family: 'batch_migration', kind: 'project', create: input => workflowBatchMigrationTemplate(input as WorkflowBatchMigrationInput) }
}

export function workflowTemplateRegistry(): readonly WorkflowTemplateRegistryEntry[] {
  return Object.values(entries).map(entry => Object.freeze({ ...entry }))
}
export function workflowTemplateEntry(family: WorkflowTemplateFamily): WorkflowTemplateRegistryEntry { return entries[family] }
export function portableBuiltinTemplate(family: Exclude<WorkflowTemplateFamily, 'check_fix' | 'batch_migration'>): WorkflowTemplateDefinition {
  const entry = entries[family], source = entry.templateId ? builtinTemplateSource(entry.templateId) : undefined
  if (!source) throw new Error('builtin template unavailable')
  const parsed: unknown = JSON.parse(source)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('builtin template unavailable')
  return structuredClone(parsed) as WorkflowTemplateDefinition
}
export function projectTemplate(family: 'check_fix', check: WorkflowCheckRequest): WorkflowTemplateDefinition
export function projectTemplate(family: 'batch_migration', input: WorkflowBatchMigrationInput): WorkflowTemplateDefinition
export function projectTemplate(family: 'check_fix' | 'batch_migration', input: WorkflowTemplateFactoryInput): WorkflowTemplateDefinition {
  const entry = entries[family]
  if (!entry.create) throw new Error('project template factory unavailable')
  return structuredClone(entry.create(input))
}
export function registryTemplateIds(): readonly string[] { return [...builtinTemplateIds] }
