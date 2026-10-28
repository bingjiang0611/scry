import { createHash } from 'node:crypto'
import type { WorkflowApproval, WorkflowBlock, WorkflowFrameReference, WorkflowPlanPreview, WorkflowProgram } from '../shared/workflow'
import { workflowChildBlocks } from '../shared/workflow'
import { workflowRetryCopy } from '../shared/constants/copy'
import { workflowRevisionCopy as copy } from '../shared/constants/workflow-revision-copy'
import { workflowExpressionReferences } from './workflow-expressions'
import { validateWorkflowProgram, workflowRevision } from './workflow-program'
import { workflowFrameId } from './workflow-frames'
import type { WorkflowStoreRecord } from './workflow-store'
import { workflowCallDefinition, workflowHasDynamicRevision, workflowRevisionBlocks } from './workflow-call-semantics'
import { workflowLegacySystemPrefixLength } from './workflow-revision-boundaries'
export { governingWorkflowSystemPreview } from './workflow-revision-boundaries'

export interface WorkflowRevisionReuse { nodeId: string; attemptId: string; reference: WorkflowFrameReference }
export interface WorkflowGoverningRevision {
  preview: WorkflowPlanPreview
  /** Absent only for the untouched historical revision of a legacy root. */
  approval?: WorkflowApproval
  segmentId: string
  intentOffset: number
  outcomeOffset: number
  /** System-ledger boundaries were added after the legacy single-revision format. */
  systemIntentOffset?: number
  systemOutcomeOffset?: number
  reuse: WorkflowRevisionReuse[]
}
export interface WorkflowRevisionTarget { expectedRevision: number }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const verifiedPrograms = new WeakMap<WorkflowProgram, string>()
const frozenParts = new WeakSet<object>()
function freezeProgram(value: object): void {
  if (frozenParts.has(value)) return
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeProgram(child)
  Object.freeze(value)
  frozenParts.add(value)
}

export function assertWorkflowFrozenRevision(preview: WorkflowPlanPreview): void {
  if (!verifiedPrograms.has(preview.program)) {
    const normalized = validateWorkflowProgram(preview.program)
    const { programRevision, ...program } = normalized
    if (programRevision !== workflowRevision(program)) throw new Error(copy.invalid)
    // Ownership writes recheck the journal, not the same immutable AST thousands
    // of times. Only our fully validated, recursively frozen objects hit this
    // weak cache; disk loads, structured clones and replacements validate anew.
    freezeProgram(preview.program)
    verifiedPrograms.set(preview.program, JSON.stringify(preview.program))
  }
  const program = preview.program
  if (preview.programRevision !== program.programRevision || preview.workflowId !== program.workflowId || preview.workspace !== program.workspace || preview.userGoal !== program.userGoal) throw new Error(copy.invalid)
}

export function validateWorkflowRevisions(record: WorkflowStoreRecord): void {
  const revisions = record.revisions
  if (!revisions) {
    if (record.execution?.segments.some(segment => segment.mode === 'revision')) throw new Error(copy.invalid)
    return
  }
  const segments = record.execution?.segments
  if (!segments || !revisions.length || revisions.length > 256) throw new Error(copy.invalid)
  const seen = new Set<string>(), revisionSegments = new Set<string>(), legacyPrefix = workflowLegacySystemPrefixLength(record)
  let priorSegmentIndex = -1
  for (const [index, revision] of revisions.entries()) {
    assertWorkflowFrozenRevision(revision.preview)
    const segmentIndex = segments.findIndex(value => value.id === revision.segmentId)
    const segment = segments[segmentIndex]
    if (segmentIndex <= priorSegmentIndex || revisionSegments.has(revision.segmentId)) throw new Error(copy.invalid)
    priorSegmentIndex = segmentIndex
    revisionSegments.add(revision.segmentId)
    if (!segment || (index === 0 ? segment !== segments[0] : segment.mode !== 'revision') || seen.has(revision.preview.programRevision) ||
      revision.preview.workflowId !== record.preview.workflowId || revision.preview.workspace !== record.preview.workspace ||
      !Number.isSafeInteger(revision.intentOffset) || !Number.isSafeInteger(revision.outcomeOffset) || revision.intentOffset < 0 || revision.outcomeOffset < 0 ||
      revision.intentOffset > record.intents.length || revision.outcomeOffset > record.outcomes.length ||
      (index === 0 ? revision.intentOffset !== 0 || revision.outcomeOffset !== 0 : revision.intentOffset < revisions[index - 1].intentOffset || revision.outcomeOffset < revisions[index - 1].outcomeOffset) ||
      (revision.systemIntentOffset !== undefined && (!Number.isSafeInteger(revision.systemIntentOffset) || revision.systemIntentOffset < 0 || revision.systemIntentOffset > (record.systemIntents?.length ?? 0))) ||
      (revision.systemOutcomeOffset !== undefined && (!Number.isSafeInteger(revision.systemOutcomeOffset) || revision.systemOutcomeOffset < 0 || revision.systemOutcomeOffset > (record.systemOutcomes?.length ?? 0))) ||
      (index === 0 ? ((revision.systemIntentOffset !== undefined && revision.systemIntentOffset !== 0) || (revision.systemOutcomeOffset !== undefined && revision.systemOutcomeOffset !== 0)) :
        ((index >= legacyPrefix && (revision.systemIntentOffset === undefined || revision.systemOutcomeOffset === undefined)) ||
          (revision.systemIntentOffset !== undefined && revision.systemIntentOffset < (revisions[index - 1].systemIntentOffset ?? 0)) ||
          (revision.systemOutcomeOffset !== undefined && revision.systemOutcomeOffset < (revisions[index - 1].systemOutcomeOffset ?? 0)))) ||
      !Array.isArray(revision.reuse) || revision.reuse.length > 1000 || new Set(revision.reuse.map(entry => entry.nodeId)).size !== revision.reuse.length) throw new Error(copy.invalid)
    if ((index && !revision.approval) || (revision.approval && (revision.approval.workflowId !== record.preview.workflowId || revision.approval.programRevision !== revision.preview.programRevision))) throw new Error(copy.invalid)
    if (index) validateWorkflowRevisionReuse(record, revision)
    seen.add(revision.preview.programRevision)
  }
  assertWorkflowFrozenRevision(record.preview)
  if (segments.filter(segment => segment.mode === 'revision').length !== revisions.length - 1 || verifiedPrograms.get(revisions.at(-1)!.preview.program) !== verifiedPrograms.get(record.preview.program)) throw new Error(copy.invalid)
  freezeProgram(revisions)
}

