import {
  WORKFLOW_MAX_BATCH, WORKFLOW_MAX_EXPRESSION_DEPTH, WORKFLOW_MAX_EXPRESSION_NODES,
  WORKFLOW_MAX_VALUE_BYTES, WORKFLOW_MAX_VALUE_DEPTH, type WorkflowEvaluation, type WorkflowExpression,
  type WorkflowScalar, type WorkflowValue, type WorkflowValueSchema
} from '../shared/workflow'
import { workflowCollectionCopy, workflowExpressionCopy as copy } from '../shared/constants/copy'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is WorkflowScalar => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
const refs = (...values: WorkflowEvaluation[]): string[] => [...new Set(values.flatMap(value => value.derivedFrom))]
const unknown = (reason: string, derivedFrom: string[] = []): WorkflowEvaluation => ({ state: 'unknown', reason: reason.slice(0, 4096), derivedFrom })
const known = (value: WorkflowValue, derivedFrom: string[] = []): WorkflowEvaluation => {
  assertWorkflowValue(value)
  return { state: 'known', value, derivedFrom }
}

export function assertWorkflowValue(input: unknown): asserts input is WorkflowValue {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }]
  let length = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (depth > WORKFLOW_MAX_VALUE_DEPTH) throw new Error(copy.valueLimit)
    if (scalar(value)) length += Buffer.byteLength(JSON.stringify(value))
    else if (Array.isArray(value)) {
      if (value.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
      length += 2 + Math.max(0, value.length - 1)
      for (const item of value) pending.push({ value: item, depth: depth + 1 })
    } else if (record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      const entries = Object.entries(value)
      length += 2 + Math.max(0, entries.length - 1)
      for (const [key, item] of entries) {
        length += Buffer.byteLength(JSON.stringify(key)) + 1
        pending.push({ value: item, depth: depth + 1 })
      }
    } else throw new Error(copy.invalid)
    if (length > WORKFLOW_MAX_VALUE_BYTES) throw new Error(copy.valueLimit)
  }
}

function literal(value: unknown): WorkflowValue {
  assertWorkflowValue(value)
  return structuredClone(value)
}

export function validateWorkflowExpression(input: unknown): WorkflowExpression {
  let nodes = 0
  const path = (value: unknown, empty: boolean): string[] => {
    if (!Array.isArray(value) || (!empty && !value.length) || value.length > WORKFLOW_MAX_EXPRESSION_DEPTH || !value.every((part): part is string => typeof part === 'string' && part.length <= 256)) throw new Error(copy.invalid)
    return [...value]
  }
  const parse = (value: unknown, depth: number): WorkflowExpression => {
    if (++nodes > WORKFLOW_MAX_EXPRESSION_NODES || depth > WORKFLOW_MAX_EXPRESSION_DEPTH) throw new Error(copy.limit)
    if (!record(value)) throw new Error(copy.invalid)
    const fields: Record<string, readonly string[]> = {
      literal: ['value'], ref: ['name'], field: ['source', 'path'], compare: ['operator', 'left', 'right'],
      and: ['values'], or: ['values'], not: ['value'], count: ['value'], concat: ['values'],
      group: ['items', 'key'], unique: ['items', 'key'], filter: ['items', 'item', 'when'], partition: ['items', 'item', 'when']
    }
    if (typeof value.kind !== 'string' || !Object.hasOwn(fields, value.kind)) throw new Error(copy.invalid)
    for (const field of Object.keys(value)) if (field !== 'kind' && !fields[value.kind].includes(field)) throw new Error(copy.field(field))
    const child = (item: unknown) => parse(item, depth + 1)
    const children = (items: unknown): WorkflowExpression[] => {
      if (!Array.isArray(items) || !items.length || items.length > WORKFLOW_MAX_BATCH) throw new Error(copy.invalid)
      return items.map(child)
    }
    switch (value.kind) {
      case 'literal': {
        return { kind: 'literal', value: literal(value.value) }
      }
      case 'ref':
        if (!id(value.name)) throw new Error(copy.invalid)
        return { kind: 'ref', name: value.name }
      case 'field': return { kind: 'field', source: child(value.source), path: path(value.path, false) }
      case 'compare':
        if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(String(value.operator))) throw new Error(copy.invalid)
        return { kind: 'compare', operator: value.operator as Extract<WorkflowExpression, { kind: 'compare' }>['operator'], left: child(value.left), right: child(value.right) }
      case 'and': case 'or': case 'concat': return { kind: value.kind, values: children(value.values) }
      case 'not': case 'count': return { kind: value.kind, value: child(value.value) }
      case 'group': case 'unique': return { kind: value.kind, items: child(value.items), key: path(value.key, true) }
      case 'filter': case 'partition':
        if (!id(value.item)) throw new Error(copy.invalid)
        return { kind: value.kind, items: child(value.items), item: value.item, when: child(value.when) }
      default: throw new Error(copy.invalid)
    }
  }
  return parse(input, 0)
}

