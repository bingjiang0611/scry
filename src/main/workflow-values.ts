import {
  WORKFLOW_MAX_BATCH,
  WORKFLOW_MAX_OUTPUT_LENGTH,
  WORKFLOW_MAX_SCHEMA_DEPTH,
  WORKFLOW_MAX_SCHEMA_NODES,
  type WorkflowScalar,
  type WorkflowValue,
  type WorkflowValueSchema
} from '../shared/workflow'
import { workflowValueCopy as copy } from '../shared/constants/copy'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is WorkflowScalar =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))

export function validateWorkflowValueSchema(input: unknown): WorkflowValueSchema {
  let nodes = 0
  const parse = (value: unknown, depth: number): WorkflowValueSchema => {
    if (++nodes > WORKFLOW_MAX_SCHEMA_NODES || depth > WORKFLOW_MAX_SCHEMA_DEPTH) throw new Error(copy.schemaLimit)
    if (!object(value)) throw new Error(copy.invalidSchema)
    const allowed = value.type === 'array' ? ['type', 'items', 'maxItems']
      : value.type === 'object' ? ['type', 'properties', 'required']
        : value.type === 'enum' ? ['type', 'values'] : value.type === 'union' ? ['type', 'variants'] : ['type']
    for (const field of Object.keys(value)) if (!allowed.includes(field)) throw new Error(copy.unsupportedField(field))
    switch (value.type) {
      case 'string': case 'number': case 'boolean': case 'null': return { type: value.type }
      case 'enum': {
        if (!Array.isArray(value.values) || !value.values.length || value.values.length > WORKFLOW_MAX_BATCH || !value.values.every(scalar)) throw new Error(copy.invalidEnum)
        if (new Set(value.values.map(item => JSON.stringify(item))).size !== value.values.length) throw new Error(copy.invalidEnum)
        return { type: 'enum', values: [...value.values] }
      }
      case 'union': {
        if (!Array.isArray(value.variants) || !value.variants.length) throw new Error(copy.invalidSchema)
        return { type: 'union', variants: value.variants.map(variant => parse(variant, depth + 1)) }
      }
      case 'array': {
        const maxItems = value.maxItems ?? WORKFLOW_MAX_BATCH
        if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 0 || maxItems > WORKFLOW_MAX_BATCH) throw new Error(copy.invalidArrayLimit)
        return { type: 'array', items: parse(value.items, depth + 1), maxItems }
      }
      case 'object': {
        if (!object(value.properties)) throw new Error(copy.invalidSchema)
        const properties = Object.fromEntries(Object.entries(value.properties).map(([name, schema]) => [name, parse(schema, depth + 1)]))
        const required = value.required ?? Object.keys(properties)
        if (!Array.isArray(required) || !required.every((name): name is string => typeof name === 'string' && Object.hasOwn(properties, name)) || new Set(required).size !== required.length) throw new Error(copy.invalidRequired)
        return { type: 'object', properties, required: [...required] }
      }
      default: throw new Error(copy.invalidSchema)
    }
  }
  return parse(input, 0)
}

class WorkflowValueMismatch extends Error {}

function assertValue(value: unknown, schema: WorkflowValueSchema, path: string): asserts value is WorkflowValue {
  switch (schema.type) {
    case 'collection': throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
    case 'null':
      if (value !== null) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      return
    case 'string': case 'boolean': case 'number':
      if (typeof value !== schema.type || (typeof value === 'number' && !Number.isFinite(value))) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      return
    case 'enum':
      if (!scalar(value) || !schema.values.includes(value)) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      return
    case 'union':
      if (!schema.variants.some(variant => matchesWorkflowValue(value, variant))) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      return
    case 'array':
      if (!Array.isArray(value) || value.length > schema.maxItems) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      value.forEach((item, index) => assertValue(item, schema.items, `${path}[${index}]`))
      return
    case 'object':
      if (!object(value)) throw new WorkflowValueMismatch(copy.valueMismatch(path, schema.type))
      for (const name of schema.required) if (!Object.hasOwn(value, name)) throw new WorkflowValueMismatch(copy.missingProperty(`${path}.${name}`))
      for (const [name, item] of Object.entries(value)) {
        if (!Object.hasOwn(schema.properties, name)) throw new WorkflowValueMismatch(copy.unexpectedProperty(`${path}.${name}`))
        assertValue(item, schema.properties[name], `${path}.${name}`)
      }
  }
}

export function matchesWorkflowValue(value: unknown, schema: WorkflowValueSchema): value is WorkflowValue {
  try { assertValue(value, schema, '$'); return true } catch (error) {
    if (!(error instanceof WorkflowValueMismatch)) throw error
    return false
  }
}

/** Structural assignment for frozen loop state, including host-only collection
 * schemas. Runtime values still pass the actual data contract before commit. */
export function workflowSchemaAssignable(actual: WorkflowValueSchema, expected: WorkflowValueSchema): boolean {
  if (actual.type === 'union') return actual.variants.every(variant => workflowSchemaAssignable(variant, expected))
  if (expected.type === 'union') return expected.variants.some(variant => workflowSchemaAssignable(actual, variant))
  if (actual.type === 'enum') return actual.values.every(value => matchesWorkflowValue(value, expected))
  if (actual.type !== expected.type) return false
  if (actual.type === 'collection' && expected.type === 'collection') return workflowSchemaAssignable(actual.items, expected.items)
  if (actual.type === 'array' && expected.type === 'array') return actual.maxItems <= expected.maxItems && workflowSchemaAssignable(actual.items, expected.items)
  if (actual.type === 'object' && expected.type === 'object') return expected.required.every(key => actual.required.includes(key)) && Object.entries(actual.properties).every(([key, schema]) => Object.hasOwn(expected.properties, key) && workflowSchemaAssignable(schema, expected.properties[key]))
  return true
}

/** Parse the whole Provider output. Never recover a JSON fragment from prose,
 * coerce strings into booleans/numbers, fill missing fields, or invent defaults. */
export function decodeWorkflowOutput(text: string | undefined, schema: WorkflowValueSchema): WorkflowValue {
  if (typeof text !== 'string') throw new Error(copy.invalidOutput)
  if (text.length > WORKFLOW_MAX_OUTPUT_LENGTH) throw new Error(copy.outputLimit)
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error(copy.invalidOutput, { cause: error })
  }
  assertValue(value, schema, '$')
  return value
}

export function workflowStructuredOutputPrompt(prompt: string, schema: WorkflowValueSchema): string {
  return `${prompt}\n\n${copy.structuredInstruction}\n${JSON.stringify(schema)}`
}
