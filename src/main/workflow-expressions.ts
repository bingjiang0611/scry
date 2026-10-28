import {
  WORKFLOW_MAX_BATCH, WORKFLOW_MAX_EXPRESSION_DEPTH, WORKFLOW_MAX_EXPRESSION_NODES,
  WORKFLOW_MAX_VALUE_BYTES, WORKFLOW_MAX_VALUE_DEPTH, type WorkflowCollectionField, type WorkflowCollectionReference, type WorkflowEvaluation, type WorkflowExpression,
  type WorkflowScalar, type WorkflowValue
} from '../shared/workflow'
import { workflowCollectionCopy, workflowExpressionCopy as copy } from '../shared/constants/copy'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): value is WorkflowScalar => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
const refs = (...values: WorkflowEvaluation[]): string[] => [...new Set(values.flatMap(value => value.derivedFrom))]
const unknown = (reason: string, derivedFrom: string[] = []): WorkflowEvaluation => ({ state: 'unknown', reason: reason.slice(0, 4096), derivedFrom })
const known = (value: WorkflowValue, derivedFrom: string[] = [], collectionFields: WorkflowCollectionField[] = []): WorkflowEvaluation => {
  assertWorkflowValue(value)
  if (collectionFields.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
  return { state: 'known', value, derivedFrom, ...(collectionFields.length ? { collectionFields } : {}) }
}

export function workflowCollectionFields(value: WorkflowEvaluation, prefix: string[]): WorkflowCollectionField[] {
  if (value.state !== 'known') return []
  return [...(value.collection ? [{ path: prefix, collection: value.collection }] : []),
    ...(value.collectionFields ?? []).map(field => ({ path: [...prefix, ...field.path], collection: field.collection }))]
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
      group: ['items', 'key'], unique: ['items', 'key'], filter: ['items', 'item', 'when'], partition: ['items', 'item', 'when'], project: ['items', 'item', 'value']
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
      case 'project':
        if (!id(value.item)) throw new Error(copy.invalid)
        return { kind: 'project', items: child(value.items), item: value.item, value: child(value.value) }
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

export function workflowArrayAuthorities(value: Extract<WorkflowEvaluation, { state: 'known' }>): Map<string, WorkflowCollectionField[]> {
  const byIndex = new Map<string, WorkflowCollectionField[]>()
  for (const field of value.collectionFields ?? []) {
    const fields = byIndex.get(field.path[0]) ?? []
    fields.push(field); byIndex.set(field.path[0], fields)
  }
  return byIndex
}
function remapArrayCollections(value: Extract<WorkflowEvaluation, { state: 'known' }>, destinations: string[][]): WorkflowCollectionField[] {
  return (value.collectionFields ?? []).map(field => ({ path: [...destinations[Number(field.path[0])], ...field.path.slice(1)], collection: field.collection }))
}

export function workflowField(value: WorkflowValue, path: readonly string[], derivedFrom: string[] = [], authority?: Pick<Extract<WorkflowEvaluation, { state: 'known' }>, 'collection' | 'collectionFields'>): WorkflowEvaluation {
  let current = value
  for (const part of path) {
    if (current === null || typeof current !== 'object' || (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(part)) || !Object.hasOwn(current, part)) return unknown(copy.missing(JSON.stringify(path)), derivedFrom)
    current = (current as Record<string, WorkflowValue>)[part]
  }
  const authorities = [...(authority?.collection ? [{ path: [], collection: authority.collection }] : []), ...(authority?.collectionFields ?? [])]
  const selected = authorities.filter(field => path.every((part, index) => field.path[index] === part))
  const fields = selected.filter(field => field.path.length > path.length).map(field => ({ ...field, path: field.path.slice(path.length) }))
  const collection = selected.find(field => field.path.length === path.length)?.collection
  return { ...known(current, derivedFrom, fields), ...(collection ? { collection } : {}) }
}

export type WorkflowCollectionExpressionRequest = {
  expression: Extract<WorkflowExpression, { kind: 'group' | 'unique' | 'filter' | 'partition' | 'project' }>
  source: Extract<WorkflowEvaluation, { state: 'known' }> & { collection: WorkflowCollectionReference }
  bindings: ReadonlyMap<string, WorkflowEvaluation>
}
type ExpressionSteps = Generator<WorkflowCollectionExpressionRequest, WorkflowEvaluation, WorkflowEvaluation>

/** One evaluator. Pure callers run it synchronously; the control owner resolves
 * yielded host-collection reads without materializing an unbounded JSON value. */
export function* workflowExpressionSteps(expression: WorkflowExpression, bindings: ReadonlyMap<string, WorkflowEvaluation>): ExpressionSteps {
  const evaluate = function* (item: WorkflowExpression, scope = bindings): ExpressionSteps {
    switch (item.kind) {
      case 'literal': return known(item.value)
      case 'ref': {
        const value = scope.get(item.name)
        return value ? { ...value, derivedFrom: [...new Set([...value.derivedFrom, item.name])] } : unknown(copy.reference(item.name), [item.name])
      }
      case 'field': {
        const value = yield* evaluate(item.source, scope)
        return value.state === 'unknown' || !item.path.length ? value : workflowField(value.value, item.path, value.derivedFrom, value)
      }
      case 'compare': {
        const left = yield* evaluate(item.left, scope), right = yield* evaluate(item.right, scope), sources = refs(left, right)
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
        const values: WorkflowEvaluation[] = []
        for (const value of item.values) values.push(yield* evaluate(value, scope))
        const sources = refs(...values)
        const missing = values.find(value => value.state === 'unknown')
        if (missing?.state === 'unknown') return unknown(missing.reason, sources)
        const data = values.map(value => (value as Extract<WorkflowEvaluation, { state: 'known' }>).value)
        if (item.kind === 'concat') {
          if (data.every((value): value is string => typeof value === 'string')) return known(data.join(''), sources)
          if (data.every((value): value is WorkflowValue[] => Array.isArray(value))) {
            if (data.reduce((sum, array) => sum + array.length, 0) > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
            let offset = 0
            const fields = values.flatMap((value, index) => {
              const destinations = data[index].map((_, member) => [String(offset + member)])
              offset += data[index].length
              return remapArrayCollections(value as Extract<WorkflowEvaluation, { state: 'known' }>, destinations)
            })
            return known(data.flat(), sources, fields)
          }
        } else if (data.every((value): value is boolean => typeof value === 'boolean')) return known(item.kind === 'and' ? data.every(Boolean) : data.some(Boolean), sources)
        return unknown(copy.type(item.kind), sources)
      }
      case 'not': case 'count': {
        const value = yield* evaluate(item.value, scope)
        if (value.state === 'unknown') return value
        if (item.kind === 'not' && typeof value.value === 'boolean') return known(!value.value, value.derivedFrom)
        if (item.kind === 'count' && value.collection) return value.collection.sealed ? known(value.collection.count, value.derivedFrom) : unknown(workflowCollectionCopy.unsealed, value.derivedFrom)
        if (item.kind === 'count' && Array.isArray(value.value)) return known(value.value.length, value.derivedFrom)
        return unknown(copy.type(item.kind), value.derivedFrom)
      }
      case 'group': case 'unique': {
        const value = yield* evaluate(item.items, scope)
        if (value.state === 'unknown') return value
        if (value.collection) return yield { expression: item, source: { ...value, collection: value.collection }, bindings: scope }
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
        const grouped = [...groups.values()], destinations: string[][] = []
        grouped.forEach((group, index) => group.derivedFrom.forEach((source, member) => { destinations[source] = [String(index), 'members', String(member)] }))
        return known(grouped, value.derivedFrom, remapArrayCollections(value, destinations))
      }
      case 'filter': case 'partition': {
        const value = yield* evaluate(item.items, scope)
        if (value.state === 'unknown') return value
        if (value.collection) return yield { expression: item, source: { ...value, collection: value.collection }, bindings: scope }
        if (!Array.isArray(value.value)) return unknown(copy.type(item.kind), value.derivedFrom)
        if (value.value.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
        if (scope.has(item.item)) throw new Error(copy.binding(item.item))
        const sources = new Set(value.derivedFrom)
        const partitions: { matched: WorkflowValue[]; rejected: WorkflowValue[]; unknown: WorkflowValue[] } = { matched: [], rejected: [], unknown: [] }
        const local = new Map(scope), authorities = workflowArrayAuthorities(value), destinations: string[][] = []
        for (const [index, member] of value.value.entries()) {
          local.set(item.item, workflowField(value.value, [String(index)], value.derivedFrom, { collectionFields: authorities.get(String(index)) }))
          const decision = yield* evaluate(item.when, local)
          for (const source of decision.derivedFrom) if (source !== item.item) sources.add(source)
          const entry = { index, value: member, reason: decision.state === 'unknown' ? decision.reason : typeof decision.value !== 'boolean' ? copy.type(item.kind) : decision.value ? copy.trueReason : copy.falseReason }
          const bucket = decision.state === 'known' && typeof decision.value === 'boolean' ? decision.value ? 'matched' : 'rejected' : 'unknown'
          destinations[index] = [bucket, String(partitions[bucket].length), 'value']
          partitions[bucket].push(entry)
        }
        return known(partitions, [...sources], remapArrayCollections(value, destinations))
      }
      case 'project': {
        const value = yield* evaluate(item.items, scope)
        if (value.state === 'unknown') return value
        if (value.collection) return yield { expression: item, source: { ...value, collection: value.collection }, bindings: scope }
        if (!Array.isArray(value.value)) return unknown(copy.type(item.kind), value.derivedFrom)
        if (value.value.length > WORKFLOW_MAX_BATCH) throw new Error(copy.valueLimit)
        if (scope.has(item.item)) throw new Error(copy.binding(item.item))
        const local = new Map(scope), authorities = workflowArrayAuthorities(value), projected: WorkflowValue[] = [], fields: WorkflowCollectionField[] = []
        const sources = new Set(value.derivedFrom), unknownValues: Extract<WorkflowEvaluation, { state: 'unknown' }>[] = []
        let bytes = 2
        for (const [index] of value.value.entries()) {
          local.set(item.item, workflowField(value.value, [String(index)], value.derivedFrom, { collectionFields: authorities.get(String(index)) }))
          const result = yield* evaluate(item.value, local)
          for (const source of result.derivedFrom) if (source !== item.item) sources.add(source)
          if (result.state === 'unknown') unknownValues.push(result)
          else {
            bytes += Buffer.byteLength(JSON.stringify(result.value)) + (projected.length ? 1 : 0)
            if (bytes > WORKFLOW_MAX_VALUE_BYTES) throw new Error(copy.valueLimit)
            projected.push(result.value)
            fields.push(...workflowCollectionFields(result, [String(index)]))
          }
        }
        if (unknownValues.length) return unknown(unknownValues[0].reason, [...sources, ...unknownValues.flatMap(result => result.derivedFrom)])
        return known(projected, [...sources], fields)
      }
    }
  }
  return yield* evaluate(expression)
}

export function evaluateWorkflowExpression(expression: WorkflowExpression, bindings: ReadonlyMap<string, WorkflowEvaluation>): WorkflowEvaluation {
  const steps = workflowExpressionSteps(expression, bindings)
  let step = steps.next()
  while (!step.done) step = steps.next(unknown(copy.type(step.value.expression.kind), step.value.source.derivedFrom))
  return step.value
}

export { workflowExpressionReferences } from '../shared/workflow'
export {
  inferWorkflowExpression,
  workflowBooleanSchema,
  workflowItemsSchema,
  workflowScalarSchema,
  workflowValueSchema
} from './workflow-expression-schema'
