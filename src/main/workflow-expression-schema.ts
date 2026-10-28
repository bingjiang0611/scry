import { WORKFLOW_MAX_BATCH, type WorkflowExpression, type WorkflowValue, type WorkflowValueSchema } from '../shared/workflow'
import { workflowExpressionCopy as copy } from '../shared/constants/copy'
import { collectionItemSchema } from './workflow-collections'

export function workflowValueSchema(value: WorkflowValue): WorkflowValueSchema {
  if (Array.isArray(value)) return { type: 'array', maxItems: value.length, items: value.length ? union(value.map(workflowValueSchema)) : { type: 'union', variants: [] } }
  if (value !== null && typeof value === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workflowValueSchema(item)])), required: Object.keys(value) }
  return { type: 'enum', values: [value] }
}

function union(schemas: WorkflowValueSchema[]): WorkflowValueSchema {
  const unique = [...new Map(schemas.flatMap(schema => schema.type === 'union' ? schema.variants : [schema]).map(schema => [JSON.stringify(schema), schema])).values()]
  if (unique.length === 1) return unique[0]
  if (unique.length && unique.every((schema): schema is Extract<WorkflowValueSchema, { type: 'array' }> => schema.type === 'array')) {
    return { type: 'array', items: union(unique.map(schema => schema.items)), maxItems: Math.max(...unique.map(schema => schema.maxItems)) }
  }
  if (unique.length && unique.every((schema): schema is Extract<WorkflowValueSchema, { type: 'collection' }> => schema.type === 'collection')) {
    return { type: 'collection', items: union(unique.map(schema => schema.items)) }
  }
  return { type: 'union', variants: unique }
}

function scalarTypes(schema: WorkflowValueSchema): string[] | undefined {
  if (schema.type === 'enum') return [...new Set(schema.values.map(value => value === null ? 'null' : typeof value))]
  if (schema.type === 'union') {
    const types = schema.variants.map(scalarTypes)
    return types.some(value => value === undefined) ? undefined : [...new Set(types.flat() as string[])]
  }
  return ['string', 'number', 'boolean', 'null'].includes(schema.type) ? [schema.type] : undefined
}

function fieldSchema(schema: WorkflowValueSchema, path: readonly string[]): WorkflowValueSchema {
  if (!path.length) return schema
  if (schema.type === 'union') return union(schema.variants.map(variant => fieldSchema(variant, path)))
  const [key, ...rest] = path
  if (schema.type === 'object' && Object.hasOwn(schema.properties, key)) return fieldSchema(schema.properties[key], rest)
  if (schema.type === 'array' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < schema.maxItems) return fieldSchema(schema.items, rest)
  throw new Error(copy.missing(JSON.stringify(path)))
}

function arraySchema(schema: WorkflowValueSchema, kind: string): Extract<WorkflowValueSchema, { type: 'array' }> {
  const normalized = schema.type === 'union' ? union(schema.variants) : schema
  if (normalized.type !== 'array') throw new Error(copy.type(kind))
  return normalized
}

const boolean = (schema: WorkflowValueSchema): boolean => schema.type === 'boolean' || (schema.type === 'enum' && schema.values.every(value => typeof value === 'boolean')) || (schema.type === 'union' && schema.variants.every(boolean))

export function inferWorkflowExpression(expression: WorkflowExpression, scope: ReadonlyMap<string, WorkflowValueSchema>): WorkflowValueSchema {
  const infer = (value: WorkflowExpression) => inferWorkflowExpression(value, scope)
  switch (expression.kind) {
    case 'literal': return workflowValueSchema(expression.value)
    case 'ref': {
      const schema = scope.get(expression.name)
      if (!schema) throw new Error(copy.reference(expression.name))
      return schema.type === 'union' ? union(schema.variants) : schema
    }
    case 'field': return fieldSchema(infer(expression.source), expression.path)
    case 'compare': {
      const left = infer(expression.left), right = infer(expression.right)
      if (expression.operator !== 'eq' && expression.operator !== 'ne') {
        const leftTypes = scalarTypes(left), rightTypes = scalarTypes(right)
        if (leftTypes?.length === 0 || rightTypes?.length === 0) return { type: 'boolean' }
        if (leftTypes?.length !== 1 || !['string', 'number'].includes(leftTypes[0]) || rightTypes?.length !== 1 || rightTypes[0] !== leftTypes[0]) throw new Error(copy.type(expression.kind))
      }
      return { type: 'boolean' }
    }
    case 'and': case 'or': case 'not': {
      const schemas = expression.kind === 'not' ? [infer(expression.value)] : expression.values.map(infer)
      if (!schemas.every(boolean)) throw new Error(copy.type(expression.kind))
      return { type: 'boolean' }
    }
    case 'count': {
      const schema = infer(expression.value)
      if (schema.type !== 'collection') arraySchema(schema, expression.kind)
      return { type: 'number' }
    }
    case 'concat': {
      const schemas = expression.values.map(infer)
      if (schemas.every(schema => scalarTypes(schema)?.every(type => type === 'string'))) return { type: 'string' }
      const arrays = schemas.map(schema => arraySchema(schema, expression.kind))
      return { type: 'array', items: union(arrays.map(schema => schema.items)), maxItems: WORKFLOW_MAX_BATCH }
    }
    case 'group': case 'unique': {
      const input = infer(expression.items)
      const source = input.type === 'collection' ? input : arraySchema(input, expression.kind)
      const key = fieldSchema(source.items, expression.key)
      if ((source.type === 'collection' || source.maxItems !== 0) && scalarTypes(key) === undefined) throw new Error(copy.key)
      return { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
        key, members: source, derivedFrom: { type: 'array', items: { type: 'number' }, maxItems: WORKFLOW_MAX_BATCH }
      }, required: ['key', 'members', 'derivedFrom'] } }
    }
    case 'filter': case 'partition': {
      const input = infer(expression.items)
      const source = input.type === 'collection' ? input : arraySchema(input, expression.kind)
      const member = source.items
      if (scope.has(expression.item)) throw new Error(copy.binding(expression.item))
      if (!boolean(inferWorkflowExpression(expression.when, new Map(scope).set(expression.item, member)))) throw new Error(copy.type(expression.kind))
      const row: WorkflowValueSchema = { type: 'object', properties: {
        index: { type: 'number' }, value: member, reason: { type: 'string' }
      }, required: ['index', 'value', 'reason'] }
      const partition: WorkflowValueSchema = source.type === 'collection' ? { type: 'collection', items: collectionItemSchema(row) }
        : { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: row }
      return { type: 'object', properties: { matched: partition, rejected: partition, unknown: partition }, required: ['matched', 'rejected', 'unknown'] }
    }
    case 'project': {
      const input = infer(expression.items)
      const source = input.type === 'collection' ? input : arraySchema(input, expression.kind)
      if (scope.has(expression.item)) throw new Error(copy.binding(expression.item))
      const projected = inferWorkflowExpression(expression.value, new Map(scope).set(expression.item, source.items))
      return source.type === 'collection' ? { type: 'collection', items: collectionItemSchema(projected) }
        : { type: 'array', maxItems: source.maxItems, items: projected }
    }
  }
}

export const workflowBooleanSchema = boolean
export const workflowScalarSchema = (schema: WorkflowValueSchema): boolean => scalarTypes(schema) !== undefined
export const workflowItemsSchema = (schema: WorkflowValueSchema): WorkflowValueSchema => schema.type === 'collection' ? schema.items : arraySchema(schema, 'map').items
