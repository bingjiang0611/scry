import { createHash } from 'node:crypto'
import type { WorkflowControlFrame, WorkflowValueReference } from '../shared/workflow'
import { workflowFrameCopy as copy } from '../shared/constants/copy'

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const phases = ['entered', 'selected', 'completed', 'failed', 'blocked', 'unknown', 'stopped', 'skipped_by_condition']
const terminal = new Set(['completed', 'failed', 'blocked', 'unknown', 'stopped', 'skipped_by_condition'])

export function workflowFrameId(nodeId: string, scopePath: readonly string[]): string {
  if (!id(nodeId)) throw new Error(copy.invalid)
  return scopePath.length ? createHash('sha256').update(JSON.stringify({ nodeId, scopePath })).digest('hex') : nodeId
}

export function validateWorkflowValueReference(value: unknown, workflowId: string): asserts value is WorkflowValueReference {
  if (!object(value) || value.workflowId !== workflowId || !id(value.key) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) || Object.keys(value).some(key => !['workflowId', 'key', 'hash'].includes(key))) throw new Error(copy.reference)
}

export function validateWorkflowFrame(value: unknown, workflowId: string, frameId: string): asserts value is WorkflowControlFrame {
  if (!object(value) || value.schemaVersion !== 1 || value.workflowId !== workflowId || value.frameId !== frameId || !id(value.nodeId) || !id(value.programRevision) || typeof value.inputKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputKey) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.phase !== 'string' || !phases.includes(value.phase)) throw new Error(copy.invalid)
  if (!Array.isArray(value.scopePath) || value.scopePath.length > 64 || !value.scopePath.every(item => typeof item === 'string' && item.length <= 256) || workflowFrameId(value.nodeId, value.scopePath) !== frameId) throw new Error(copy.invalid)
  if (value.arm !== undefined && (typeof value.arm !== 'string' || !['then', 'else', 'unknown'].includes(value.arm))) throw new Error(copy.invalid)
  if ((value.arm === undefined) !== (value.decisionRef === undefined) || (value.phase === 'selected' && value.arm === undefined) || (terminal.has(value.phase) && value.phase !== 'skipped_by_condition' && value.resultRef === undefined)) throw new Error(copy.invalid)
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 4096)) throw new Error(copy.invalid)
  if (value.decisionRef !== undefined) validateWorkflowValueReference(value.decisionRef, workflowId)
  if (value.resultRef !== undefined) validateWorkflowValueReference(value.resultRef, workflowId)
  if (value.sourceRef !== undefined) validateWorkflowValueReference(value.sourceRef, workflowId)
  if (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 || (value.cursor as number) > 4096)) throw new Error(copy.invalid)
  if (value.children !== undefined) {
    if (!Array.isArray(value.children) || value.children.length > 4096 || value.cursor !== value.children.length) throw new Error(copy.invalid)
    for (const child of value.children) {
      if (!object(child) || !id(child.frameId) || !Number.isSafeInteger(child.revision) || (child.revision as number) < 1) throw new Error(copy.invalid)
      validateWorkflowValueReference(child.resultRef, workflowId)
    }
    if (new Set(value.children.map(child => (child as Record<string, unknown>).frameId)).size !== value.children.length) throw new Error(copy.invalid)
  }
}

const sameRef = (a: WorkflowValueReference | undefined, b: WorkflowValueReference | undefined): boolean =>
  a === undefined ? b === undefined : b !== undefined && a.workflowId === b.workflowId && a.key === b.key && a.hash === b.hash

/** Called inside the store's actual lock. CAS includes semantic identity, not
 * only the numeric revision: another input cannot reuse an old branch choice. */
export function nextWorkflowFrame(current: WorkflowControlFrame | undefined, input: Omit<WorkflowControlFrame, 'revision'>, expectedRevision: number): WorkflowControlFrame {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || (current?.revision ?? 0) !== expectedRevision) throw new Error(copy.revision)
  const next = structuredClone({ ...input, revision: expectedRevision + 1 })
  validateWorkflowFrame(next, input.workflowId, input.frameId)
  if (current) {
    if (current.nodeId !== next.nodeId || current.programRevision !== next.programRevision || current.inputKey !== next.inputKey || JSON.stringify(current.scopePath) !== JSON.stringify(next.scopePath)) throw new Error(copy.identity)
    if (terminal.has(current.phase)) throw new Error(copy.terminal)
    if (current.arm !== undefined && (next.phase === 'entered' || current.arm !== next.arm || !sameRef(current.decisionRef, next.decisionRef))) throw new Error(copy.decision)
  }
  return next
}
