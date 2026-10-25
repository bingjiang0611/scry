import { createHash } from 'node:crypto'
import type { WorkflowControlFrame, WorkflowFrameReference, WorkflowLoopCheckpoint, WorkflowValueReference } from '../shared/workflow'
import { workflowFrameCopy as copy, workflowLoopCopy } from '../shared/constants/copy'

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const phases = ['entered', 'selected', 'completed', 'failed', 'blocked', 'unknown', 'stopped', 'skipped_by_condition']
const terminal = new Set(['completed', 'failed', 'blocked', 'unknown', 'stopped', 'skipped_by_condition'])

export function workflowFrameId(nodeId: string, scopePath: readonly string[], generationId?: string): string {
  if (!id(nodeId)) throw new Error(copy.invalid)
  if (generationId !== undefined && !id(generationId)) throw new Error(copy.invalid)
  return scopePath.length || generationId ? createHash('sha256').update(JSON.stringify({ nodeId, scopePath, ...(generationId ? { generationId } : {}) })).digest('hex') : nodeId
}

export function validateWorkflowValueReference(value: unknown, workflowId: string): asserts value is WorkflowValueReference {
  if (!object(value) || value.workflowId !== workflowId || !id(value.key) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash) || Object.keys(value).some(key => !['workflowId', 'key', 'hash'].includes(key))) throw new Error(copy.reference)
}

export function validateWorkflowLoopCheckpoint(value: unknown, workflowId: string): asserts value is WorkflowLoopCheckpoint {
  if (!object(value) || !Number.isSafeInteger(value.iteration) || (value.iteration as number) < 0 || (value.iteration as number) > 1000 || (typeof value.stage !== 'string' || !['ready', 'committed'].includes(value.stage)) || !Number.isSafeInteger(value.noProgress) || (value.noProgress as number) < 0 || (value.noProgress as number) > 1000) throw new Error(workflowLoopCopy.checkpoint)
  for (const field of ['semanticStateRef', 'initialSemanticStateRef', 'invariantSemanticRef'] as const) if (value[field] !== undefined) validateWorkflowValueReference(value[field], workflowId)
  for (const field of ['stateRefs', 'initialStateRefs', 'invariantRefs'] as const) {
    const bindings = value[field]
    if (!object(bindings) || !Object.keys(bindings).length || Object.keys(bindings).length > 4096) throw new Error(workflowLoopCopy.checkpoint)
    for (const [key, reference] of Object.entries(bindings)) { if (!id(key)) throw new Error(workflowLoopCopy.checkpoint); validateWorkflowValueReference(reference, workflowId) }
  }
  if (!Array.isArray(value.history) || value.history.length > 1001 || value.history.some(entry => !object(entry) || !Number.isSafeInteger(entry.iteration) || (entry.iteration as number) < 0 || (entry.iteration as number) > (value.iteration as number) || typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key))) throw new Error(workflowLoopCopy.checkpoint)
  if (!Array.isArray(value.iterations) || value.iterations.length > 1000) throw new Error(workflowLoopCopy.checkpoint)
  for (const reference of value.iterations) validateWorkflowValueReference(reference, workflowId)
  if (!Array.isArray(value.reasons) || value.reasons.length > 8 || new Set(value.reasons).size !== value.reasons.length || value.reasons.some(reason => typeof reason !== 'string' || !['success', 'no_progress', 'oscillation', 'exhausted', 'failed', 'blocked', 'unknown', 'stopped'].includes(reason))) throw new Error(workflowLoopCopy.checkpoint)
  if (value.bestRef !== undefined) validateWorkflowValueReference(value.bestRef, workflowId)
  if (value.outcomeRef !== undefined) validateWorkflowValueReference(value.outcomeRef, workflowId)
}

