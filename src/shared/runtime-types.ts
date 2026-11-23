import type { ProviderId } from './provider.js'
import type { PreparedWorkspace, WorkspaceStartSelection } from './workspace-selection.js'

export type AgentDataUpdated =
  | { runId: string; kind?: 'turn_recorded' | 'session_deleted' }
  | { kind: 'conversation_changed'; conversationId: string }
  | { kind: 'catalog_recovered' }
  | { kind: 'resynchronize' }

export type RuntimeBackend = 'local' | 'api'
export type RuntimeProvider = 'claude_sdk' | 'codex_cli' | 'qoder_cli' | 'opencode_server' | 'pi_rpc' | 'antigravity_acp'

export type RuntimeFailureStage =
  | 'discovery'
  | 'version_probe'
  | 'spawn'
  | 'protocol'
  | 'parser'
  | 'runtime'
  | 'normalization'
  | 'ledger'
  | 'frontdoor'
  | 'capability'

export const RUN_TERMINATION_REASONS = [
  'input_context_overflow',
  'output_token_limit',
  'model_context_window_exceeded',
  'max_turns',
  'budget_exceeded'
] as const

export type RunTerminationReason = typeof RUN_TERMINATION_REASONS[number]

export function isRunTerminationReason(value: unknown): value is RunTerminationReason {
  return typeof value === 'string' && (RUN_TERMINATION_REASONS as readonly string[]).includes(value)
}

export interface RunTerminationEvidence {
  rawReason?: unknown
  subtype?: unknown
  message?: unknown
}

export type AgentPermissionMode = 'default' | 'auto_accept_edits' | 'auto_review' | 'full_access'

export const AGENT_PERMISSION_MODES: readonly AgentPermissionMode[] = [
  'default',
  'auto_accept_edits',
  'auto_review',
  'full_access'
]

export function isAgentPermissionMode(value: unknown): value is AgentPermissionMode {
  return typeof value === 'string' && (AGENT_PERMISSION_MODES as readonly string[]).includes(value)
}

export interface AgentModelRef {
  id: string
  providerId?: string
}

export interface AgentEffortOption {
  id: string
  label: string
  description?: string
  isDefault?: boolean
}

export interface AgentModelOption {
  model: AgentModelRef
  label: string
  description?: string
  isDefault?: boolean
  efforts: AgentEffortOption[]
}

export interface AgentPermissionOption {
  id: AgentPermissionMode
  label: string
  description: string
}

export interface AgentRunControlCatalog {
  models: AgentModelOption[]
  permissions: AgentPermissionOption[]
}

export interface AgentRunControls {
  model?: AgentModelRef
  effort?: string
  permissionMode: AgentPermissionMode
}

export type AgentForceKillScope = 'run_scoped' | 'shared_transport'

export type AgentStopPhase =
  | 'interrupt_requested'
  | 'interrupt_request_failed'
  | 'force_kill_requested'
  | 'no_safe_force_kill'
  | 'provider_unsettled'
  | 'settled'

export interface AgentStopEscalationWindow {
  gracefulMs: number
  forceKillMs: number
}

export interface AgentStopState {
  runId: string
  providerId: ProviderId
  runtimeProvider: RuntimeProvider
  agentProfileId?: string
  phase: AgentStopPhase
  requestedAt: string
  updatedAt: string
  forceKillBlockReason?: 'shared_transport' | 'scope_unavailable' | 'force_kill_failed'
  providerSettled: boolean
  window: AgentStopEscalationWindow
}

export interface AgentForkLastTurn {
  replaceRunId: string
  replaceProviderTurnId: string
  replaceForkTurnId: string
  previousProviderTurnId?: string
  previousForkTurnId?: string
}

export interface AgentRestartLastTurn {
  replaceRunId: string
}

export interface AgentForkSessionRequest {
  providerId: ProviderId
  agentProfileId?: string
  cwd?: string
  sourceSessionId: string
  sourceRunId: string
  sourceProviderTurnId: string
  sourceForkTurnId: string
  model?: AgentModelRef
  permissionMode?: AgentPermissionMode
}

export interface AgentForkSessionResult {
  externalSessionId: string
}

export interface AgentStartResult {
  runId: string
  commandStatus?: 'executed' | 'duplicate'
  commandSequence?: number
  externalSessionId?: string
  workspace?: PreparedWorkspace
}

export interface AgentStartRequest {
  prompt: string
  workspace?: WorkspaceStartSelection
  commandId?: string
  cwd?: string
  networkLabel?: string
  expectedExternalSessionId?: string | null
  forkLastTurn?: AgentForkLastTurn
  restartLastTurn?: AgentRestartLastTurn
  providerId?: ProviderId
  agentId?: string
  agentProfileId?: string
  backend?: RuntimeBackend
  runtimeProvider?: RuntimeProvider
  attachments?: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode?: AgentPermissionMode
}
export type AgentSteerCapability =
  | { status: 'available'; attachments: boolean }
  | { status: 'unavailable'; reason: string }

