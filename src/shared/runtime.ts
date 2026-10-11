import type { ProviderId } from './provider.js'
import { maskSecrets } from './trace.js'

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

export function classifyRunTermination(evidence: RunTerminationEvidence): RunTerminationReason | undefined {
  const rawReason = typeof evidence.rawReason === 'string' ? evidence.rawReason.trim().toLowerCase() : ''
  const subtype = typeof evidence.subtype === 'string' ? evidence.subtype.trim().toLowerCase() : ''
  const message = typeof evidence.message === 'string' ? evidence.message.trim().toLowerCase() : ''
  const combined = [rawReason, subtype, message].filter(Boolean).join('\n')

  if (combined.includes('model_context_window_exceeded')) return 'model_context_window_exceeded'
  if (
    rawReason === 'max_tokens' ||
    rawReason === 'max_output_tokens' ||
    rawReason === 'length' ||
    /(?:finish_reason|stop_reason|incomplete_details)[^\n]*(?:length|max_(?:output_)?tokens)/.test(combined) ||
    /(?:response|output)[^\n]*(?:cut off|truncat|reached)[^\n]*(?:token|length)[^\n]*(?:limit|maximum)?/.test(combined) ||
    /(?:response|output)[^\n]*(?:token|length)[^\n]*(?:limit|maximum)[^\n]*(?:exceed|hit|reached)/.test(combined)
  ) return 'output_token_limit'
  if (subtype === 'error_max_turns' || /\bmax(?:imum)?[ _-]?turns?\b/.test(combined)) return 'max_turns'
  if (subtype === 'error_max_budget_usd' || /\b(?:max(?:imum)?[ _-]?)?budget(?:_usd)?\b[^\n]*(?:exceed|limit|reached)/.test(combined)) {
    return 'budget_exceeded'
  }
  if (
    /context_length_exceeded|context[ _-]?overflow/.test(combined) ||
    /\bhttp[_ -]?413\b|payload too large|request entity too large/.test(combined) ||
    /prompt[^\n]*(?:is )?too long/.test(combined) ||
    /input[^\n]*(?:too long|exceed)[^\n]*(?:context|token)/.test(combined) ||
    /(?:prompt|input)[^\n]*(?:context|token)[^\n]*(?:limit|maximum)[^\n]*(?:exceed|reached)/.test(combined) ||
    /maximum context length/.test(combined)
  ) return 'input_context_overflow'
  return undefined
}

export function runTerminationHint(reason: RunTerminationReason): string {
  if (reason === 'input_context_overflow') return '上下文超过模型窗口：精简或 compact 后重试，也可以新建会话'
  if (reason === 'output_token_limit') return '输出达到上限，结果可能不完整：继续生成，或要求更短的回答'
  if (reason === 'model_context_window_exceeded') return '输出耗尽模型上下文窗口，结果可能不完整：精简上下文后继续'
  if (reason === 'max_turns') return '已达到 Agent 最大轮数：继续当前会话，或缩小任务范围后重试'
  return '已达到本轮预算上限：调整预算或缩小任务范围后重试'
}

export function runTerminationLabel(reason: RunTerminationReason): string {
  if (reason === 'input_context_overflow') return '上下文已超限'
  if (reason === 'output_token_limit') return '输出已截断'
  if (reason === 'model_context_window_exceeded') return '上下文窗口已耗尽'
  if (reason === 'max_turns') return '已达最大轮数'
  return '已达预算上限'
}

export function isIncompleteRunTermination(reason: RunTerminationReason): boolean {
  return reason === 'output_token_limit' || reason === 'model_context_window_exceeded'
}

export type AgentPermissionMode = 'default' | 'auto_review' | 'full_access'

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

