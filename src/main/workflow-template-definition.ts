import type { WorkflowBlock, WorkflowRole, WorkflowValue, WorkflowValueSchema } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import { WORKFLOW_TEMPLATE_MAX_BYTES, type WorkflowTemplateDefinition } from '../shared/workflow-template'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import { validateWorkflowBody, validateWorkflowRolePreference, WORKFLOW_ROLES } from './workflow-program'
import { matchesWorkflowValue, validateWorkflowValueSchema } from './workflow-values'

import { templateIdPattern, templateObject } from './workflow-template-identity'
export function assertTemplateSource(source: unknown): asserts source is string {
  if (typeof source !== 'string') throw new Error(copy.invalid)
  const bytes = Buffer.from(source, 'utf8')
  if (bytes.length > WORKFLOW_TEMPLATE_MAX_BYTES) throw new Error(copy.limit)
  if (bytes.toString('utf8') !== source) throw new Error(copy.invalid)
}
export function validateWorkflowTemplate(source: string, expectedId: string): WorkflowTemplateDefinition {
  assertTemplateSource(source)
  const value = templateObject(JSON.parse(source), ['schemaVersion', 'templateId', 'name', 'description', 'parameters', 'roles', 'body'])
  if (value.schemaVersion !== 1) throw new Error(copy.version)
  if (!templateIdPattern.test(expectedId) || value.templateId !== expectedId) throw new Error(copy.invalid)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || typeof value.description !== 'string' || value.description.length > 4096) throw new Error(copy.invalid)
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters)) throw new Error(copy.parameter)
  const schemas = new Map<string, WorkflowValueSchema>()
  const parameters: WorkflowTemplateDefinition['parameters'] = Object.create(null)
  for (const [name, raw] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(name)) throw new Error(copy.parameter)
    const parameter = templateObject(raw, ['schema', 'default'])
    const schema = validateWorkflowValueSchema(parameter.schema)
    if (Object.hasOwn(parameter, 'default') && !matchesWorkflowValue(parameter.default, schema)) throw new Error(copy.parameter)
    parameters[name] = { schema, ...(Object.hasOwn(parameter, 'default') ? { default: parameter.default as WorkflowValue } : {}) }
    schemas.set(name, schema)
  }
  if (!Array.isArray(value.roles) || value.roles.length > WORKFLOW_ROLES.length) throw new Error(copy.invalid)
  const roles = value.roles.map(raw => {
    const preference = templateObject(raw, ['role', 'providerId', 'requestedModel'])
    if (!(WORKFLOW_ROLES as readonly unknown[]).includes(preference.role)) throw new Error(copy.invalid)
    if (preference.providerId === undefined) {
      if (preference.requestedModel !== undefined) throw new Error(copy.invalid)
      return { role: preference.role as WorkflowRole }
    }
    const binding = validateWorkflowRolePreference(preference)
    return { role: binding.role, providerId: binding.providerId, ...(binding.requestedModel ? { requestedModel: binding.requestedModel } : {}) }
  })
  const requiredRoles = new Set(roles.map(role => role.role))
  if (requiredRoles.size !== roles.length) throw new Error(copy.invalid)
  const body = validateWorkflowBody(value.body, requiredRoles, schemas)
  const pending: WorkflowBlock[] = [body]
  while (pending.length) {
    const block = pending.pop()!
    if (block.kind === 'check' && block.authorization !== undefined) throw new Error(copy.invalid)
    pending.push(...workflowChildBlocks(block))
  }
  return { schemaVersion: 1, templateId: expectedId, name: value.name, description: value.description, parameters, roles, body }
}
