import type { ProviderId } from './provider.js'
import type { PreparedWorkspace, WorkspaceStartSelection } from './workspace-selection.js'

export type AgentDataUpdated =
  | { runId: string; kind?: 'turn_recorded' | 'session_deleted' }
  | { kind: 'conversation_changed'; conversationId: string }
  // Background catalog recovery added sessions after the project list was already read.
  | { kind: 'catalog_recovered' }

export type RuntimeBackend = 'local' | 'api'
export type RuntimeProvider = 'claude_sdk' | 'codex_cli' | 'qoder_cli' | 'opencode_server' | 'pi_rpc'

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

export type RunTerminationReason =
  | 'input_context_overflow'
  | 'output_token_limit'
  | 'model_context_window_exceeded'
  | 'max_turns'
  | 'budget_exceeded'

export interface RunTerminationEvidence {
  rawReason?: unknown
  subtype?: unknown
  message?: unknown
}

/**
 * 审批档位。四档是语义栈升：默认全部问 → 只自动放行文件编辑 → 交给 Provider 原生
 * 审查器 → 不再审批。没有原生等价语义的 Provider **不得静默降档**，必须不提供该
 * 选项并在收到时显式报错（见各 adapter）。默认值永远是 `default`。
 */
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

/**
 * 硬杀（forceKill）的真实作用范围。它是 Provider transport 的事实，不是偏好：
 * - run_scoped：硬杀只会终止这一个 run 自己持有的进程/连接。
 * - shared_transport：transport 由同一 cwd 的其他并发 run 复用（Codex app-server client、
 *   OpenCode server），硬杀会连带终止无关 run，因此自动升级不允许发出它。
 */
export type AgentForceKillScope = 'run_scoped' | 'shared_transport'

/**
 * 停止请求的真实进度。它描述 Scry 对 Provider 做了什么以及拿到了什么证据，
 * 不代表「这一轮已经结束」——只有 Provider runtime 真正 settle 才是终止证据。
 * - interrupt_requested：已发出协作式取消，等待 Provider 收口。
 * - force_kill_requested：优雅窗口耗尽，已升级到 run-scoped forceKill，仍在等待 settle。
 * - no_safe_force_kill：优雅窗口耗尽，但硬杀只能作用于共享 transport，会波及无关 run；
 *   Scry 没有发出硬杀，这一轮的终止仍然未被 Provider 确认。
 * - provider_unsettled：forceKill 窗口也耗尽，Provider 未确认终止（可能仍在后台运行）。
 * - settled：Provider runtime 已 settle，终止有证据。
 */
export type AgentStopPhase =
  | 'interrupt_requested'
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
  /** no_safe_force_kill 的事实原因，避免把「共享 transport」「句柄未建立」和「硬杀调用失败」混为一谈。 */
  forceKillBlockReason?: 'shared_transport' | 'scope_unavailable' | 'force_kill_failed'
  /** Provider runtime 是否已 settle。与 phase 分开保存，避免把「已请求」读成「已终止」。 */
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
  externalSessionId?: string
  workspace?: PreparedWorkspace
}

export interface AgentStartRequest {
  prompt: string
  workspace?: WorkspaceStartSelection
  /**
   * 调用方自带的命令标识。给了它，这条启动命令就是幂等的：重投只会拿回同一个 runId，
   * 不会起第二轮。不给表示调用方不要求幂等。
   */
  commandId?: string
  cwd?: string
  /** Manual comparison label; never changes network configuration. */
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

/** Acceptance means native admission, not that the model has followed the message. */
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
  /** Provider-specific value returned when the visible option is selected. */
  answerValue?: string
}

export interface AgentQuestionPrompt {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiSelect: boolean
  /**
   * Provider 自己给出的风险说明（例如 Claude 的 decisionReason、被拦下的路径）。
   * 只有 Provider 真的给了理由才会出现：缺省表示「Provider 没说明原因」，
   * 不得由 Scry 编造一条看起来像风险评估的文案。
   */
  warning?: string
  /** Optional input hint for provider-native free-text prompts. */
  placeholder?: string
  /** Native input/editor requests have no synthetic choice list. */
  inputMode?: 'singleline' | 'multiline'
  /** False for native closed-choice dialogs that only accept one listed value. */
  allowCustomAnswer?: boolean
  /** Provider-native editor content, kept separate from its placeholder. */
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
      /** Pi's single select → input answer is text, even when it equals a listed value. */
      nativeCustomAnswer?: true
      /**
       * Pi questionnaire replies use option values, with custom text for the listed questions.
       * Absent on legacy clients that submit option labels instead.
       */
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
