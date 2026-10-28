import { createHash } from 'node:crypto'

import { workflowFrameCopy } from '../shared/constants/copy'
import { workflowTemplateEditCopy } from '../shared/constants/workflow-template-edit-copy'
import { parseWorkflowTemplateEditTarget } from '../shared/workflow-route'

import { assertWorkflowValue, workflowField } from './workflow-expressions'

import { collectionDescriptor, validateCollectionReference } from './workflow-collections'
import type { WorkflowEvaluation, WorkflowValueReference } from '../shared/workflow'
import { WORKFLOW_MAX_BATCH, WORKFLOW_MAX_VALUE_DEPTH } from '../shared/workflow'
import { validateWorkflowReplicaReference } from './workflow-replica'

import type { WorkflowPlanningIntent, WorkflowStore } from './workflow-store-contracts'

export function validatePlanningRoute(intent: WorkflowPlanningIntent): void {
  if (intent.route !== undefined && intent.route !== 'direct' && intent.route !== 'clarification' && intent.route !== 'workflow' && intent.route !== 'template_edit') throw new Error(workflowTemplateEditCopy.damagedRoute)
  if (intent.routeQuestion !== undefined && (intent.route !== 'clarification' || typeof intent.routeQuestion !== 'string' || intent.routeQuestion.length === 0 || intent.routeQuestion.length > 2000)) throw new Error(workflowTemplateEditCopy.damagedQuestion)
  if (intent.routeTarget !== undefined) {
    if (intent.route !== 'template_edit') throw new Error(workflowTemplateEditCopy.damagedTarget)
    intent.routeTarget = parseWorkflowTemplateEditTarget(intent.routeTarget)
  }
}

export const fileSafe = (id: string): string => {
  if (!/^[A-Za-z0-9_-]{1,96}$/.test(id)) throw new Error('工作流记录身份无效')
  return id
}
export const absent = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
export const MAX_RECORD_BYTES = 8 * 1024 * 1024
export const frameName = (id: string, frameId: string): string => `${fileSafe(id)}.${fileSafe(frameId)}.frame.json`
export const valueName = (reference: WorkflowValueReference): string => `${fileSafe(reference.workflowId)}.${createHash('sha256').update(fileSafe(reference.key)).digest('hex')}.${reference.hash}.value.json`
export const collectionName = (reference: WorkflowValueReference): string => valueName(reference).replace(/\.value\.json$/, '.collection.json')
export function validateEvaluation(value: unknown, workflowId: string): asserts value is WorkflowEvaluation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(workflowFrameCopy.invalid)
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.derivedFrom) || !input.derivedFrom.every(item => typeof item === 'string' && item.length <= 512)) throw new Error(workflowFrameCopy.invalid)
  const allowed = input.state === 'known' ? ['state', 'value', 'derivedFrom', 'collection', 'collectionFields', 'replica'] : ['state', 'reason', 'derivedFrom']
  if (Object.keys(input).some(key => !allowed.includes(key)) || (input.state === 'known' ? !Object.hasOwn(input, 'value') : input.state !== 'unknown' || typeof input.reason !== 'string' || !input.reason || input.reason.length > 4096)) throw new Error(workflowFrameCopy.invalid)
  if (input.state === 'known') {
    assertWorkflowValue(input.value)
    if (input.replica !== undefined) {
      validateWorkflowReplicaReference(input.replica, workflowId)
      if (JSON.stringify(input.replica) !== JSON.stringify(input.value)) throw new Error(workflowFrameCopy.invalid)
    }
    if (input.collection !== undefined) {
      validateCollectionReference(input.collection, workflowId)
      if (JSON.stringify(input.value) !== JSON.stringify(collectionDescriptor(input.collection))) throw new Error(workflowFrameCopy.invalid)
    }
    if (input.collectionFields !== undefined) {
      if (!Array.isArray(input.collectionFields) || !input.collectionFields.length || input.collectionFields.length > WORKFLOW_MAX_BATCH || input.collection) throw new Error(workflowFrameCopy.invalid)
      const paths = new Set<string>()
      let bytes = 0
      for (const field of input.collectionFields) {
        if (!field || typeof field !== 'object' || Object.keys(field).some(key => !['path', 'collection'].includes(key)) || !Array.isArray(field.path) || !field.path.length || field.path.length > WORKFLOW_MAX_VALUE_DEPTH || !field.path.every((part: unknown) => typeof part === 'string' && part.length <= 512)) throw new Error(workflowFrameCopy.invalid)
        bytes += Buffer.byteLength(JSON.stringify(field))
        if (bytes > MAX_RECORD_BYTES) throw new Error(workflowFrameCopy.invalid)
        const key = JSON.stringify(field.path)
        if (paths.has(key)) throw new Error(workflowFrameCopy.invalid)
        paths.add(key)
        validateCollectionReference(field.collection, workflowId)
        const selected = workflowField(input.value, field.path)
        if (selected.state !== 'known' || JSON.stringify(selected.value) !== JSON.stringify(collectionDescriptor(field.collection))) throw new Error(workflowFrameCopy.invalid)
      }
    }
  }
}

/** A descriptor's count is not evidence that its manifest is still durable.
 * Verify nested manifests before exposing their authority; item payloads stay
 * lazy. Deduplicate within this read, never cache absence checks across reads. */
export async function validateCollectionArtifacts(store: Pick<WorkflowStore, 'loadCollection'>, workflowId: string, value: WorkflowEvaluation): Promise<void> {
  if (value.state !== 'known') return
  const collections = [...(value.collection ? [value.collection] : []), ...(value.collectionFields ?? []).map(field => field.collection)]
  const seen = new Set<string>()
  for (const collection of collections) {
    const key = JSON.stringify([collection.reference.key, collection.reference.hash, collection.count, collection.sealed])
    if (seen.has(key)) continue
    seen.add(key)
    await store.loadCollection(workflowId, collection)
  }
}
