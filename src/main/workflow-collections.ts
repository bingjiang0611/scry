import type { WorkflowCollectionEntry, WorkflowCollectionReference, WorkflowValue, WorkflowValueSchema } from '../shared/workflow'
import { WORKFLOW_MAX_BATCH } from '../shared/workflow'
import { workflowCollectionCopy as copy } from '../shared/constants/copy'
import { validateWorkflowValueReference } from './workflow-frames'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const scalar = (value: unknown): boolean => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))

export function collectionDescriptor(value: WorkflowCollectionReference): WorkflowValue {
  return { kind: 'workflow_collection', reference: { ...value.reference }, count: value.count, sealed: value.sealed }
}
export function validateCollectionReference(value: unknown, workflowId: string): asserts value is WorkflowCollectionReference {
  if (!object(value) || !Number.isSafeInteger(value.count) || (value.count as number) < 0 || (value.count as number) > WORKFLOW_MAX_BATCH || typeof value.sealed !== 'boolean' || Object.keys(value).some(key => !['reference', 'count', 'sealed'].includes(key))) throw new Error(copy.invalid)
  validateWorkflowValueReference(value.reference, workflowId)
}
export function collectionEntries(value: unknown, workflowId: string, count: number, sealed: boolean): WorkflowCollectionEntry[] {
  if (!object(value) || value.schemaVersion !== 1 || value.sealed !== sealed || !Array.isArray(value.entries) || value.entries.length !== count || count > WORKFLOW_MAX_BATCH) throw new Error(copy.invalid)
  for (const [index, entry] of value.entries.entries()) {
    if (!object(entry) || !scalar(entry.key) || entry.index !== index || (typeof entry.state !== 'string' || !['pending', 'completed', 'failed', 'blocked', 'unknown', 'stopped'].includes(entry.state)) || typeof entry.settled !== 'boolean' || Object.keys(entry).some(key => !['key', 'index', 'state', 'settled', 'reference', 'error'].includes(key))) throw new Error(copy.invalid)
    if (entry.error !== undefined && (typeof entry.error !== 'string' || entry.error.length > 4096)) throw new Error(copy.invalid)
    if (entry.reference !== undefined) {
      if (!object(entry.reference) || typeof entry.reference.frameId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(entry.reference.frameId) || !Number.isSafeInteger(entry.reference.revision) || (entry.reference.revision as number) < 1) throw new Error(copy.invalid)
      validateWorkflowValueReference(entry.reference.resultRef, workflowId)
    }
    if (entry.state === 'completed' && (!entry.reference || !entry.settled)) throw new Error(copy.invalid)
    if (sealed && (entry.state === 'pending' || entry.state === 'unknown' || !entry.settled)) throw new Error(copy.unsealed)
  }
  if (new Set(value.entries.map(entry => JSON.stringify((entry as Record<string, WorkflowValue>).key))).size !== value.entries.length) throw new Error(copy.key)
  return value.entries as WorkflowCollectionEntry[]
}
export function collectionItemSchema(value: WorkflowValueSchema): WorkflowValueSchema {
  return { type: 'object', properties: { key: { type: 'union', variants: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }, index: { type: 'number' },
    state: { type: 'enum', values: ['pending', 'completed', 'failed', 'blocked', 'unknown', 'stopped'] }, settled: { type: 'boolean' }, value, error: { type: 'string' }
  }, required: ['key', 'index', 'state', 'settled'] }
}
