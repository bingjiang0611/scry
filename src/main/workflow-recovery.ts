import { sameWorkflowPlanningSize, validateWorkflowPlanningSize } from '../shared/workflow-size'
import { workflowSizeCopy } from '../shared/constants/copy'
import { createHash } from 'node:crypto'
import type { WorkflowStore, WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_ATTEMPTS, workflowChildBlocks, type WorkflowBlock, type WorkflowPlanPreview } from '../shared/workflow'
import { workflowRecoveryCopy as copy } from '../shared/constants/copy'
import { validateWorkflowProgram, workflowRevision } from './workflow-program'
import { validateWorkflowReplicaReference } from './workflow-replica'
import { assertWorkflowSystemsSettled } from './workflow-system-ledger'
import { validateWorkflowRevisions, governingWorkflowPreview, assertWorkflowRevisionChange } from './workflow-revisions'
import { assertWorkflowRetryTarget, validateWorkflowAttemptChains, validateWorkflowRestartTarget, validateWorkflowRetryTarget } from './workflow-retry'
import { validateWorkflowClassifierOutcome } from '../shared/workflow-classifier'
import { validateWorkflowValueReference } from './workflow-frames'

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
export const workflowRecordFingerprint = (value: WorkflowStoreRecord | undefined): string | undefined => value === undefined ? undefined : createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** A revision/continuation inherits main's original snapshot, not today's settings. */
export function workflowContinuationPreview(preview: WorkflowPlanPreview, original: WorkflowPlanPreview): WorkflowPlanPreview {
  if (preview.planningSize !== undefined && !sameWorkflowPlanningSize(original.planningSize, preview.planningSize)) throw new Error(workflowSizeCopy.immutable)
  return original.planningSize ? { ...preview, planningSize: original.planningSize } : preview
}

export function validateWorkflowOwnership(record: WorkflowStoreRecord): void {
  if (record.planningRequestHash !== undefined && (typeof record.planningRequestHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.planningRequestHash))) throw new Error(copy.fingerprint)
  const execution = record.execution
  if (record.preview.planningSize !== undefined) validateWorkflowPlanningSize(record.preview.planningSize)
  if (record.progress.planningSize !== undefined) {
    validateWorkflowPlanningSize(record.progress.planningSize)
    if (!sameWorkflowPlanningSize(record.preview.planningSize, record.progress.planningSize)) throw new Error(workflowSizeCopy.invalidSnapshot)
  }
  validateWorkflowRevisions(record)
  for (const revision of record.revisions ?? []) if (!sameWorkflowPlanningSize(record.preview.planningSize, revision.preview.planningSize)) throw new Error(workflowSizeCopy.immutable)
  for (const intent of record.intents) if ((intent.frameId !== undefined && !id(intent.frameId)) || (intent.callFrameId !== undefined && !id(intent.callFrameId))) throw new Error(copy.ledger)
  for (const intent of record.systemIntents ?? []) if (intent.frameId !== undefined && !id(intent.frameId)) throw new Error(copy.ledger)
  if (!execution) return
  if (execution.version !== 2 || !id(execution.epoch) || !execution.owner || !Number.isSafeInteger(execution.owner.pid) || execution.owner.pid < 1 || !id(execution.owner.instanceId) || !['active', 'closed'].includes(execution.owner.state) || !Array.isArray(execution.segments) || !execution.segments.length || execution.segments.length > 256) throw new Error(copy.ledger)
  for (const [index, segment] of execution.segments.entries()) {
    if (!segment || !id(segment.id) || !Number.isFinite(segment.createdAt) || (index === 0 ? segment.mode !== 'start' || segment.generationId !== undefined || segment.commandId !== undefined : !['continue', 'retry', 'restart', 'revision'].includes(segment.mode) || segment.generationId !== segment.id || !id(segment.commandId))) throw new Error(copy.ledger)
    if (segment.mode === 'revision' ? !Number.isSafeInteger(segment.expectedRevision) || segment.expectedRevision! < 1 : segment.expectedRevision !== undefined) throw new Error(copy.ledger)
    if (segment.mode === 'retry') validateWorkflowRetryTarget(segment.retry)
    else if (segment.mode === 'restart') {
      if (!segment.restart || !['stalled', 'reply_lost'].includes(segment.restart.reason) || !Number.isSafeInteger(segment.restart.expectedRevision) || segment.restart.expectedRevision < 1) throw new Error(copy.ledger)
      validateWorkflowRestartTarget({ taskId: segment.restart.taskId, attemptId: segment.restart.attemptId, expectedRevision: segment.restart.expectedRevision })
    } else if (segment.retry !== undefined || segment.restart !== undefined) throw new Error(copy.ledger)
  }
  const commands = execution.segments.slice(1).map(segment => segment.commandId)
  if (new Set(commands).size !== commands.length) throw new Error(copy.ledger)
  if (execution.segments.at(-1)!.id !== execution.epoch || new Set(execution.segments.map(segment => segment.id)).size !== execution.segments.length) throw new Error(copy.ledger)
}

