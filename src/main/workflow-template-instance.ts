import { isAbsolute } from 'node:path'
import type { WorkflowRoleBinding, WorkflowSequenceBlock, WorkflowValue } from '../shared/workflow'
import type { WorkflowTemplateDefinition, WorkflowTemplateInstantiation } from '../shared/workflow-template'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import { templateObject, templateSource } from './workflow-template-identity'
import { assertWorkflowValue } from './workflow-expressions'
import { validateWorkflowRoleBinding, WORKFLOW_ROLES } from './workflow-program'
import { matchesWorkflowValue } from './workflow-values'

export const templateInstantiationFields = ['source', 'commandId', 'cwd', 'userGoal', 'parameters', 'orchestrator', 'roles'] as const
export function validateTemplateInstantiation(input: unknown): WorkflowTemplateInstantiation {
  const value = templateObject(input, templateInstantiationFields)
  if (typeof value.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value.commandId) || typeof value.cwd !== 'string' || value.cwd.length > 4096 || !isAbsolute(value.cwd) || typeof value.userGoal !== 'string' || !value.userGoal.trim() || value.userGoal.length > 16_000) throw new Error(copy.invalid)
  assertWorkflowValue(value.parameters)
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters) || !Array.isArray(value.roles) || value.roles.length > 3) throw new Error(copy.invalid)
  const orchestrator = validateWorkflowRoleBinding(value.orchestrator)
  const roles = value.roles.map((role, index) => validateWorkflowRoleBinding(role, index + 1))
  if (orchestrator.role !== 'orchestrator' || roles.some(role => role.role === 'orchestrator') || new Set(roles.map(role => role.role)).size !== roles.length) throw new Error(copy.roleBindings)
  roles.sort((a, b) => WORKFLOW_ROLES.indexOf(a.role) - WORKFLOW_ROLES.indexOf(b.role))
  return { source: templateSource(value.source), commandId: value.commandId, cwd: value.cwd, userGoal: value.userGoal.trim(),
    parameters: structuredClone(Object.fromEntries(Object.entries(value.parameters).sort(([a], [b]) => a.localeCompare(b)))), orchestrator, roles }
}
export function templateRoles(definition: WorkflowTemplateDefinition, actual: WorkflowRoleBinding[]): void {
  const expected = new Set(['orchestrator', ...definition.roles.map(role => role.role)])
  if (actual.length !== expected.size || actual.some(role => !expected.has(role.role)) || new Set(actual.map(role => role.role)).size !== actual.length) throw new Error(copy.roleBindings)
}
export function templateParameters(definition: WorkflowTemplateDefinition, input: Record<string, WorkflowValue>): Record<string, WorkflowValue> {
  if (Object.keys(input).some(name => !Object.hasOwn(definition.parameters, name))) throw new Error(copy.invalid)
  const values: Record<string, WorkflowValue> = Object.create(null)
  for (const name of Object.keys(definition.parameters).sort()) {
    const parameter = definition.parameters[name]
    if (!Object.hasOwn(input, name) && !Object.hasOwn(parameter, 'default')) throw new Error(copy.parameterValue(name))
    const value = Object.hasOwn(input, name) ? input[name] : parameter.default!
    if (!matchesWorkflowValue(value, parameter.schema)) throw new Error(copy.parameterValue(name))
    values[name] = structuredClone(value)
  }
  assertWorkflowValue(values)
  return values
}
/** Lower parameters to the existing typed bind instruction. Prompts are not
 * interpolated, and no executable template dialect or runtime globals exist. */
export function templateBody(definition: WorkflowTemplateDefinition, parameters: Record<string, WorkflowValue>): WorkflowSequenceBlock {
  const values = templateParameters(definition, parameters)
  return { ...definition.body, blocks: [
    ...Object.entries(values).map(([name, value]) => ({ kind: 'bind' as const, blockId: name, value: { kind: 'literal' as const, value }, schema: definition.parameters[name].schema })),
    ...definition.body.blocks
  ] }
}
export function frozenTemplateParameters(body: WorkflowSequenceBlock, names: string[]): Record<string, WorkflowValue> {
  const parameters: Record<string, WorkflowValue> = Object.create(null)
  for (const [index, name] of names.entries()) {
    const block = body.blocks[index]
    if (block?.kind !== 'bind' || block.blockId !== name || block.value.kind !== 'literal') throw new Error(copy.frozen)
    parameters[name] = block.value.value
  }
  return parameters
}
