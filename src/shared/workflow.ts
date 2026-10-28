import type { WorkflowPlanningSize } from './workflow-size'
import type { ProviderId, ProviderDescriptor } from './provider.js'
import type { AgentModelRef, AgentPermissionMode, RuntimeProvider } from './runtime.js'
import type { WorkflowTemplateInstance } from './workflow-template.js'
import type { WorkflowCheckRequest, WorkflowFrozenCheck } from './workflow-check'
import type { WorkflowReplicaReference } from './workflow-replica'
import type { WorkflowSystemProgress } from './workflow-system'

export const WORKFLOW_SCHEMA_VERSION = 1 as const
export const WORKFLOW_MAX_BATCH = 4096
export const WORKFLOW_MAX_ATTEMPTS = 1000
export const WORKFLOW_MAX_TASK_ATTEMPTS = 6
export const WORKFLOW_MAX_STOP_REQUESTS = 256
export const WORKFLOW_MAX_OUTPUT_LENGTH = 16 * 1024
export const WORKFLOW_MAX_SCHEMA_DEPTH = 16
export const WORKFLOW_MAX_SCHEMA_NODES = 256
export const WORKFLOW_MAX_VALUE_BYTES = 4 * 1024 * 1024
export const WORKFLOW_MAX_VALUE_DEPTH = 64
export const WORKFLOW_MAX_EXPRESSION_NODES = 256
export const WORKFLOW_MAX_EXPRESSION_DEPTH = 16
export const WORKFLOW_DEFAULT_SLOTS = 16
export const WORKFLOW_MIN_SLOTS = 1
export const WORKFLOW_MAX_SLOTS = 256

export type WorkflowRole = 'orchestrator' | 'worker' | 'reviewer' | 'summarizer'
export type WorkflowCapabilityState = 'available' | 'unavailable' | 'unknown'
export type WorkflowParallelFailurePolicy = 'all_settled' | 'fail_fast'
export type WorkflowStopProvenance = {
  source: 'auto'
  policy: 'fail_fast'
  trigger: { nodeId: string; phase: WorkflowControlFrame['phase']; frameId: string }
}

export interface WorkflowRoleBinding {
  role: WorkflowRole
  providerId: ProviderId
  agentProfileId?: string
  requestedModel?: AgentModelRef
  permissionMode?: AgentPermissionMode
  /** Main-resolved Provider/catalog fingerprint, not a resume or credential identity.
   * Never accepted from renderer role input. Native config trust is revalidated separately. */
  runtimeIdentity?: string
}

export interface WorkflowRoleCapability {
  role: WorkflowRole
  providerId: ProviderId
  agentProfileId?: string
  requestedModel?: AgentModelRef
  actualModel?: string
  actualModelStatus: 'unknown' | 'observed'
  runtimeProvider?: RuntimeProvider
  runtimeIdentity?: string
  startIndependentSession: WorkflowCapabilityState
  observeTerminalOutput: WorkflowCapabilityState
  confirmStopConvergence: WorkflowCapabilityState
  state: WorkflowCapabilityState
  reason?: string
}

export interface WorkflowOutputRef {
  nodeId: string
  path?: string[]
}

export type WorkflowScalar = string | number | boolean | null
export type WorkflowValue = WorkflowScalar | WorkflowValue[] | { [key: string]: WorkflowValue }

/** Finite data contracts, never executable TypeScript/JSON-Schema extensions. */
export type WorkflowValueSchema =
  | { type: 'string' | 'number' | 'boolean' | 'null' }
  | { type: 'enum'; values: WorkflowScalar[] }
  | { type: 'union'; variants: WorkflowValueSchema[] }
  | { type: 'array'; items: WorkflowValueSchema; maxItems: number }
  | { type: 'object'; properties: Record<string, WorkflowValueSchema>; required: string[] }
  | { type: 'collection'; items: WorkflowValueSchema }