export function validateWorkflowClassifierLedger(record: WorkflowStoreRecord, requireOutcomes = false): void {
  const intents = record.classifierIntents ?? [], outcomes = record.classifierOutcomes ?? []
  const blocks = new Map<string, Extract<WorkflowBlock, { kind: 'classifier' }>>()
  const pending = [record.preview.program.body]
  while (pending.length) {
    const block = pending.pop()!
    if (block.kind === 'classifier') blocks.set(block.blockId, block)
    pending.push(...workflowChildBlocks(block))
  }
  if (new Set(intents.map(intent => intent.classifierId)).size !== intents.length || new Set(outcomes.map(outcome => outcome.classifierId)).size !== outcomes.length) throw new Error(copy.ledger)
  const byId = new Map(intents.map(intent => [intent.classifierId, intent]))
  for (const intent of intents) {
    const block = blocks.get(intent.nodeId)
    if (!block || intent.classifierId.length > 512 || intent.workflowId !== record.preview.workflowId || intent.programRevision !== record.preview.programRevision || intent.frame.frameId.length > 96 || intent.frame.resultRef.workflowId !== record.preview.workflowId || intent.inputRefs.length !== intent.inputs.length) throw new Error(copy.ledger)
    validateWorkflowValueReference(intent.frame.resultRef, record.preview.workflowId)
    for (const [index, input] of intent.inputs.entries()) {
      const ref = intent.inputRefs[index]
      if (!ref || input.nodeId !== ref.nodeId || JSON.stringify(input.path) !== JSON.stringify(ref.path ?? [])) throw new Error(copy.ledger)
      validateWorkflowValueReference(input.valueRef, record.preview.workflowId)
      if (!input.value || typeof input.value !== 'object' || !Array.isArray(input.value.derivedFrom)) throw new Error(copy.ledger)
    }
  }
  for (const outcome of outcomes) {
    const intent = byId.get(outcome.classifierId)
    if (!intent) throw new Error(copy.ledger)
    validateWorkflowClassifierOutcome(intent, outcome)
    if (outcome.resultRef) validateWorkflowValueReference(outcome.resultRef, record.preview.workflowId)
  }
  if (requireOutcomes && intents.some(intent => !outcomes.some(outcome => outcome.classifierId === intent.classifierId))) throw new Error(copy.ledger)
}