export function validateWorkflowFrame(value: unknown, workflowId: string, frameId: string): asserts value is WorkflowControlFrame {
  if (!object(value) || value.schemaVersion !== 1 || value.workflowId !== workflowId || value.frameId !== frameId || !id(value.nodeId) || !id(value.programRevision) || typeof value.inputKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputKey) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.phase !== 'string' || !phases.includes(value.phase)) throw new Error(copy.invalid)
  if (!Array.isArray(value.scopePath) || value.scopePath.length > 64 || !value.scopePath.every(item => typeof item === 'string' && item.length <= 256) || workflowFrameId(value.nodeId, value.scopePath, value.generationId as string | undefined) !== frameId) throw new Error(copy.invalid)
  if (value.executionEpoch !== undefined && !id(value.executionEpoch)) throw new Error(copy.invalid)
  if (value.origin !== undefined && (!object(value.origin) || !id(value.origin.frameId) || !Number.isSafeInteger(value.origin.revision) || (value.origin.revision as number) < 1)) throw new Error(copy.invalid)
  if (value.arm !== undefined && (typeof value.arm !== 'string' || !['then', 'else', 'unknown'].includes(value.arm))) throw new Error(copy.invalid)
  if ((value.arm === undefined) !== (value.decisionRef === undefined) || (value.phase === 'selected' && value.arm === undefined) || (terminal.has(value.phase) && value.phase !== 'skipped_by_condition' && value.resultRef === undefined)) throw new Error(copy.invalid)
  if (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 4096)) throw new Error(copy.invalid)
  if (value.decisionRef !== undefined) validateWorkflowValueReference(value.decisionRef, workflowId)
  if (value.resultRef !== undefined) validateWorkflowValueReference(value.resultRef, workflowId)
  if ((value.callInputRef === undefined) !== (value.callInputKey === undefined)) throw new Error(copy.invalid)
  if (value.callInputRef !== undefined) validateWorkflowValueReference(value.callInputRef, workflowId)
  for (const field of ['callInputKey', 'resultSemanticKey', 'sourceSemanticKey', 'decisionSemanticKey'] as const) if (value[field] !== undefined && (typeof value[field] !== 'string' || !/^[a-f0-9]{64}$/.test(value[field]))) throw new Error(copy.invalid)
  if (value.callReuse !== undefined) {
    const source = value.callReuse
    if (!object(source) || !id(source.programRevision) || !id(source.attemptId) || !object(source.reference) || !id(source.reference.frameId) || !Number.isSafeInteger(source.reference.revision) || (source.reference.revision as number) < 1 || value.callInputRef === undefined) throw new Error(copy.invalid)
    validateWorkflowValueReference(source.inputRef, workflowId)
    validateWorkflowValueReference(source.reference.resultRef, workflowId)
  }
  if (value.sourceRef !== undefined) validateWorkflowValueReference(value.sourceRef, workflowId)
  if (value.loop !== undefined) validateWorkflowLoopCheckpoint(value.loop, workflowId)
  if (value.continuation !== undefined && (value.continuation !== 'report_partial' || value.phase !== 'blocked')) throw new Error(copy.invalid)
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

/** Unpublished sequence draft. The caller must checkpoint it before another
 * child, or include it in the immediate terminal parent checkpoint. */
export function workflowSequenceProgress(frame: WorkflowControlFrame | undefined, cursor: number, child: WorkflowFrameReference | undefined): WorkflowControlFrame | undefined {
  if (!frame) return undefined
  if (!child || cursor !== (frame.cursor ?? 0) + 1) throw new Error(copy.invalid)
  return { ...frame, cursor, children: [...(frame.children ?? []), child] }
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
    if (current.nodeId !== next.nodeId || current.executionEpoch !== next.executionEpoch || current.generationId !== next.generationId || JSON.stringify(current.origin) !== JSON.stringify(next.origin) || current.programRevision !== next.programRevision || current.inputKey !== next.inputKey || JSON.stringify(current.scopePath) !== JSON.stringify(next.scopePath)) throw new Error(copy.identity)
    if ((current.sourceSemanticKey !== undefined && current.sourceSemanticKey !== next.sourceSemanticKey) || (current.decisionSemanticKey !== undefined && current.decisionSemanticKey !== next.decisionSemanticKey)) throw new Error(copy.identity)
    if (!sameRef(current.callInputRef, next.callInputRef) || current.callInputKey !== next.callInputKey || (current.callReuse && JSON.stringify(current.callReuse) !== JSON.stringify(next.callReuse)) || (current.resultSemanticKey !== undefined && current.resultSemanticKey !== next.resultSemanticKey)) throw new Error(copy.identity)
    if (terminal.has(current.phase)) throw new Error(copy.terminal)
    if (current.loop) {
      const previous = current.loop, loop = next.loop
      if (!loop ||
        JSON.stringify(previous.invariantRefs) !== JSON.stringify(loop.invariantRefs) ||
        JSON.stringify(previous.initialStateRefs) !== JSON.stringify(loop.initialStateRefs) ||
        (previous.initialSemanticStateRef !== undefined && !sameRef(previous.initialSemanticStateRef, loop.initialSemanticStateRef)) ||
        (previous.invariantSemanticRef !== undefined && !sameRef(previous.invariantSemanticRef, loop.invariantSemanticRef)) ||
        JSON.stringify(Object.keys(previous.stateRefs).sort()) !== JSON.stringify(Object.keys(loop.stateRefs).sort()) ||
        loop.iteration < previous.iteration || loop.iteration > previous.iteration + 1) throw new Error(workflowLoopCopy.checkpoint)
      const stateChanged = JSON.stringify(loop.stateRefs) !== JSON.stringify(previous.stateRefs) || !sameRef(previous.semanticStateRef, loop.semanticStateRef)
      const progressChanged = loop.noProgress !== previous.noProgress ||
        JSON.stringify(loop.history) !== JSON.stringify(previous.history) ||
        JSON.stringify(loop.iterations) !== JSON.stringify(previous.iterations)
      if (loop.iteration === previous.iteration && previous.stage === 'committed' &&
        (loop.stage !== 'committed' || stateChanged || progressChanged)) throw new Error(workflowLoopCopy.checkpoint)
      if (loop.iteration > previous.iteration &&
        (loop.stage !== 'ready' || previous.reasons.length > 0 || (previous.stage !== 'committed' && previous.iteration !== 0) || stateChanged || progressChanged)) throw new Error(workflowLoopCopy.checkpoint)
    }
    if (current.arm !== undefined && (next.phase === 'entered' || current.arm !== next.arm || !sameRef(current.decisionRef, next.decisionRef))) throw new Error(copy.decision)
  }
  return next
}