export type WorkflowExpression =
  | { kind: 'literal'; value: WorkflowValue }
  | { kind: 'ref'; name: string }
  | { kind: 'field'; source: WorkflowExpression; path: string[] }
  | { kind: 'compare'; operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; left: WorkflowExpression; right: WorkflowExpression }
  | { kind: 'and'; values: WorkflowExpression[] }
  | { kind: 'or'; values: WorkflowExpression[] }
  | { kind: 'not'; value: WorkflowExpression }
  | { kind: 'count'; value: WorkflowExpression }
  | { kind: 'concat'; values: WorkflowExpression[] }
  | { kind: 'group'; items: WorkflowExpression; key: string[] }
  | { kind: 'unique'; items: WorkflowExpression; key: string[] }
  | { kind: 'filter'; items: WorkflowExpression; item: string; when: WorkflowExpression }
  | { kind: 'partition'; items: WorkflowExpression; item: string; when: WorkflowExpression }
  | { kind: 'project'; items: WorkflowExpression; item: string; value: WorkflowExpression }

/** Host-only read authority for a controlled collection nested in ordinary JSON.
 * Paths never originate from literal/model descriptors. Durable stores validate
 * their workflow identity and exact descriptor at every declared position. */
export type WorkflowCollectionField = { path: string[]; collection: WorkflowCollectionReference }
export type WorkflowEvaluation =
  | { state: 'known'; value: WorkflowValue; derivedFrom: string[]; collection?: WorkflowCollectionReference; collectionFields?: WorkflowCollectionField[]; replica?: WorkflowReplicaReference }
  | { state: 'unknown'; reason: string; derivedFrom: string[] }

export type WorkflowValueReference = {
  workflowId: string
  key: string
  hash: string
}

export type WorkflowFrameReference = {
  frameId: string
  revision: number
  resultRef: WorkflowValueReference
}

export type WorkflowCollectionReference = { reference: WorkflowValueReference; count: number; sealed: boolean }
export type WorkflowCollectionEntry = {
  key: WorkflowScalar
  index: number
  state: 'pending' | 'completed' | 'failed' | 'blocked' | 'unknown' | 'stopped'
  settled: boolean
  reference?: WorkflowFrameReference
  /** Immutable pure-transform row; never evidence of an Agent/SystemStep effect. */
  valueRef?: WorkflowValueReference
  error?: string
}

export type WorkflowLoopExitReason = 'success' | 'no_progress' | 'oscillation' | 'exhausted' | 'failed' | 'blocked' | 'unknown' | 'stopped'
export type WorkflowLoopCheckpoint = {
  semanticStateRef?: WorkflowValueReference
  initialSemanticStateRef?: WorkflowValueReference
  invariantSemanticRef?: WorkflowValueReference
  iteration: number
  stage: 'ready' | 'committed'
  stateRefs: Record<string, WorkflowValueReference>
  initialStateRefs: Record<string, WorkflowValueReference>
  invariantRefs: Record<string, WorkflowValueReference>
  noProgress: number
  history: Array<{ iteration: number; key: string }>
  iterations: WorkflowValueReference[]
  bestRef?: WorkflowValueReference
  outcomeRef?: WorkflowValueReference
  reasons: WorkflowLoopExitReason[]
}

export interface WorkflowControlFrame {
  /** Immutable semantic input artifact; legacy frames have none. */
  callInputRef?: WorkflowValueReference
  callInputKey?: string
  sourceSemanticKey?: string
  decisionSemanticKey?: string
  callReuse?: import('./workflow-call').WorkflowCallReuseSource
  resultSemanticKey?: string
  schemaVersion: 1
  workflowId: string
  programRevision: string
  frameId: string
  nodeId: string
  scopePath: string[]
  /** Structural ancestry is explicit. Missing is legacy unknown; null is a recorded root. */
  parentFrameId?: string | null
  inputKey: string
  executionEpoch?: string
  generationId?: string
  origin?: { frameId: string; revision: number }
  revision: number
  phase: 'entered' | 'selected' | 'completed' | 'failed' | 'blocked' | 'unknown' | 'stopped' | 'skipped_by_condition'
  arm?: 'then' | 'else' | 'unknown'
  decisionRef?: WorkflowValueReference
  resultRef?: WorkflowValueReference
  reason?: string
  cursor?: number
  children?: WorkflowFrameReference[]
  sourceRef?: WorkflowValueReference
  loop?: WorkflowLoopCheckpoint
  continuation?: 'report_partial'
}

