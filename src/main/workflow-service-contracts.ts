import type { WorkflowSystemHost, WorkflowReplicaRun } from './workflow-system-host'

import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowLiveObservation, WorkflowProgress, WorkflowRoleBinding } from '../shared/workflow'

import type { WorkflowSlots, WorkflowProviderExecution } from './workflow-runner'

import type { WorkflowSizeSnapshot } from '../shared/workflow-size'
import type { WorkflowRoutingMode } from '../shared/workflow-mode'
import type { WorkflowTaskReference } from '../shared/workflow-api'
import type { WorkflowStore } from './workflow-store'
import type { ProviderStructuredOutput } from './providers/types'
import type { WorkflowTemplateStore } from './workflow-template-store'
import type { WorkflowClassifierAdapter } from '../shared/workflow-classifier'

export interface WorkflowPlanRequest {
  command: string
  commandId?: string
  routingMode?: WorkflowRoutingMode
  workspace: string
  orchestrator: WorkflowRoleBinding
  roles: WorkflowRoleBinding[]
  capturedTask?: { reference: WorkflowTaskReference; inputSha256: string; sizeGuideline: WorkflowSizeSnapshot; authoringContinuationKey?: string }
  beforeProviderDispatch?: () => Promise<void>
}
export type WorkflowRestartEvidence =
  | { state: 'settled'; attemptId: string; taskId: string; runId: string; settledAt: number; source: 'app_run_terminal'; reason: 'stalled' | 'reply_lost' }
  | { state: 'unavailable' | 'unknown' | 'unsettled'; attemptId: string; taskId: string; reason: string }

export type WorkflowRestartEvidenceProvider = (request: { workflowId: string; taskId: string; attemptId: string; programRevision: string }) => Promise<WorkflowRestartEvidence>

export interface WorkflowPlanProvider {
  (request: { workflowId: string; role: WorkflowRoleBinding; roles: WorkflowRoleBinding[]; goal: string; workspace: string; sizeGuideline: WorkflowSizeSnapshot; signal: AbortSignal; beforeProviderDispatch?: () => Promise<void>; expectedContinuationKey?: string; route?: true; routingMode?: WorkflowRoutingMode }): Promise<{ output: string; outputSource?: ProviderStructuredOutput['source']; actualModel?: string; archiveRef?: string }>
}
export interface WorkflowServiceOptions {
  store: WorkflowStore
  templates?: WorkflowTemplateStore
  systems?: WorkflowSystemHost
  providerRegistered: (providerId: ProviderId) => boolean
  runControls: (role: WorkflowRoleBinding, workspace: string) => Promise<{ descriptor: ProviderDescriptor; model: boolean; stop: boolean; identity: string; independentRun: boolean; terminalOutput: boolean; structuredCandidateAuthoring?: import('../shared/workflow').WorkflowCapabilityState; hostToolsDisabled?: import('../shared/workflow').WorkflowCapabilityState; permissionQuestion?: import('../shared/workflow').WorkflowCapabilityState; businessQuestion?: import('../shared/workflow').WorkflowCapabilityState; waitStates?: import('../shared/workflow').WorkflowRoleCapability['waitStates'] }>
  plan: WorkflowPlanProvider
  execute: (request: { workflowId: string; taskId: string; attemptId: string; role: WorkflowRoleBinding; prompt: string; workspace: string; replicaRun?: WorkflowReplicaRun; onObservation?: (observation: WorkflowLiveObservation) => void }) => WorkflowProviderExecution
  restartEvidence?: WorkflowRestartEvidenceProvider
  slots?: WorkflowSlots
  loadConcurrency?: () => Promise<number | undefined>
  onProgress?: (progress: WorkflowProgress) => void
  classifierAdapter?: WorkflowClassifierAdapter
}
export interface Receipt<T> { fingerprint: string; promise: Promise<T>; settled: boolean }
export type WorkflowShutdownPreparation =
  | { state: 'ready'; workflowCount: number }
  | { state: 'unconfirmed'; workflowIds: string[]; reason: string }
  | { state: 'storage_failure'; reason: string }
  | { state: 'initialization_failure'; reason: string }

export interface WorkflowShutdownPreparationOptions {
  timeoutMs?: number
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  deadlineAt?: number
}

export interface ShutdownPreparationToken { cancelled: boolean }