export interface AgentSteerInput {
  messageId: string
  prompt: string
  attachments: AgentInputAttachment[]
}

export interface AgentSteerRequest extends AgentSteerInput {
  runId: string
  providerId: ProviderId
  agentProfileId?: string
  cwd?: string
  expectedExternalSessionId: string
}

export type AgentSteerResult =
  | { status: 'accepted'; providerTurnId?: string }
  | { status: 'rejected' | 'unavailable' | 'unknown'; message: string }

export interface AgentSteerEvidence extends AgentSteerInput {
  status: 'pending' | AgentSteerResult['status']
  message?: string
  providerTurnId?: string
}

export interface AgentQuestionOption {
  label: string
  description: string
  preview?: string
  answerValue?: string
}

export interface AgentQuestionPrompt {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  warning?: string
  placeholder?: string
  inputMode?: 'singleline' | 'multiline'
  allowCustomAnswer?: boolean
  initialValue?: string
}

export type AgentQuestionKind = 'clarification' | 'permission'

export interface AgentQuestionRequest {
  runId: string
  questionId: string
  providerId?: ProviderId
  agentId?: string
  questionKind?: AgentQuestionKind
  source?: string
  questions: AgentQuestionPrompt[]
}

export type AgentQuestionResponse =
  | {
      runId: string
      questionId: string
      behavior: 'answered'
      answers: Record<string, string>
      nativeCustomAnswer?: true
      nativeCustomAnswers?: string[]
    }
  | {
      runId: string
      questionId: string
      behavior: 'cancelled'
    }

export interface AgentIntervention {
  kind: AgentQuestionKind
  source: string
  resolution: 'answered' | 'user_cancelled' | 'provider_cancelled'
  request: AgentQuestionRequest
  response: AgentQuestionResponse
  openedAt: string
  closedAt: string
  durationMs: number
}

export interface NormalizedAgentStartRequest {
  prompt: string
  workspace?: WorkspaceStartSelection
  commandId?: string
  cwd?: string
  networkLabel?: string
  expectedExternalSessionId?: string | null
  forkLastTurn?: AgentForkLastTurn
  restartLastTurn?: AgentRestartLastTurn
  providerId: ProviderId
  agentId: string
  agentProfileId?: string
  backend: RuntimeBackend
  runtimeProvider?: RuntimeProvider
  attachments: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode: AgentPermissionMode
}

export type AgentImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export interface AgentInputAttachment {
  kind: 'image'
  name: string
  mimeType: AgentImageMimeType
  dataBase64: string
  size?: number
  width?: number
  height?: number
  path?: string
}

export interface RuntimeFailureBrief {
  provider: RuntimeProvider
  stage: RuntimeFailureStage
  commandSummary?: string
  cwd?: string
  exitCode?: number | null
  signal?: string | null
  timeoutMs?: number
  transportCode?: string
  requestMethod?: string
  requestPath?: string
  httpStatus?: number
  evidencePath?: string
  nextAction: string
}

export interface RuntimeObservedMcpServer {
  name: string
  status: string
  serverName?: string
  serverVersion?: string
  tools?: number
}

export interface RuntimeCapabilityWarning {
  kind: 'mcp' | 'skill'
  runtimeProvider: RuntimeProvider
  name: string
  reason: string
  expected?: string
  observed?: string
  evidence?: string
}

export type RuntimeFileOpConfidence = 'stream' | 'diff' | 'heuristic'

export type AgentRuntimeEvent =
  | {
      kind: 'session_started'
      runtimeProvider: RuntimeProvider
      externalSessionId?: string
      model?: string
      mcpServers?: RuntimeObservedMcpServer[]
    }
  | { kind: 'text_delta'; delta: string }
  | { kind: 'thinking_delta'; delta: string }
  | { kind: 'tool_call'; id?: string; tool: string; input?: unknown; mcpServer?: string }
  | { kind: 'tool_result'; id?: string; output?: unknown; isError?: boolean }
  | { kind: 'file_op'; op: 'read' | 'write' | 'edit'; path: string; confidence: RuntimeFileOpConfidence }
  | { kind: 'usage'; usage?: unknown; costUsd?: number | null; modelUsage?: unknown; durationMs?: number; stopReason?: string; isError?: boolean }
  | { kind: 'raw'; line: string }
  | { kind: 'done'; exitCode?: number; stopReason?: string }