export interface AgentStartRequest {
  prompt: string
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

export function normalizeAgentSteerRequest(payload: unknown): AgentSteerRequest {
  if (!payload || typeof payload !== 'object') throw new Error('Steer 请求格式无效')
  const value = payload as Partial<AgentSteerRequest>
  const runId = boundedControlValue(value.runId)
  const messageId = boundedControlValue(value.messageId)
  const sessionId = boundedControlValue(value.expectedExternalSessionId)
  if (!runId || !messageId || !/^[A-Za-z0-9_-]{1,80}$/.test(messageId) || !sessionId) {
    throw new Error('Steer 缺少可信 run、消息或会话身份')
  }
  if (!['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(value.providerId ?? '')) {
    throw new Error('Steer Provider 无效')
  }
  if (value.agentProfileId !== undefined && !boundedControlValue(value.agentProfileId)) throw new Error('Steer profile 无效')
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !value.cwd.trim())) throw new Error('Steer 工作目录无效')
  if (typeof value.prompt !== 'string' || !Array.isArray(value.attachments)) throw new Error('Steer 消息格式无效')
  const attachments = normalizeAgentAttachments(value.attachments).map(({ path: _path, ...attachment }) => attachment)
  if (attachments.length !== value.attachments.length) throw new Error('Steer 附件无效，消息未发送')
  if (!value.prompt.trim() && attachments.length === 0) throw new Error('Steer 消息为空')
  return {
    runId, messageId, expectedExternalSessionId: sessionId,
    providerId: value.providerId!,
    ...(value.agentProfileId ? { agentProfileId: value.agentProfileId } : {}),
    ...(value.cwd ? { cwd: value.cwd } : {}),
    prompt: value.prompt,
    attachments
  }
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

export function runtimeProviderForAgentId(agentId: string | undefined): RuntimeProvider | undefined {
  if (!agentId || agentId === 'claude') return 'claude_sdk'
  if (agentId === 'codex') return 'codex_cli'
  if (agentId === 'qoder') return 'qoder_cli'
  if (agentId === 'opencode') return 'opencode_server'
  if (agentId === 'pi' || agentId.startsWith('pi:')) return 'pi_rpc'
  return undefined
}

export function providerIdForAgentId(agentId: string | undefined): ProviderId | undefined {
  if (!agentId) return undefined
  if (agentId === 'claude') return 'claude'
  if (agentId === 'codex' || agentId === 'qoder' || agentId === 'opencode') return agentId
  if (agentId === 'pi' || agentId.startsWith('pi:')) return 'pi'
  return undefined
}

export function providerIdForRuntime(runtimeProvider: RuntimeProvider): ProviderId {
  if (runtimeProvider === 'codex_cli') return 'codex'
  if (runtimeProvider === 'qoder_cli') return 'qoder'
  if (runtimeProvider === 'opencode_server') return 'opencode'
  if (runtimeProvider === 'pi_rpc') return 'pi'
  return 'claude'
}

export function runtimeProviderForProviderId(providerId: ProviderId): RuntimeProvider {
  if (providerId === 'codex') return 'codex_cli'
  if (providerId === 'qoder') return 'qoder_cli'
  if (providerId === 'opencode') return 'opencode_server'
  if (providerId === 'pi') return 'pi_rpc'
  return 'claude_sdk'
}

export function normalizeAgentStartRequest(payload: AgentStartRequest): NormalizedAgentStartRequest {
  const explicitAgentId = payload.agentId?.trim()
  const mappedProviderId = providerIdForAgentId(explicitAgentId)
  if (explicitAgentId && !mappedProviderId && !payload.providerId) {
    throw new Error(`agent=${explicitAgentId} 尚未注册 Provider adapter`)
  }
  if (payload.providerId && mappedProviderId && payload.providerId !== mappedProviderId) {
    throw new Error(`provider=${payload.providerId} 与 agent=${explicitAgentId} 不匹配`)
  }
  const providerId = payload.providerId ?? mappedProviderId ?? 'claude'
  const agentId = explicitAgentId ?? providerId
  const agentProfileId = boundedControlValue(payload.agentProfileId) ??
    (providerId === 'pi' && explicitAgentId?.startsWith('pi:') ? explicitAgentId : undefined)
  if (providerId === 'pi' && !agentProfileId) {
    throw new Error('Pi Provider 缺少 agentProfileId')
  }
  const expectedRuntime = runtimeProviderForProviderId(providerId)
  const modelId = boundedControlValue(payload.model?.id)
  const modelProviderId = boundedControlValue(payload.model?.providerId)
  const effort = boundedControlValue(payload.effort)
  if (payload.networkLabel !== undefined && (typeof payload.networkLabel !== 'string' || payload.networkLabel.trim().length > 80)) {
    throw new Error('网络标签必须是最多 80 个字符的文本')
  }
  const networkLabel = payload.networkLabel?.trim()
  const permissionMode = payload.permissionMode ?? 'default'
  if (!['default', 'auto_review', 'full_access'].includes(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  const replaceRunId = boundedControlValue(payload.forkLastTurn?.replaceRunId)
  const replaceProviderTurnId = boundedControlValue(payload.forkLastTurn?.replaceProviderTurnId)
  const replaceForkTurnId = boundedControlValue(payload.forkLastTurn?.replaceForkTurnId)
  const previousProviderTurnId = boundedControlValue(payload.forkLastTurn?.previousProviderTurnId)
  const previousForkTurnId = boundedControlValue(payload.forkLastTurn?.previousForkTurnId)
  const restartReplaceRunId = boundedControlValue(payload.restartLastTurn?.replaceRunId)
  if (payload.forkLastTurn && payload.restartLastTurn) {
    throw new Error('编辑最后一条消息不能同时请求分支与重新开始')
  }
  if (payload.forkLastTurn && (!replaceRunId || !replaceProviderTurnId || !replaceForkTurnId || typeof payload.expectedExternalSessionId !== 'string')) {
    throw new Error('编辑最后一条消息缺少可信会话或轮次边界')
  }
  if (payload.restartLastTurn && (!restartReplaceRunId || typeof payload.expectedExternalSessionId !== 'string')) {
    throw new Error('重新编辑首轮消息缺少可信会话或 run 边界')
  }
  return {
    prompt: payload.prompt,
    ...(networkLabel ? { networkLabel } : {}),
    ...(typeof payload.cwd === 'string' && payload.cwd.trim() ? { cwd: payload.cwd } : {}),
    ...(payload.expectedExternalSessionId === null
      ? { expectedExternalSessionId: null }
      : typeof payload.expectedExternalSessionId === 'string' && payload.expectedExternalSessionId
        ? { expectedExternalSessionId: payload.expectedExternalSessionId }
        : {}),
    ...(replaceRunId && replaceProviderTurnId && replaceForkTurnId ? {
      forkLastTurn: {
        replaceRunId,
        replaceProviderTurnId,
        replaceForkTurnId,
        ...(previousProviderTurnId ? { previousProviderTurnId } : {}),
        ...(previousForkTurnId ? { previousForkTurnId } : {})
      }
    } : {}),
    ...(restartReplaceRunId ? { restartLastTurn: { replaceRunId: restartReplaceRunId } } : {}),
    providerId,
    agentId,
    ...(agentProfileId ? { agentProfileId } : {}),
    backend: payload.backend ?? 'local',
    runtimeProvider: payload.runtimeProvider ?? expectedRuntime,
    attachments: normalizeAgentAttachments(payload.attachments),
    ...(modelId ? { model: { id: modelId, ...(modelProviderId ? { providerId: modelProviderId } : {}) } } : {}),
    ...(effort ? { effort } : {}),
    permissionMode
  }
}

function boundedControlValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text && text.length <= 240 ? text : undefined
}

export function normalizeAgentForkSessionRequest(payload: unknown): AgentForkSessionRequest {
  if (!payload || typeof payload !== 'object') throw new Error('创建分支请求格式无效')
  const value = payload as Partial<AgentForkSessionRequest>
  const providerId = boundedControlValue(value.providerId)
  const agentProfileId = boundedControlValue(value.agentProfileId)
  const sourceSessionId = boundedControlValue(value.sourceSessionId)
  const sourceRunId = boundedControlValue(value.sourceRunId)
  const sourceProviderTurnId = boundedControlValue(value.sourceProviderTurnId)
  const sourceForkTurnId = boundedControlValue(value.sourceForkTurnId)
  const modelId = boundedControlValue(value.model?.id)
  const modelProviderId = boundedControlValue(value.model?.providerId)
  const permissionMode = value.permissionMode ?? 'default'
  if (!providerId || !['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(providerId)) {
    throw new Error('当前 Provider 不支持从指定轮次创建分支')
  }
  if (!sourceSessionId || !sourceRunId || !sourceProviderTurnId || !sourceForkTurnId) {
    throw new Error('创建分支缺少可信会话或轮次边界')
  }
  if (!['default', 'auto_review', 'full_access'].includes(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  if (providerId === 'pi' && !agentProfileId) throw new Error('Pi 分支缺少 agentProfileId')
  return {
    providerId: providerId as ProviderId,
    ...(agentProfileId ? { agentProfileId } : {}),
    ...(typeof value.cwd === 'string' && value.cwd.trim() ? { cwd: value.cwd } : {}),
    sourceSessionId,
    sourceRunId,
    sourceProviderTurnId,
    sourceForkTurnId,
    ...(modelId ? { model: { id: modelId, ...(modelProviderId ? { providerId: modelProviderId } : {}) } } : {}),
    permissionMode
  }
}

export type AgentPermissionDecision = 'once' | 'session' | 'reject'

type PermissionSuggestion = {
  type: string
  destination: string
  behavior?: string
  rules?: Array<{ toolName: string; ruleContent?: string }>
}

export function exactSessionPermissionSuggestions<T extends PermissionSuggestion>(
  suggestions: readonly T[] | undefined
): Array<T & {
  type: 'addRules'
  destination: 'session'
  behavior: 'allow'
  rules: Array<{ toolName: string; ruleContent: string }>
}> {
  return (suggestions ?? []).filter((suggestion): suggestion is T & {
    type: 'addRules'
    destination: 'session'
    behavior: 'allow'
    rules: Array<{ toolName: string; ruleContent: string }>
  } => suggestion.destination === 'session'
    && suggestion.type === 'addRules'
    && suggestion.behavior === 'allow'
    && Array.isArray(suggestion.rules)
    && suggestion.rules.length > 0
    && suggestion.rules.every((rule) => {
      const toolName = typeof rule?.toolName === 'string' ? rule.toolName.trim() : ''
      const ruleContent = typeof rule?.ruleContent === 'string' ? rule.ruleContent.trim() : ''
      return Boolean(toolName && ruleContent && !toolName.includes('*') && !ruleContent.includes('*'))
    }))
}

export const MAX_AGENT_PERMISSION_SESSION_DESCRIPTION_LENGTH = 1_200

export function exactSessionPermissionDescription(
  suggestions: ReadonlyArray<{ rules: ReadonlyArray<{ toolName: string; ruleContent: string }> }>
): string | undefined {
  const rules = suggestions.flatMap((suggestion) => suggestion.rules)
  if (rules.length === 0) return undefined
  const details = rules.map((rule) => {
    const toolName = maskSecrets(rule.toolName)?.replace(/\s+/g, ' ').trim() ?? ''
    const ruleContent = maskSecrets(rule.ruleContent)?.replace(/\s+/g, ' ').trim() ?? ''
    return `• ${toolName} → ${ruleContent}`
  })
  const description = `仅在当前 Provider 运行内允许 ${rules.length} 条精确规则：\n${details.join('\n')}`
  return description.length <= MAX_AGENT_PERMISSION_SESSION_DESCRIPTION_LENGTH ? description : undefined
}

export function agentPermissionQuestion(
  runId: string,
  questionId: string,
  header: string,
  question: string,
  description: string,
  allowSession = true,
  source = 'permission_request',
  sessionDescription = '允许这类操作直到当前原生会话结束'
): AgentQuestionRequest {
  return {
    runId,
    questionId,
    questionKind: 'permission',
    source,
    questions: [{
      header,
      question,
      multiSelect: false,
      options: [
        { label: '允许一次', description },
        ...(allowSession ? [{ label: '本次会话允许', description: sessionDescription }] : []),
        { label: '拒绝', description: '拒绝本次操作并让 Agent 继续处理结果' }
      ]
    }]
  }
}

export function agentPermissionDecision(
  request: AgentQuestionRequest,
  response: AgentQuestionResponse
): AgentPermissionDecision {
  if (response.behavior === 'cancelled') return 'reject'
  const answer = response.answers[request.questions[0]?.question ?? '']
  if (answer === '本次会话允许') return 'session'
  return answer === '允许一次' ? 'once' : 'reject'
}

export function isSupportedImageMimeType(value: string): value is AgentImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp'
}

export function decodedBase64ByteLength(value: string): number | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact || compact.length % 4 !== 0) return null
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  for (let index = 0; index < compact.length - padding; index++) {
    const code = compact.charCodeAt(index)
    const alphaNumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    if (!alphaNumeric && code !== 43 && code !== 47) return null
  }
  for (let index = compact.length - padding; index < compact.length; index++) {
    if (compact.charCodeAt(index) !== 61) return null
  }
  return (compact.length / 4) * 3 - padding
}

export function normalizeAgentAttachments(value: unknown): AgentInputAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments = value
    .filter((item): item is AgentInputAttachment => {
      if (!item || typeof item !== 'object') return false
      const a = item as Partial<AgentInputAttachment>
      return (
        a.kind === 'image' &&
        typeof a.name === 'string' &&
        isSupportedImageMimeType(String(a.mimeType ?? '')) &&
        typeof a.dataBase64 === 'string' &&
        decodedBase64ByteLength(a.dataBase64) != null
      )
    })
    .map<AgentInputAttachment>((a) => ({
      kind: 'image',
      name: a.name || 'pasted-image',
      mimeType: a.mimeType,
      dataBase64: a.dataBase64,
      size: decodedBase64ByteLength(a.dataBase64)!,
      width: typeof a.width === 'number' ? a.width : undefined,
      height: typeof a.height === 'number' ? a.height : undefined,
      path: typeof a.path === 'string' ? a.path : undefined
    }))
  return attachments
}

function exactBoundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  if (!value.trim() || value.length > max) return null
  return value
}