export interface WorkflowBindBlock {
  kind: 'bind'
  blockId: string
  value: WorkflowExpression
  schema?: WorkflowValueSchema
}

export interface WorkflowBranchBlock {
  kind: 'branch'
  blockId: string
  when: WorkflowExpression
  then: WorkflowBlock
  else: WorkflowBlock
  unknown: WorkflowBlock | 'blocked'
}

export interface WorkflowMapBlock {
  kind: 'map'
  blockId: string
  items: WorkflowExpression
  item: string
  key: string[]
  maxItems: number
  body: WorkflowBlock
}

export interface WorkflowCollectBlock {
  kind: 'collect'
  blockId: string
  items: WorkflowExpression
}

export interface WorkflowLoopBlock {
  kind: 'loop'
  blockId: string
  initial: Record<string, WorkflowExpression>
  stateSchema: Record<string, WorkflowValueSchema | 'inferred'>
  invariants: Record<string, WorkflowExpression>
  iteration?: string
  best?: string
  outcome: string
  maxIterations: number
  body: WorkflowBlock
  until: WorkflowExpression
  carry: Record<string, WorkflowExpression>
  result: WorkflowExpression
  progress: 'bounded_only' | { baseline: WorkflowExpression; key: WorkflowExpression; improved: WorkflowExpression }
  policy: { error: 'fail_closed'; unknown: 'block'; stop: 'cancel'; logicalExit: 'report_partial' }
}

export interface WorkflowReplicaBlock {
  kind: 'replica'
  blockId: string
  source?: WorkflowExpression
}
export interface WorkflowCombineBlock {
  kind: 'combine'
  blockId: string
  base: WorkflowExpression
  candidates: WorkflowExpression
}
export interface WorkflowCheckBlock {
  kind: 'check'
  blockId: string
  replica: WorkflowExpression
  check: WorkflowCheckRequest
  /** Main-frozen at plan preparation, never trusted from a portable template. */
  authorization?: WorkflowFrozenCheck
}

export interface WorkflowCallBlock {
  kind: 'call'
  blockId: string
  role: WorkflowRole
  prompt: string
  inputRefs?: WorkflowOutputRef[]
  replica?: WorkflowExpression
  outputSchema?: WorkflowValueSchema
}

export interface WorkflowSequenceBlock {
  kind: 'sequence'
  blockId: string
  blocks: WorkflowBlock[]
}

export interface WorkflowParallelBlock {
  kind: 'parallel'
  blockId: string
  blocks: WorkflowBlock[]
  failurePolicy?: WorkflowParallelFailurePolicy
}

export interface WorkflowReturnBlock {
  kind: 'return'
  blockId: string
  ref: WorkflowOutputRef
}

export interface WorkflowVerificationBlock {
  kind: 'verification'
  blockId: string
  required: Record<string, { check: string; result: WorkflowExpression }>
  protectedPaths?: string[]
  baseline?: WorkflowExpression
}

export type WorkflowBlock = WorkflowVerificationBlock | WorkflowSequenceBlock | WorkflowParallelBlock | WorkflowCallBlock | WorkflowReturnBlock | WorkflowBindBlock | WorkflowBranchBlock | WorkflowMapBlock | WorkflowCollectBlock | WorkflowLoopBlock | WorkflowReplicaBlock | WorkflowCombineBlock | WorkflowCheckBlock

