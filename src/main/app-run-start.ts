import type { AgentQuestionRequest, AgentQuestionResponse, AgentPermissionMode } from '../shared/runtime'
import type { TraceEvent } from '../shared/trace'
import type { WorkflowLiveObservation } from '../shared/workflow'
import type { ManagedConversationStart } from './conversation-service'
import type { WorkflowReplicaRun } from './workflow-system-host'
import type { ProviderStructuredOutput } from './providers/types'

export interface WorkflowTerminalResult {
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown' | 'blocked'
  structuredOutput?: ProviderStructuredOutput
  items: TraceEvent[]
  externalSessionId?: string
  archiveRef?: string
  settled: true
}

/** Called only after the App-owned scope has settled. Archive correlation alone
 * does not authorize a successful or canonical structured result. */
export function projectSettledWorkflowTerminal(facts: Omit<WorkflowTerminalResult, 'status' | 'settled'> & {
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  interactionBlocked: boolean
  recordingFailed: boolean
}): WorkflowTerminalResult {
  const { status, interactionBlocked, recordingFailed, structuredOutput, ...evidence } = facts
  const durable = !interactionBlocked && !recordingFailed && status === 'completed' && evidence.archiveRef
  return {
    ...evidence,
    items: [...evidence.items],
    status: interactionBlocked ? 'blocked' : durable ? 'completed' : status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'unknown',
    ...(durable && structuredOutput ? { structuredOutput } : {}),
    settled: true
  }
}

export interface AppRunStartOptions {
  origin?: 'local' | 'remote' | 'workflow'
  purpose?: 'workflow_authoring'
  /** Main-selected schema for a restricted authoring purpose; never renderer-controlled. */
  authoringSchema?: Readonly<Record<string, unknown>>
  beforeWorkflowAuthoringDispatch?: () => Promise<void>
  expectedWorkflowContinuationKey?: string
  runId?: string
  stopSignal?: AbortSignal
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
  permissionModeOverride?: AgentPermissionMode
  providerPrompt?: string
  onTraceEvent?: (event: TraceEvent) => void
  onWorkflowObservation?: (observation: WorkflowLiveObservation) => void
  onSession?: (externalSessionId: string) => void
  ledgerRunId?: string
  managedConversation?: ManagedConversationStart
  expectedWorkflowCapability?: string
  workflowReplica?: WorkflowReplicaRun
  onProviderDispatchAttempt?: () => void
  onTerminal?: (result: WorkflowTerminalResult) => void | Promise<void>
}
