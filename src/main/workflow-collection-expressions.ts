import { createHash } from 'node:crypto'
import { WORKFLOW_MAX_VALUE_BYTES, type WorkflowCollectionEntry, type WorkflowCollectionField, type WorkflowEvaluation, type WorkflowScalar, type WorkflowValue } from '../shared/workflow'
import { workflowCollectionCopy, workflowExpressionCopy } from '../shared/constants/copy'
import type { WorkflowControl } from './workflow-control'
import { assertWorkflowValue, workflowCollectionFields, workflowField, workflowValueKey, type WorkflowCollectionExpressionRequest } from './workflow-expressions'

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const known = (value: WorkflowValue, derivedFrom: string[], fields: WorkflowCollectionField[] = []): Extract<WorkflowEvaluation, { state: 'known' }> => {
  assertWorkflowValue(value)
  return { state: 'known', value, derivedFrom, ...(fields.length ? { collectionFields: fields } : {}) }
}

/** Only the canonical control owner can resolve these requests. Read one item
 * payload at a time; derived rows are immutable data, not new effect receipts. */
export async function evaluateWorkflowCollection(control: WorkflowControl, request: WorkflowCollectionExpressionRequest,
  identity: string, scopePath: string[], stopped: () => boolean): Promise<WorkflowEvaluation> {
  const { expression, source } = request
  const unavailable = (reason: string): WorkflowEvaluation => ({ state: 'unknown', reason, derivedFrom: source.derivedFrom })
  if (!source.collection.sealed) return unavailable(workflowCollectionCopy.unsealed)
  const entries = await control.entries(source)
  const fields: WorkflowCollectionField[] = []
  if (expression.kind === 'group' || expression.kind === 'unique') {
    const groups = new Map<string, { key: WorkflowScalar; members: WorkflowCollectionEntry[]; derivedFrom: number[] }>()
    let keyBytes = 0
    for (const entry of entries) {
      if (stopped()) return unavailable(workflowCollectionCopy.stopped)
      const member = await control.entryValue(entry)
      const key = workflowField(member.value, expression.key, source.derivedFrom, member)
      if (key.state === 'unknown') return key
      if (key.value !== null && typeof key.value !== 'string' && typeof key.value !== 'number' && typeof key.value !== 'boolean') return unavailable(workflowExpressionCopy.key)
      const stable = workflowValueKey(key.value)
      let group = groups.get(stable)
      if (!group) {
        // Host payloads can exceed one JSON value in aggregate. Bound retained
        // grouping keys before accumulating them, not just at final serialization.
        keyBytes += Buffer.byteLength(stable, 'utf8')
        if (keyBytes > WORKFLOW_MAX_VALUE_BYTES) throw new Error(workflowExpressionCopy.valueLimit)
        group = { key: key.value, members: [], derivedFrom: [] }
      }
      group.members.push({ ...entry, index: group.members.length })
      group.derivedFrom.push(entry.index)
      groups.set(stable, group)
    }
    const result: WorkflowValue[] = []
    for (const group of groups.values()) {
      if (stopped()) return unavailable(workflowCollectionCopy.stopped)
      const members = await control.collection({ frameId: digest([identity, 'group', result.length]) }, group.members, true)
      fields.push(...workflowCollectionFields(members, [String(result.length), 'members']))
      result.push({ key: group.key, members: members.value, derivedFrom: group.derivedFrom })
    }
    return known(result, source.derivedFrom, fields)
  }
  if (request.bindings.has(expression.item)) throw new Error(workflowExpressionCopy.binding(expression.item))
  const partitions: Record<'matched' | 'rejected' | 'unknown', WorkflowCollectionEntry[]> = { matched: [], rejected: [], unknown: [] }
  const sources = new Set(source.derivedFrom)
  for (const entry of entries) {
    if (stopped()) return unavailable(workflowCollectionCopy.stopped)
    const member = await control.entryValue(entry)
    const bindings = new Map(request.bindings).set(expression.item, member)
    const decision = await control.evaluate(expression.when, { path: scopePath, bindings }, identity + ':predicate:' + entry.index, stopped)
    const localSources = new Set([...member.derivedFrom, expression.item])
    for (const ref of decision.derivedFrom) if (!localSources.has(ref)) sources.add(ref)
    const reason = decision.state === 'unknown' ? decision.reason : typeof decision.value !== 'boolean' ? workflowExpressionCopy.type(expression.kind)
      : decision.value ? workflowExpressionCopy.trueReason : workflowExpressionCopy.falseReason
    const bucket = decision.state === 'known' && typeof decision.value === 'boolean' ? decision.value ? 'matched' : 'rejected' : 'unknown'
    const row = known({ index: entry.index, value: member.value, reason },
      [...new Set([...member.derivedFrom, ...decision.derivedFrom.filter(ref => ref !== expression.item)])], workflowCollectionFields(member, ['value']))
    const valueRef = await control.saveCollectionValue(row)
    // Preserve the original outcome state/settlement and key. Predicate unknown
    // is an explicit bucket, never a fabricated unknown native effect.
    partitions[bucket].push({ key: entry.key, index: partitions[bucket].length, state: entry.state, settled: entry.settled,
      valueRef, ...(entry.error === undefined ? {} : { error: entry.error }) })
  }
  const result: Record<string, WorkflowValue> = {}
  for (const bucket of ['matched', 'rejected', 'unknown'] as const) {
    if (stopped()) return unavailable(workflowCollectionCopy.stopped)
    const members = await control.collection({ frameId: digest([identity, bucket]) }, partitions[bucket], true)
    result[bucket] = members.value
    fields.push(...workflowCollectionFields(members, [bucket]))
  }
  return known(result, [...sources], fields)
}