export function workflowChildBlocks(block: WorkflowBlock): WorkflowBlock[] {
  switch (block.kind) {
    case 'call': case 'return': case 'bind': case 'collect': case 'replica': case 'combine': case 'check': case 'verification': return []
    case 'map': case 'loop': return [block.body]
    case 'branch': return [block.then, block.else, ...(block.unknown === 'blocked' ? [] : [block.unknown])]
    case 'sequence': case 'parallel': return block.blocks
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
      case 'project': visit(value.items, local); visit(value.value, new Set(local).add(value.item)); return
    }
  }
  visit(expression, new Set())
  return [...names]
}


export interface WorkflowProgram {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  workflowId: string
  programRevision: string
  userGoal: string
  workspace: string
  roles: WorkflowRoleBinding[]
  body: WorkflowBlock
  template?: WorkflowTemplateInstance
}

export interface WorkflowPlanPreview {
  readonly planningSize?: WorkflowPlanningSize
  workflowId: string
  programRevision: string
  userGoal: string
  workspace: string
  orchestrator: WorkflowRoleBinding
  roles: WorkflowRoleCapability[]
  program: WorkflowProgram
  plannedCalls: number
  state: 'draft' | 'ready' | 'unavailable'
  unavailableReasons: string[]
  observedAt: number
}

export interface WorkflowApproval {
  workflowId: string
  programRevision: string
  approvedAt: number
}

export type WorkflowExecutionState = 'awaiting_approval' | 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'stopped' | 'unknown'
export type WorkflowAttemptState = 'intent_persisted' | 'dispatched' | 'running' | 'completed' | 'failed' | 'blocked' | 'stopped' | 'unknown'

export const WORKFLOW_LIVE_MAX_IDS = 32
export const WORKFLOW_LIVE_MAX_ID_LENGTH = 256

/** Bounded, non-content evidence from a live Provider run. A missing native callback is not an empty stream. */
export type WorkflowLiveObservation =
  | { source: 'pi_native'; kind: 'tool_started'; toolCallId: string }
  | { source: 'pi_native'; kind: 'tool_ended'; toolCallId: string }
  | { source: 'pi_native'; kind: 'model_progress'; channel: 'text' | 'thinking' }
  | { source: 'claude_native'; kind: 'model_progress'; channel: 'text' | 'thinking' }
  // Claude activity/return describe an observed model-facing exchange only,
  // never physical start/end or background resource settlement.
  | { source: 'claude_native'; kind: 'tool_activity'; toolCallId: string }
  | { source: 'claude_native'; kind: 'tool_returned'; toolCallId: string }
  | { source: 'main_permission'; kind: 'permission_started'; permissionId: string }
  | { source: 'main_permission'; kind: 'permission_ended'; permissionId: string }

export type WorkflowLiveStatus = 'unavailable' | 'unknown' | 'model_progress' | 'tool_wait' | 'permission_wait'

export interface WorkflowLiveAttempt {
  taskId: string
  attemptId: string
  runId: string
  providerId: ProviderId
  epoch: string
  source: Array<'pi_native' | 'claude_native' | 'main_permission'>
  status: WorkflowLiveStatus
  /** Count of tracked IDs, not proof that the Provider has no other active tools. */
  trackedToolCount: number
  truncated: boolean
  activeToolIds: string[]
  activePermissionIds: string[]
  modelProgressCount: number
  observedAt: number
  lastGenuineProgressAt?: number
}

export interface WorkflowLiveDiagnostics {
  epoch: string
  revision: number
  attemptCount: number
  truncated: boolean
  status: WorkflowLiveStatus
  coverage: 'unavailable' | 'partial'
  automaticStall: 'unsupported'
  attempts: WorkflowLiveAttempt[]
  observedAt: number
}

export function workflowLiveDiagnosticsSnapshot(diagnostics: WorkflowLiveDiagnostics): WorkflowLiveDiagnostics {
  return {
    ...diagnostics,
    attempts: diagnostics.attempts.slice(-WORKFLOW_LIVE_MAX_IDS).map(attempt => ({
      ...attempt,
      activeToolIds: attempt.activeToolIds.slice(0, WORKFLOW_LIVE_MAX_IDS),
      activePermissionIds: attempt.activePermissionIds.slice(0, WORKFLOW_LIVE_MAX_IDS),
      source: [...attempt.source]
    }))
  }
}