function validateWorkflowRevisionReuse(record: WorkflowStoreRecord, revision: WorkflowGoverningRevision): void {
  if (!revision.reuse.length) return
  const next = workflowStaticRevisionNodes(revision.preview)
  const reused = new Set(revision.reuse.map(entry => entry.nodeId))
  const dependenciesReused = (id: string): boolean => {
    const node = next.nodes.get(id)
    if (!node || node.block.kind === 'replica' || node.block.kind === 'check' || node.block.kind === 'verification' || node.block.kind === 'classifier' || (node.block.kind === 'call' && node.block.replica)) return false
    return (node.block.kind !== 'call' || reused.has(id)) && node.dependencies.every(dependenciesReused)
  }
  for (const entry of revision.reuse) {
    const index = record.outcomes.findIndex(outcome => outcome.attemptId === entry.attemptId)
    const outcome = record.outcomes[index]
    if (index < 0 || index >= revision.outcomeOffset || !outcome || outcome.nodeId !== entry.nodeId || outcome.state !== 'completed' || !outcome.settled || outcome.actualModelStatus !== 'observed' || !record.intents.some(intent => intent.attemptId === outcome.attemptId) || !dependenciesReused(entry.nodeId)) throw new Error(copy.invalid)
    const governing = governingWorkflowPreview(record, 'outcome', index)
    const prior = workflowStaticRevisionNodes(governing)
    const node = prior.nodes.get(entry.nodeId)
    if (!node || node.block.kind !== 'call' || prior.fingerprints.get(entry.nodeId) !== next.fingerprints.get(entry.nodeId) || outcome.taskId !== workflowRevisionTaskId(governing, entry.nodeId, node.path) || !entry.reference || !Number.isSafeInteger(entry.reference.revision) || entry.reference.revision < 1) throw new Error(copy.invalid)
  }
}

export function governingWorkflowPreview(record: WorkflowStoreRecord, kind: 'intent' | 'outcome', index: number): WorkflowPlanPreview {
  const key = kind === 'intent' ? 'intentOffset' : 'outcomeOffset'
  return [...(record.revisions ?? [])].reverse().find(revision => revision[key] <= index)?.preview ?? record.preview
}

/** This bounded graph uses IR references, not launch order. Container outputs
 * depend on their children; bind expressions retain transitive call inputs.
 * Dynamic programs are rejected by the static selector; closed SystemSteps are
 * represented as non-reusable dependencies rather than historical replays. */
