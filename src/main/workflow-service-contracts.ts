import type { WorkflowSystemHost, WorkflowReplicaRun } from './workflow-system-host'

import type { ProviderDescriptor, ProviderId } from '../shared/provider'
import type { WorkflowLiveObservation, WorkflowProgress, WorkflowRoleBinding } from '../shared/workflow'

import type { WorkflowSlots, WorkflowProviderExecution } from './workflow-runner'

import type { WorkflowStore } from './workflow-store'
import type { WorkflowTemplateStore } from './workflow-template-store'

export interface WorkflowPlanRequest {
  command: string
  commandId?: string
  workspace: string
  orchestrator: WorkflowRoleBinding
  roles: WorkflowRoleBinding[]
}
export interface WorkflowPlanProvider {
  (request: { workflowId: string; role: WorkflowRoleBinding; roles: WorkflowRoleBinding[]; goal: string; workspace: string; signal: AbortSignal }): Promise<{ output: string; actualModel?: string; archiveRef?: string }>
}
export interface WorkflowServiceOptions {
  store: WorkflowStore
  templates?: WorkflowTemplateStore
  systems?: WorkflowSystemHost
  providerRegistered: (providerId: ProviderId) => boolean
  runControls: (role: WorkflowRoleBinding, workspace: string) => Promise<{ descriptor: ProviderDescriptor; model: boolean; stop: boolean; identity: string; independentRun: boolean; terminalOutput: boolean }>
  plan: WorkflowPlanProvider
  execute: (request: { workflowId: string; taskId: string; attemptId: string; role: WorkflowRoleBinding; prompt: string; workspace: string; replicaRun?: WorkflowReplicaRun; onObservation?: (observation: WorkflowLiveObservation) => void }) => WorkflowProviderExecution
  slots?: WorkflowSlots
  loadConcurrency?: () => Promise<number | undefined>
  onProgress?: (progress: WorkflowProgress) => void
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