/** Validate the immutable classifier artifacts, not only the root ledger JSON. */
export async function validateWorkflowClassifierLedgerCanonical(record: WorkflowStoreRecord, store: WorkflowStore, requireCompletedResultRef = true): Promise<void> {
  validateWorkflowClassifierLedger(record)
  const blocks = new Map<string, Extract<WorkflowBlock, { kind: 'classifier' }>>()
  const pending = [record.preview.program.body]
  while (pending.length) {
    const block = pending.pop()!
    if (block.kind === 'classifier') blocks.set(block.blockId, block)
    pending.push(...workflowChildBlocks(block))
  }
  for (const intent of record.classifierIntents ?? []) {
    const block = blocks.get(intent.nodeId)
    if (!block || intent.prompt !== block.prompt || intent.criteria !== block.criteria || intent.kind !== block.classifier || JSON.stringify(intent.threshold) !== JSON.stringify(block.threshold) ||
      JSON.stringify(intent.choices) !== JSON.stringify(block.choices) || JSON.stringify(intent.score) !== JSON.stringify(block.score) || JSON.stringify(intent.inputRefs) !== JSON.stringify(block.inputRefs ?? [])) throw new Error(copy.ledger)
    const frame = await store.loadFrame(record.preview.workflowId, intent.frame.frameId)
    if (!frame || frame.workflowId !== record.preview.workflowId || frame.programRevision !== record.preview.programRevision || frame.nodeId !== intent.nodeId || frame.frameId !== intent.frame.frameId || frame.revision < intent.frame.revision) throw new Error(copy.ledger)
    const checkpoint = await store.loadValue(record.preview.workflowId, intent.frame.resultRef)
    const expectedInputs = intent.inputs.map(input => ({ nodeId: input.nodeId, path: [...input.path], valueRef: input.valueRef, value: input.value }))
    if (JSON.stringify(checkpoint) !== JSON.stringify({ state: 'known', value: { kind: 'classifier_intent', classifierId: intent.classifierId, inputs: expectedInputs }, derivedFrom: intent.inputs.map(input => `value:${input.valueRef.key}:${input.valueRef.hash}`) })) throw new Error(copy.ledger)
    for (const input of intent.inputs) {
      const canonical = await store.loadValue(record.preview.workflowId, input.valueRef)
      if (JSON.stringify(canonical) !== JSON.stringify(input.value)) throw new Error(copy.ledger)
    }
    const outcome = (record.classifierOutcomes ?? []).find(value => value.classifierId === intent.classifierId)
    if (outcome?.state === 'completed') {
      if (!outcome.resultRef || !frame.resultRef || JSON.stringify(outcome.resultRef) !== JSON.stringify(frame.resultRef)) {
        if (requireCompletedResultRef) throw new Error(copy.ledger)
        continue
      }
      const result = await store.loadValue(record.preview.workflowId, outcome.resultRef)
      const resultValue = result.state === 'known' && result.value && typeof result.value === 'object' && !Array.isArray(result.value) ? result.value as Record<string, unknown> : undefined
      if (!resultValue || resultValue.kind !== 'classifier_result' ||
        JSON.stringify(resultValue.value) !== JSON.stringify(outcome.value) || resultValue.confidence !== outcome.confidence || JSON.stringify(resultValue.probability) !== JSON.stringify(outcome.probability) ||
        JSON.stringify(result.derivedFrom) !== JSON.stringify([`classifier:${intent.classifierId}`])) throw new Error(copy.ledger)
    } else if (outcome?.resultRef) {
      await store.loadValue(record.preview.workflowId, outcome.resultRef)
    }
  }
}

/** Admission evidence, not a retry policy. A settled unknown result is still
 * unknown business state and is never replayed. PID reuse fails closed (alive). */