export function workflowStaticRevisionNodes(preview: WorkflowPlanPreview) {
  const nodes = new Map<string, { block: WorkflowBlock; path: string[]; dependencies: string[] }>()
  const visit = (block: WorkflowBlock, path: string[]) => {
    if (!['sequence', 'parallel', 'bind', 'call', 'return', 'replica', 'combine', 'check', 'verification', 'classifier'].includes(block.kind)) throw new Error(copy.unsupported)
    const children = workflowChildBlocks(block)
    const dependencies = block.kind === 'call' ? [...(block.inputRefs ?? []).map(ref => ref.nodeId), ...(block.replica ? workflowExpressionReferences(block.replica) : [])]
      : block.kind === 'bind' ? workflowExpressionReferences(block.value) : block.kind === 'return' ? [block.ref.nodeId]
      : block.kind === 'replica' ? (block.source ? workflowExpressionReferences(block.source) : [])
      : block.kind === 'combine' ? [...workflowExpressionReferences(block.base), ...workflowExpressionReferences(block.candidates)]
      : block.kind === 'check' ? workflowExpressionReferences(block.replica)
      : block.kind === 'verification' ? [...Object.values(block.required).flatMap(entry => workflowExpressionReferences(entry.result)), ...(block.baseline ? workflowExpressionReferences(block.baseline) : [])]
      : block.kind === 'classifier' ? (block.inputRefs ?? []).map(ref => ref.nodeId)
      : children.map(child => child.blockId)
    nodes.set(block.blockId, { block, path, dependencies })
    for (const child of children) visit(child, block.kind === 'parallel' ? [...path, 'parallel:' + child.blockId] : path)
  }
  visit(preview.program.body, ['revision:' + preview.programRevision])
  const fingerprints = new Map<string, string>(), visiting = new Set<string>()
  const fingerprint = (nodeId: string): string => {
    if (fingerprints.has(nodeId)) return fingerprints.get(nodeId)!
    const node = nodes.get(nodeId)
    if (!node || visiting.has(nodeId)) throw new Error(copy.unsupported)
    visiting.add(nodeId)
    const block = node.block
    const role = block.kind === 'call' ? preview.program.roles.find(value => value.role === block.role) : undefined
    const value = digest({ block: node.block, role, workspace: preview.workspace, goal: preview.userGoal, dependencies: node.dependencies.map(id => [id, fingerprint(id)]) })
    visiting.delete(nodeId); fingerprints.set(nodeId, value)
    return value
  }
  for (const id of nodes.keys()) fingerprint(id)
  return { nodes, fingerprints }
}

export function workflowRevisionTaskId(preview: WorkflowPlanPreview, nodeId: string, path: string[]): string {
  return `${preview.workflowId}:${workflowFrameId(nodeId, path)}:${nodeId}`
}

export function assertWorkflowRevisionChange(current: WorkflowStoreRecord, preview: WorkflowPlanPreview, target: WorkflowRevisionTarget): void {
  if (!target || Object.keys(target).length !== 1 || !Number.isSafeInteger(target.expectedRevision) || target.expectedRevision !== current.progress.revision) throw new Error(copy.stale)
  assertWorkflowFrozenRevision(preview)
  if (preview.workflowId !== current.preview.workflowId || preview.workspace !== current.preview.workspace || preview.programRevision === current.preview.programRevision || current.revisions?.some(revision => revision.preview.programRevision === preview.programRevision)) throw new Error(copy.identity)
  if (workflowHasDynamicRevision(current.preview) || workflowHasDynamicRevision(preview)) {
    const old = workflowRevisionBlocks(current.preview), next = workflowRevisionBlocks(preview)
    for (const intent of current.intents) {
      const outcome = current.outcomes.find(value => value.attemptId === intent.attemptId)
      const previous = outcome && old.get(outcome.nodeId), candidate = outcome && next.get(outcome.nodeId)
      // Legacy dynamic failures have no authoritative invocation descriptor.
      // A different sibling/revision is not permission to guess replay safety.
      if (!intent.callFrameId && outcome && outcome.state !== 'completed' && outcome.providerDispatch !== 'not_attempted' && previous?.kind === 'call' && candidate?.kind === 'call' && workflowCallDefinition(current.preview, previous) === workflowCallDefinition(preview, candidate)) throw new Error(workflowRetryCopy.unsafe)
    }
    return
  }
  const old = workflowStaticRevisionNodes(current.preview), next = workflowStaticRevisionNodes(preview)
  for (const [nodeId, node] of old.nodes) {
    if (node.block.kind !== 'call' || old.fingerprints.get(nodeId) !== next.fingerprints.get(nodeId)) continue
    const taskId = workflowRevisionTaskId(current.preview, nodeId, node.path)
    const outcome = [...current.outcomes].reverse().find(value => value.taskId === taskId)
    if (outcome && outcome.state !== 'completed' && current.intents.some(intent => intent.attemptId === outcome.attemptId) && outcome.providerDispatch !== 'not_attempted') throw new Error(workflowRetryCopy.unsafe)
  }
}
