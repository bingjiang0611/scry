import { createHash } from 'node:crypto'
import type { WorkflowStoreRecord } from './workflow-store'
import { WORKFLOW_MAX_ATTEMPTS, workflowChildBlocks, type WorkflowBlock } from '../shared/workflow'
import { workflowRecoveryCopy as copy } from '../shared/constants/copy'
import { validateWorkflowProgram, workflowRevision } from './workflow-program'
import { validateWorkflowReplicaReference } from './workflow-replica'
import { assertWorkflowSystemsSettled } from './workflow-system-ledger'
import { validateWorkflowRevisions, governingWorkflowPreview, assertWorkflowRevisionChange } from './workflow-revisions'
import { assertWorkflowRetryTarget, validateWorkflowAttemptChains, validateWorkflowRetryTarget } from './workflow-retry'

const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)
export const workflowRecordFingerprint = (value: WorkflowStoreRecord | undefined): string | undefined => value === undefined ? undefined : createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function validateWorkflowOwnership(record: WorkflowStoreRecord): void {
  const execution = record.execution
  validateWorkflowRevisions(record)
  if (!execution) return
  if (execution.version !== 2 || !id(execution.epoch) || !execution.owner || !Number.isSafeInteger(execution.owner.pid) || execution.owner.pid < 1 || !id(execution.owner.instanceId) || !['active', 'closed'].includes(execution.owner.state) || !Array.isArray(execution.segments) || !execution.segments.length || execution.segments.length > 256) throw new Error(copy.ledger)
  for (const [index, segment] of execution.segments.entries()) {
    if (!segment || !id(segment.id) || !Number.isFinite(segment.createdAt) || (index === 0 ? segment.mode !== 'start' || segment.generationId !== undefined || segment.commandId !== undefined : !['continue', 'retry', 'revision'].includes(segment.mode) || segment.generationId !== segment.id || !id(segment.commandId))) throw new Error(copy.ledger)
    if (segment.mode === 'revision' ? !Number.isSafeInteger(segment.expectedRevision) || segment.expectedRevision! < 1 : segment.expectedRevision !== undefined) throw new Error(copy.ledger)
    if (segment.mode === 'retry') validateWorkflowRetryTarget(segment.retry)
    else if (segment.retry !== undefined) throw new Error(copy.ledger)
  }
  const commands = execution.segments.slice(1).map(segment => segment.commandId)
  if (new Set(commands).size !== commands.length) throw new Error(copy.ledger)
  if (execution.segments.at(-1)!.id !== execution.epoch || new Set(execution.segments.map(segment => segment.id)).size !== execution.segments.length) throw new Error(copy.ledger)
}

/** Admission evidence, not a retry policy. A settled unknown result is still
 * unknown business state and is never replayed. PID reuse fails closed (alive). */
export function assertWorkflowRecovery(record: WorkflowStoreRecord, instanceId: string): void {
  validateWorkflowOwnership(record)
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
  for (const [index, intent] of record.intents.entries()) {
    const governing = governingWorkflowPreview(record, 'intent', index)
    const outcome = record.outcomes.find(value => value.attemptId === intent.attemptId)
    if (!outcome || !outcome.settled || outcome.state === 'unknown') throw new Error(copy.unknown)
    if (intent.replica) {
      validateWorkflowReplicaReference(intent.replica, program.workflowId)
      if (!callsFor(governing).get(outcome.nodeId)?.replica || !replicas.has(JSON.stringify(intent.replica))) throw new Error(copy.ledger)
    }
    if (intent.workflowId !== program.workflowId || intent.programRevision !== governing.programRevision || outcome.taskId !== intent.taskId || outcome.role !== intent.role || outcome.providerId !== intent.providerId) throw new Error(copy.ledger)
  }
  if (record.outcomes.some(outcome => !outcome.settled || outcome.state === 'unknown')) throw new Error(copy.unknown)
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
  if (!next.execution || next.execution.owner.state !== 'active') throw new Error(copy.ledger)
  if (!current?.execution) {
    if (current && (current.executionStarted !== undefined || current.intents.length || current.outcomes.length)) throw new Error(copy.legacy)
    return
  }
  assertWorkflowRecovery(current, next.execution.owner.instanceId)
  const segments = next.execution.segments
  const revision = segments.at(-1)?.mode === 'revision'
  if (revision) {
    assertWorkflowRevisionChange(current, next.preview, { expectedRevision: segments.at(-1)!.expectedRevision! })
    const history = next.revisions!
    const old = current.revisions ?? [{ preview: current.preview, segmentId: current.execution.segments[0].id, intentOffset: 0, outcomeOffset: 0, reuse: [] }]
    if (history.at(-1)!.segmentId !== next.execution.epoch || history.length !== old.length + 1 || JSON.stringify(history.slice(0, -1)) !== JSON.stringify(old) || history.at(-1)!.intentOffset !== current.intents.length || history.at(-1)!.outcomeOffset !== current.outcomes.length) throw new Error(copy.ledger)
  } else if (JSON.stringify(next.revisions) !== JSON.stringify(current.revisions)) throw new Error(copy.ledger)
  if (segments.at(-1)?.mode === 'retry') assertWorkflowRetryTarget(current, segments.at(-1)!.retry!)
  if (next.execution.epoch === current.execution.epoch || segments.length !== current.execution.segments.length + 1 ||
    JSON.stringify(segments.slice(0, -1)) !== JSON.stringify(current.execution.segments) ||
    (!revision && JSON.stringify(next.preview.program) !== JSON.stringify(current.preview.program)) ||
    next.progress.dispatchAttempts !== current.progress.dispatchAttempts ||
    JSON.stringify(next.intents) !== JSON.stringify(current.intents) || JSON.stringify(next.outcomes) !== JSON.stringify(current.outcomes) ||
    JSON.stringify(next.agentInputs) !== JSON.stringify(current.agentInputs) ||
    JSON.stringify(next.systemIntents) !== JSON.stringify(current.systemIntents) || JSON.stringify(next.systemOutcomes) !== JSON.stringify(current.systemOutcomes)) throw new Error(copy.ledger)
}

export function workflowEpochMatches(current: WorkflowStoreRecord | undefined, next: WorkflowStoreRecord): void {
  if (current?.execution?.epoch !== next.execution?.epoch) throw new Error(copy.stale)
  for (const [attemptId, inputs] of Object.entries(current?.agentInputs ?? {})) {
    const following = next.agentInputs?.[attemptId]
    if (JSON.stringify(inputs.before) !== JSON.stringify(following?.before) || (inputs.after !== undefined && JSON.stringify(inputs.after) !== JSON.stringify(following?.after))) throw new Error(copy.fingerprint)
  }
  if (current?.execution && ((current.revisions !== next.revisions && JSON.stringify(current.revisions) !== JSON.stringify(next.revisions)) || (current.preview.program !== next.preview.program && JSON.stringify(current.preview.program) !== JSON.stringify(next.preview.program)))) throw new Error(copy.fingerprint)
}