/** Canonical JSON equality/fingerprints do not depend on object insertion order
 * or a transient -0 representation that JSON persistence normalizes to zero. */
export function workflowValueKey(value: WorkflowValue): string {
  if (Array.isArray(value)) return `[${value.map(workflowValueKey).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${workflowValueKey(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function workflowField(value: WorkflowValue, path: readonly string[], derivedFrom: string[] = []): WorkflowEvaluation {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object' || (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(part)) || !Object.hasOwn(current, part)) return unknown(copy.missing(JSON.stringify(path)), derivedFrom)
    current = (current as Record<string, WorkflowValue>)[part]
  }
  return known(current, derivedFrom)
}

export function evaluateWorkflowExpression(expression: WorkflowExpression, bindings: ReadonlyMap<string, WorkflowEvaluation>): WorkflowEvaluation {
  const evaluate = (item: WorkflowExpression, scope = bindings): WorkflowEvaluation => {
    switch (item.kind) {
      case 'literal': return known(item.value)
      case 'ref': {
        const value = scope.get(item.name)
        return value ? { ...value, derivedFrom: [...new Set([...value.derivedFrom, item.name])] } : unknown(copy.reference(item.name), [item.name])
      }
      case 'field': {
        const value = evaluate(item.source, scope)
        return value.state === 'unknown' || !item.path.length ? value : workflowField(value.value, item.path, value.derivedFrom)
      }
      case 'compare': {
        const left = evaluate(item.left, scope), right = evaluate(item.right, scope), sources = refs(left, right)
        if (left.state === 'unknown') return unknown(left.reason, sources)
        if (right.state === 'unknown') return unknown(right.reason, sources)
        if (item.operator === 'eq' || item.operator === 'ne') {
          const same = workflowValueKey(left.value) === workflowValueKey(right.value)
          return known(item.operator === 'eq' ? same : !same, sources)
        }
        if (!((typeof left.value === 'number' && typeof right.value === 'number') || (typeof left.value === 'string' && typeof right.value === 'string'))) return unknown(copy.type(item.kind), sources)
        const a = left.value, b = right.value
        return known(item.operator === 'lt' ? a < b : item.operator === 'lte' ? a <= b : item.operator === 'gt' ? a > b : a >= b, sources)
      }
      case 'and': case 'or': case 'concat': {
        const values = item.values.map(value => evaluate(value, scope)), sources = refs(...values)
        const missing = values.find(value => value.state === 'unknown')
        if (missing?.state === 'unknown') return unknown(missing.reason, sources)
        const data = values.map(value => (value as Extract<WorkflowEvaluation, { state: 'known' }>).value)
        if (item.kind === 'concat') {
          if (data.every((value): value is string => typeof value === 'string')) return known(data.join(''), sources)
          if (data.every(Array.isArray)) {
            const joined = data.flat()
            if (joined.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
            return known(joined, sources)
          }
        } else if (data.every((value): value is boolean => typeof value === 'boolean')) return known(item.kind === 'and' ? data.every(Boolean) : data.some(Boolean), sources)
        return unknown(copy.type(item.kind), sources)
      }
      case 'not': case 'count': {
        const value = evaluate(item.value, scope)
        if (value.state === 'unknown') return value
        if (item.kind === 'not' && typeof value.value === 'boolean') return known(!value.value, value.derivedFrom)
        if (item.kind === 'count' && value.collection) return value.collection.sealed ? known(value.collection.count, value.derivedFrom) : unknown(workflowCollectionCopy.unsealed, value.derivedFrom)
        if (item.kind === 'count' && Array.isArray(value.value)) return known(value.value.length, value.derivedFrom)
        return unknown(copy.type(item.kind), value.derivedFrom)
      }
      case 'group': case 'unique': {
        const value = evaluate(item.items, scope)
        if (value.state === 'unknown') return value
        if (!Array.isArray(value.value)) return unknown(copy.type(item.kind), value.derivedFrom)
        if (value.value.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
        const groups = new Map<string, { key: WorkflowScalar; members: WorkflowValue[]; derivedFrom: number[] }>()
        for (const [index, member] of value.value.entries()) {
          const key = workflowField(member, item.key, value.derivedFrom)
          if (key.state === 'unknown') return key
          if (!scalar(key.value)) return unknown(copy.key, value.derivedFrom)
          const stable = workflowValueKey(key.value)
          const group = groups.get(stable) ?? { key: key.value, members: [], derivedFrom: [] }
          group.members.push(member)
          group.derivedFrom.push(index)
          groups.set(stable, group)
        }
        return known([...groups.values()], value.derivedFrom)
      }
      case 'filter': case 'partition': {
        const value = evaluate(item.items, scope)
        if (value.state === 'unknown') return value
        if (!Array.isArray(value.value)) return unknown(copy.type(item.kind), value.derivedFrom)
        if (value.value.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
        if (scope.has(item.item)) throw new Error(copy.binding(item.item))
        const sources = new Set(value.derivedFrom)
        const partitions: { matched: WorkflowValue[]; rejected: WorkflowValue[]; unknown: WorkflowValue[] } = { matched: [], rejected: [], unknown: [] }
        const local = new Map(scope)
        for (const [index, member] of value.value.entries()) {
          local.set(item.item, { state: 'known', value: member, derivedFrom: value.derivedFrom })
          const decision = evaluate(item.when, local)
          for (const source of decision.derivedFrom) if (source !== item.item) sources.add(source)
          const entry = { index, value: member, reason: decision.state === 'unknown' ? decision.reason : typeof decision.value !== 'boolean' ? copy.type(item.kind) : decision.value ? copy.trueReason : copy.falseReason }
          if (decision.state === 'known' && typeof decision.value === 'boolean') partitions[decision.value ? 'matched' : 'rejected'].push(entry)
          else partitions.unknown.push(entry)
        }
        return known(partitions, [...sources])
      }
    }
  }
  return evaluate(expression)
}

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
      return schema
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
      const source = arraySchema(infer(expression.items), expression.kind)
      const key = fieldSchema(source.items, expression.key)
      if (source.maxItems !== 0 && scalarTypes(key) === undefined) throw new Error(copy.key)
      return { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
        key, members: source, derivedFrom: { type: 'array', items: { type: 'number' }, maxItems: WORKFLOW_MAX_BATCH }
      }, required: ['key', 'members', 'derivedFrom'] } }
    }
    case 'filter': case 'partition': {
      const source = arraySchema(infer(expression.items), expression.kind)
      if (scope.has(expression.item)) throw new Error(copy.binding(expression.item))
      if (!boolean(inferWorkflowExpression(expression.when, new Map(scope).set(expression.item, source.items)))) throw new Error(copy.type(expression.kind))
      const partition: WorkflowValueSchema = { type: 'array', maxItems: WORKFLOW_MAX_BATCH, items: { type: 'object', properties: {
        index: { type: 'number' }, value: source.items, reason: { type: 'string' }
      }, required: ['index', 'value', 'reason'] } }
      return { type: 'object', properties: { matched: partition, rejected: partition, unknown: partition }, required: ['matched', 'rejected', 'unknown'] }
    }
  }
}

export function workflowExpressionReferences(expression: WorkflowExpression): string[] {
  const names = new Set<string>()
  const visit = (value: WorkflowExpression, local: ReadonlySet<string>): void => {
    switch (value.kind) {
      case 'literal': return
      case 'ref': if (!local.has(value.name)) names.add(value.name); return
      case 'field': visit(value.source, local); return
      case 'compare': visit(value.left, local); visit(value.right, local); return
      case 'and': case 'or': case 'concat': value.values.forEach(item => visit(item, local)); return
      case 'not': case 'count': visit(value.value, local); return
      case 'group': case 'unique': visit(value.items, local); return
      case 'filter': case 'partition': visit(value.items, local); visit(value.when, new Set(local).add(value.item)); return
    }
  }
  visit(expression, new Set())
  return [...names]
}

export const workflowBooleanSchema = boolean
export const workflowScalarSchema = (schema: WorkflowValueSchema): boolean => scalarTypes(schema) !== undefined
export const workflowItemsSchema = (schema: WorkflowValueSchema): WorkflowValueSchema => schema.type === 'collection' ? schema.items : arraySchema(schema, 'map').items