function boundedAnswer(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= max ? text : null
}

export function normalizeAgentQuestionRequest(
  runId: string,
  questionId: string,
  input: unknown,
  agentId?: string,
  source = 'AskUserQuestion',
  allowFreeText = false
): AgentQuestionRequest | null {
  if (!runId || !questionId || !input || typeof input !== 'object') return null
  const rawQuestions = (input as { questions?: unknown }).questions
  const nativeLimit = allowFreeText ? 100 : 4
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > nativeLimit) return null
  const questions: AgentQuestionPrompt[] = []
  const seen = new Set<string>()
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    const question = exactBoundedText(value.question, 2_000)
    const header = exactBoundedText(value.header, 120)
    if (!question || !header || seen.has(question) || !Array.isArray(value.options)) return null
    if (value.options.length > nativeLimit || (!allowFreeText && value.options.length < 2)) return null
    const options: AgentQuestionOption[] = []
    for (const rawOption of value.options) {
      if (!rawOption || typeof rawOption !== 'object') return null
      const option = rawOption as Record<string, unknown>
      const label = exactBoundedText(option.label, 240)
      const description = exactBoundedText(option.description, 4_000)
      if (!label || !description || options.some((candidate) => candidate.label === label)) return null
      const preview = exactBoundedText(option.preview, 20_000)
      const answerValue = exactBoundedText(option.answerValue, 240)
      options.push({
        label,
        description,
        ...(preview ? { preview } : {}),
        ...(answerValue ? { answerValue } : {})
      })
    }
    const placeholder = typeof value.placeholder === 'string' && value.placeholder.length <= 500
      ? value.placeholder
      : undefined
    const inputMode = value.inputMode === 'multiline' ? 'multiline' : value.inputMode === 'singleline' ? 'singleline' : undefined
    if (allowFreeText && inputMode && typeof value.initialValue === 'string' && value.initialValue.length > 100_000) return null
    seen.add(question)
    questions.push({
      question,
      header,
      options,
      multiSelect: value.multiSelect === true,
      ...(value.allowCustomAnswer === false ? { allowCustomAnswer: false } : {}),
      ...(placeholder ? { placeholder } : {}),
      ...(inputMode ? { inputMode } : {}),
      ...(allowFreeText && inputMode && typeof value.initialValue === 'string'
        ? { initialValue: value.initialValue } : {})
    })
  }
  return {
    runId,
    questionId,
    ...(agentId ? { agentId } : {}),
    questionKind: 'clarification',
    source,
    questions
  }
}