export interface WorkflowAttemptOutcome {
  attemptId: string
  taskId: string
  nodeId: string
  role: WorkflowRole
  providerId: ProviderId
  requestedModel?: AgentModelRef
  actualModel?: string
  actualModelStatus: 'unknown' | 'observed'
  state: WorkflowAttemptState
  output?: string
  outputRef?: string
  error?: string
  runId?: string
  archiveRef?: string
  /** Canonical start failed before entering Provider.run; absent on legacy/uncertain attempts. */
  providerDispatch?: 'not_attempted'
  settled: boolean
}

/** Stop intent is a view over the control ledger, not an Agent result. */
export type WorkflowAttemptProgress = WorkflowAttemptOutcome & {
  /** Display-only link to the canonical frame admission intent. */
  frameId?: string
  stopRequested?: { commandId: string; requestedAt: number; provenance?: WorkflowStopProvenance }
}

export interface WorkflowProgress {
  readonly planningSize?: WorkflowPlanningSize
  workflowId: string
  programRevision: string
  workspace: string
  goal: string
  state: WorkflowExecutionState
  attempts: WorkflowAttemptProgress[]
  outcomeCount?: number
  dispatchAttempts: number
  systemSteps?: WorkflowSystemProgress[]
  /** A user stop was requested; neither signal acknowledgement nor scope settlement. */
  stopRequestedAt?: number
  slots: { limit: number; inUse: number; queued: number }
  finalReport?: string
  finalReportStatus?: 'available' | 'unavailable'
  error?: string
  /** Ephemeral live evidence. It is deliberately absent from persisted recovery authority. */
  live?: WorkflowLiveDiagnostics
  updatedAt: number
  revision?: number
}

/** Renderer progress never contains intermediate Agent output. */
export function workflowProgressSnapshot(progress: WorkflowProgress): WorkflowProgress {
  const attempts = progress.attempts.slice(-32).map(({ output: _output, ...attempt }) => attempt)
  return {
    ...progress,
    outcomeCount: Math.max(progress.outcomeCount ?? 0, progress.attempts.length),
    attempts,
    ...(progress.live ? { live: workflowLiveDiagnosticsSnapshot(progress.live) } : {})
  }
}

export interface WorkflowProgressPage {
  records: WorkflowProgress[]
  nextCursor?: string
  unresolvedPlanning?: number
}

export interface WorkflowCommandRequest {
  command: string
  cwd: string
}

export function parseWorkflowRunCommand(command: string): { goal: string } | null {
  if (typeof command !== 'string') return null
  const match = /^\/scry-workflow\s+run(?:\s+([\s\S]*?))?\s*$/.exec(command.trim())
  const goal = match?.[1]?.trim()
  return goal ? { goal } : null
}

export function workflowSlotLimit(verifiedCpuCount: number, configured?: number): number {
  if (configured === undefined) {
    if (!Number.isSafeInteger(verifiedCpuCount) || verifiedCpuCount < 1) throw new Error('无法验证可用 CPU 数量')
    return Math.min(WORKFLOW_DEFAULT_SLOTS, verifiedCpuCount)
  }
  if (!Number.isSafeInteger(configured) || configured < WORKFLOW_MIN_SLOTS || configured > WORKFLOW_MAX_SLOTS) {
    throw new Error(`工作流并发槽位必须是 ${WORKFLOW_MIN_SLOTS}–${WORKFLOW_MAX_SLOTS} 的整数`)
  }
  return configured
}

export function providerCapabilityState(descriptor: ProviderDescriptor | undefined): WorkflowCapabilityState {
  if (!descriptor) return 'unavailable'
  if (!descriptor.available || descriptor.health?.state === 'unavailable') return 'unavailable'
  if (descriptor.health?.state === 'unknown' || descriptor.health?.state === 'degraded') return 'unknown'
  return 'available'
}