export function assertWorkflowRecovery(record: WorkflowStoreRecord, instanceId: string, allowSettledUnknownAttempt?: string): void {
  validateWorkflowOwnership(record)
  validateWorkflowClassifierLedger(record, true)
  if (!record.execution) throw new Error(copy.legacy)
  const { programRevision, ...program } = validateWorkflowProgram(record.preview.program)
  if (programRevision !== workflowRevision(program) || programRevision !== record.preview.programRevision || record.preview.workflowId !== program.workflowId || record.preview.workspace !== program.workspace) throw new Error(copy.fingerprint)
  if (!Number.isSafeInteger(record.progress.dispatchAttempts) || record.progress.dispatchAttempts !== record.intents.length || record.progress.dispatchAttempts > WORKFLOW_MAX_ATTEMPTS ||
    new Set(record.intents.map(intent => intent.attemptId)).size !== record.intents.length ||
    new Set(record.outcomes.map(outcome => outcome.attemptId)).size !== record.outcomes.length) throw new Error(copy.ledger)
  validateWorkflowAttemptChains(record)
  assertWorkflowSystemsSettled(record)
  const callsFor = (preview: WorkflowStoreRecord['preview']) => {
    const calls = new Map<string, Extract<WorkflowBlock, { kind: 'call' }>>()
    const pending = [preview.program.body]
    while (pending.length) {
      const block = pending.pop()!
      if (block.kind === 'call') calls.set(block.blockId, block)
      else pending.push(...workflowChildBlocks(block))
    }
    return calls
  }
  const replicas = new Set((record.systemOutcomes ?? []).flatMap(outcome => outcome.replica ? [JSON.stringify(outcome.replica)] : []))
  for (const [index, outcome] of record.outcomes.entries()) {
    const governing = governingWorkflowPreview(record, 'outcome', index)
    const call = callsFor(governing).get(outcome.nodeId), role = governing.program.roles.find(value => value.role === call?.role)
    const task = outcome.taskId.split(':')
    if (!role || outcome.role !== role.role || outcome.providerId !== role.providerId || JSON.stringify(outcome.requestedModel) !== JSON.stringify(role.requestedModel) || task.length !== 3 || task[0] !== program.workflowId || !/^[a-f0-9]{64}$/.test(task[1]) || task[2] !== outcome.nodeId) throw new Error(copy.ledger)
    if (!record.intents.some(intent => intent.attemptId === outcome.attemptId) && (outcome.state === 'completed' || outcome.runId || outcome.archiveRef || outcome.outputRef || outcome.output !== undefined)) throw new Error(copy.ledger)
  }
  const restartedAttempts = new Set((record.execution?.segments ?? []).filter(segment => segment.mode === 'restart' && segment.restart?.reason !== undefined).map(segment => segment.restart?.attemptId).filter((value): value is string => Boolean(value)))
  for (const [index, intent] of record.intents.entries()) {
    if ((intent.frameId !== undefined && !id(intent.frameId)) || (intent.callFrameId !== undefined && !id(intent.callFrameId))) throw new Error(copy.ledger)
    const governing = governingWorkflowPreview(record, 'intent', index)
    const outcome = record.outcomes.find(value => value.attemptId === intent.attemptId)
    if (!outcome || !outcome.settled || (outcome.state === 'unknown' && !restartedAttempts.has(outcome.attemptId) && outcome.attemptId !== allowSettledUnknownAttempt)) throw new Error(copy.unknown)
    if (intent.replica) {
      validateWorkflowReplicaReference(intent.replica, program.workflowId)
      if (!callsFor(governing).get(outcome.nodeId)?.replica || !replicas.has(JSON.stringify(intent.replica))) throw new Error(copy.ledger)
    }
    if (intent.workflowId !== program.workflowId || intent.programRevision !== governing.programRevision || outcome.taskId !== intent.taskId || outcome.role !== intent.role || outcome.providerId !== intent.providerId) throw new Error(copy.ledger)
  }
  if (record.outcomes.some(outcome => !outcome.settled || (outcome.state === 'unknown' && !restartedAttempts.has(outcome.attemptId) && outcome.attemptId !== allowSettledUnknownAttempt))) throw new Error(copy.unknown)
  const owner = record.execution.owner
  if (owner.state === 'active' && owner.instanceId !== instanceId) {
    try { process.kill(owner.pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw new Error(copy.owner, { cause: error })
    }
    throw new Error(copy.owner)
  }
}

export function validateWorkflowClaim(current: WorkflowStoreRecord | undefined, next: WorkflowStoreRecord): void {
  validateWorkflowOwnership(next)
  if (current && current.planningRequestHash !== next.planningRequestHash) throw new Error(copy.fingerprint)
  if (current && !sameWorkflowPlanningSize(current.preview.planningSize, next.preview.planningSize)) throw new Error(workflowSizeCopy.immutable)
  if (!next.execution || next.execution.owner.state !== 'active') throw new Error(copy.ledger)
  if (!current?.execution) {
    if (current && (current.executionStarted !== undefined || current.intents.length || current.outcomes.length)) throw new Error(copy.legacy)
    return
  }
  const nextSegment = next.execution.segments.at(-1)
  assertWorkflowRecovery(current, next.execution.owner.instanceId, nextSegment?.mode === 'restart' ? nextSegment.restart?.attemptId : undefined)
  const segments = next.execution.segments
  const revision = segments.at(-1)?.mode === 'revision'
  if (revision) {
    assertWorkflowRevisionChange(current, next.preview, { expectedRevision: segments.at(-1)!.expectedRevision! })
    const history = next.revisions!
    const old = current.revisions ?? [{ preview: current.preview, segmentId: current.execution.segments[0].id, intentOffset: 0, outcomeOffset: 0, reuse: [] }]
    if (history.at(-1)!.segmentId !== next.execution.epoch || history.length !== old.length + 1 || JSON.stringify(history.slice(0, -1)) !== JSON.stringify(old) ||
      history.at(-1)!.intentOffset !== current.intents.length || history.at(-1)!.outcomeOffset !== current.outcomes.length ||
      history.at(-1)!.systemIntentOffset !== (current.systemIntents?.length ?? 0) || history.at(-1)!.systemOutcomeOffset !== (current.systemOutcomes?.length ?? 0)) throw new Error(copy.ledger)
  } else if (JSON.stringify(next.revisions) !== JSON.stringify(current.revisions)) throw new Error(copy.ledger)
  if (segments.at(-1)?.mode === 'retry') assertWorkflowRetryTarget(current, segments.at(-1)!.retry!)
  if (next.execution.epoch === current.execution.epoch || segments.length !== current.execution.segments.length + 1 ||
    JSON.stringify(segments.slice(0, -1)) !== JSON.stringify(current.execution.segments) ||
    (!revision && JSON.stringify(next.preview.program) !== JSON.stringify(current.preview.program)) ||
    next.progress.dispatchAttempts !== current.progress.dispatchAttempts ||
    JSON.stringify(next.intents) !== JSON.stringify(current.intents) || JSON.stringify(next.outcomes) !== JSON.stringify(current.outcomes) ||
    JSON.stringify(next.classifierIntents) !== JSON.stringify(current.classifierIntents) || JSON.stringify(next.classifierOutcomes) !== JSON.stringify(current.classifierOutcomes) ||
    JSON.stringify(next.agentInputs) !== JSON.stringify(current.agentInputs) ||
    JSON.stringify(next.systemIntents) !== JSON.stringify(current.systemIntents) || JSON.stringify(next.systemOutcomes) !== JSON.stringify(current.systemOutcomes)) throw new Error(copy.ledger)
}

export function workflowEpochMatches(current: WorkflowStoreRecord | undefined, next: WorkflowStoreRecord): void {
  if (current && current.planningRequestHash !== next.planningRequestHash) throw new Error(copy.fingerprint)
  if (current?.execution?.epoch !== next.execution?.epoch) throw new Error(copy.stale)
  if (current && !sameWorkflowPlanningSize(current.preview.planningSize, next.preview.planningSize)) throw new Error(workflowSizeCopy.immutable)
  for (const [attemptId, inputs] of Object.entries(current?.agentInputs ?? {})) {
    const following = next.agentInputs?.[attemptId]
    if (JSON.stringify(inputs.before) !== JSON.stringify(following?.before) || (inputs.after !== undefined && JSON.stringify(inputs.after) !== JSON.stringify(following?.after))) throw new Error(copy.fingerprint)
  }
  if (current?.execution && ((current.revisions !== next.revisions && JSON.stringify(current.revisions) !== JSON.stringify(next.revisions)) || (current.preview.program !== next.preview.program && JSON.stringify(current.preview.program) !== JSON.stringify(next.preview.program)) )) throw new Error(copy.fingerprint)
}