export function normalizeAgentQuestionResponse(
  request: AgentQuestionRequest,
  value: unknown
): AgentQuestionResponse | null {
  if (!value || typeof value !== 'object') return null
  const response = value as Record<string, unknown>
  if (response.runId !== request.runId || response.questionId !== request.questionId) return null
  if (response.behavior === 'cancelled') {
    return { runId: request.runId, questionId: request.questionId, behavior: 'cancelled' }
  }
  if (response.behavior !== 'answered' || !response.answers || typeof response.answers !== 'object') return null
  if (response.nativeCustomAnswer !== undefined && (
    response.nativeCustomAnswer !== true || request.providerId !== 'pi' || request.source !== 'pi_extension_ui:select' ||
    request.questions.length !== 1 || request.questions[0].allowCustomAnswer === false
  )) return null
  const rawAnswers = response.answers as Record<string, unknown>
  const answers: Record<string, string> = {}
  for (const question of request.questions) {
    const answer = boundedAnswer(rawAnswers[question.question], question.inputMode === 'multiline' ? 100_000 : 4_000)
    if (!answer) return null
    if (question.allowCustomAnswer === false && !question.options.some((option) => (option.answerValue ?? option.label) === answer)) return null
    answers[question.question] = answer
  }
  return {
    runId: request.runId, questionId: request.questionId, behavior: 'answered', answers,
    ...(response.nativeCustomAnswer === true ? { nativeCustomAnswer: true } : {})
  }
}
