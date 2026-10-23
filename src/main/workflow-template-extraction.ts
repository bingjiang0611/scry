import type { WorkflowProgram } from '../shared/workflow'
import { WORKFLOW_MAX_BATCH } from '../shared/workflow'
import type { WorkflowTemplateExtraction, WorkflowTemplateDefinition } from '../shared/workflow-template'
import { workflowTemplateCopy as copy } from '../shared/constants/copy'
import { templateObject, templateScope, templateHashPattern } from './workflow-template-identity'
import { matchesWorkflowValue, validateWorkflowValueSchema } from './workflow-values'
import { workflowSystemSourceBody } from './workflow-program'

export const templateExtractionFields = ['workflowId', 'programRevision', 'scope', 'name', 'description', 'parameters'] as const
export function validateTemplateExtraction(input: unknown): WorkflowTemplateExtraction {
  const value = templateObject(input, templateExtractionFields), scope = templateScope(value.scope)
  if (scope.kind === 'builtin') throw new Error(copy.readOnly)
  if (typeof value.workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value.workflowId) ||
    typeof value.programRevision !== 'string' || !templateHashPattern.test(value.programRevision) ||
    typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 ||
    typeof value.description !== 'string' || value.description.length > 4096) throw new Error(copy.invalid)
  if (!value.parameters || typeof value.parameters !== 'object' || Array.isArray(value.parameters) || Object.keys(value.parameters).length > WORKFLOW_MAX_BATCH) throw new Error(copy.parameter)
  const parameters: WorkflowTemplateExtraction['parameters'] = Object.create(null)
  for (const [name, raw] of Object.entries(value.parameters)) {
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(name)) throw new Error(copy.parameter)
    const parameter = templateObject(raw, ['schema', 'default'])
    if (parameter.default !== 'include' && parameter.default !== 'omit') throw new Error(copy.parameter)
    parameters[name] = { schema: validateWorkflowValueSchema(parameter.schema), default: parameter.default }
  }
  return { workflowId: value.workflowId, programRevision: value.programRevision, scope, name: value.name, description: value.description, parameters }
}
/** Export only portable definition fields, never the record, attempts, outputs,
 * workspace, execution approval or runtime bindings. Prompt/literal content is
 * still visible source: this is not an automatic sensitive-text scrubber. */
export function templateExtractionSource(program: WorkflowProgram, request: WorkflowTemplateExtraction): string {
  if (program.workflowId !== request.workflowId || program.programRevision !== request.programRevision) throw new Error(copy.sourceChanged)
  if (program.body.kind !== 'sequence') throw new Error(copy.invalid)
  const parameters: WorkflowTemplateDefinition['parameters'] = Object.create(null)
  for (const [name, selection] of Object.entries(request.parameters)) {
    const block = program.body.blocks.find(block => block.blockId === name)
    if (block?.kind !== 'bind' || block.value.kind !== 'literal' || !matchesWorkflowValue(block.value.value, selection.schema)) throw new Error(copy.parameterValue(name))
    parameters[name] = { schema: selection.schema, ...(selection.default === 'include' ? { default: structuredClone(block.value.value) } : {}) }
  }
  return JSON.stringify({ schemaVersion: 1, name: request.name, description: request.description, parameters,
    roles: program.roles.map(({ role, providerId, requestedModel }) => ({ role, providerId, ...(requestedModel ? { requestedModel } : {}) })),
    body: workflowSystemSourceBody({ ...program.body, blocks: program.body.blocks.filter(block => !Object.hasOwn(parameters, block.blockId)) })
  }, null, 2) + '\n'
}
