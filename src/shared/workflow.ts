import type { ProviderId, ProviderDescriptor } from './provider.js'
import type { AgentModelRef, AgentPermissionMode, RuntimeProvider } from './runtime.js'

export const WORKFLOW_SCHEMA_VERSION = 1 as const
export const WORKFLOW_MAX_BATCH = 4096
export const WORKFLOW_MAX_ATTEMPTS = 1000
export const WORKFLOW_DEFAULT_SLOTS = 16
export const WORKFLOW_MIN_SLOTS = 1
export const WORKFLOW_MAX_SLOTS = 256

export type WorkflowRole = 'orchestrator' | 'worker' | 'reviewer' | 'summarizer'
export type WorkflowCapabilityState = 'available' | 'unavailable' | 'unknown'

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
}

export interface WorkflowCallBlock {
  kind: 'call'
  blockId: string
  role: WorkflowRole
  prompt: string
  inputRefs?: WorkflowOutputRef[]
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
}

export interface WorkflowReturnBlock {
  kind: 'return'
  blockId: string
  ref: WorkflowOutputRef
}

export type WorkflowBlock = WorkflowSequenceBlock | WorkflowParallelBlock | WorkflowCallBlock | WorkflowReturnBlock

export interface WorkflowProgram {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION
  workflowId: string
  programRevision: string
  userGoal: string
  workspace: string
  roles: WorkflowRoleBinding[]
  body: WorkflowBlock
}

export interface WorkflowPlanPreview {
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

export interface WorkflowProgress {
  workflowId: string
  programRevision: string
  workspace: string
  goal: string
  state: WorkflowExecutionState
  attempts: WorkflowAttemptOutcome[]
  outcomeCount?: number
  dispatchAttempts: number
  slots: { limit: number; inUse: number; queued: number }
  finalReport?: string
  finalReportStatus?: 'available' | 'unavailable'
  error?: string
  updatedAt: number
  revision?: number
}

/** Renderer progress never contains intermediate Agent output. */
export function workflowProgressSnapshot(progress: WorkflowProgress): WorkflowProgress {
  const attempts = progress.attempts.slice(-32).map(({ output: _output, ...attempt }) => attempt)
  return { ...progress, outcomeCount: progress.attempts.length, attempts }
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
