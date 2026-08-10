import type { ProviderId } from './provider.js'
import { maskSecrets } from './trace.js'

export type RuntimeBackend = 'local' | 'api'
export type RuntimeProvider = 'claude_sdk' | 'codex_cli' | 'qoder_cli' | 'opencode_server'

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

export interface AgentStartRequest {
  prompt: string
  cwd?: string
  expectedExternalSessionId?: string | null
  providerId?: ProviderId
  agentId?: string
  backend?: RuntimeBackend
  runtimeProvider?: RuntimeProvider
  attachments?: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode?: AgentPermissionMode
}

export interface AgentQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AgentQuestionPrompt {
  question: string
  header: string
  options: AgentQuestionOption[]
  multiSelect: boolean
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
  expectedExternalSessionId?: string | null
  providerId: ProviderId
  agentId: string
  backend: RuntimeBackend
  runtimeProvider?: RuntimeProvider
  attachments: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode: AgentPermissionMode
}

export type AgentImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

export const MAX_AGENT_ATTACHMENTS = 8
export const MAX_AGENT_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_AGENT_ATTACHMENTS_TOTAL_BYTES = 24 * 1024 * 1024

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
  return undefined
}

export function providerIdForAgentId(agentId: string | undefined): ProviderId | undefined {
  if (!agentId) return undefined
  if (agentId === 'claude') return 'claude'
  if (agentId === 'codex' || agentId === 'qoder' || agentId === 'opencode') return agentId
  return undefined
}

export function providerIdForRuntime(runtimeProvider: RuntimeProvider): ProviderId {
  if (runtimeProvider === 'codex_cli') return 'codex'
  if (runtimeProvider === 'qoder_cli') return 'qoder'
  if (runtimeProvider === 'opencode_server') return 'opencode'
  return 'claude'
}

export function runtimeProviderForProviderId(providerId: ProviderId): RuntimeProvider {
  if (providerId === 'codex') return 'codex_cli'
  if (providerId === 'qoder') return 'qoder_cli'
  if (providerId === 'opencode') return 'opencode_server'
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
  const expectedRuntime = runtimeProviderForProviderId(providerId)
  const modelId = boundedControlValue(payload.model?.id)
  const modelProviderId = boundedControlValue(payload.model?.providerId)
  const effort = boundedControlValue(payload.effort)
  const permissionMode = payload.permissionMode ?? 'default'
  if (!['default', 'auto_review', 'full_access'].includes(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  return {
    prompt: payload.prompt,
    ...(typeof payload.cwd === 'string' && payload.cwd.trim() ? { cwd: payload.cwd } : {}),
    ...(payload.expectedExternalSessionId === null
      ? { expectedExternalSessionId: null }
      : typeof payload.expectedExternalSessionId === 'string' && payload.expectedExternalSessionId
        ? { expectedExternalSessionId: payload.expectedExternalSessionId }
        : {}),
    providerId,
    agentId,
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
  if (attachments.length > MAX_AGENT_ATTACHMENTS) {
    throw new Error(`图片附件最多 ${MAX_AGENT_ATTACHMENTS} 张`)
  }
  let totalBytes = 0
  for (const attachment of attachments) {
    if ((attachment.size ?? 0) > MAX_AGENT_ATTACHMENT_BYTES) {
      throw new Error(`图片 ${attachment.name} 超过 10 MiB 上限`)
    }
    totalBytes += attachment.size ?? 0
  }
  if (totalBytes > MAX_AGENT_ATTACHMENTS_TOTAL_BYTES) {
    throw new Error('图片附件总大小超过 24 MiB 上限')
  }
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
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 4) return null
  const questions: AgentQuestionPrompt[] = []
  const seen = new Set<string>()
  for (const raw of rawQuestions) {
    if (!raw || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    const question = exactBoundedText(value.question, 2_000)
    const header = exactBoundedText(value.header, 120)
    if (!question || !header || seen.has(question) || !Array.isArray(value.options)) return null
    if (value.options.length > 4 || (!allowFreeText && value.options.length < 2)) return null
    const options: AgentQuestionOption[] = []
    for (const rawOption of value.options) {
      if (!rawOption || typeof rawOption !== 'object') return null
      const option = rawOption as Record<string, unknown>
      const label = exactBoundedText(option.label, 240)
      const description = exactBoundedText(option.description, 4_000)
      if (!label || !description || options.some((candidate) => candidate.label === label)) return null
      const preview = exactBoundedText(option.preview, 20_000)
      options.push({ label, description, ...(preview ? { preview } : {}) })
    }
    seen.add(question)
    questions.push({ question, header, options, multiSelect: value.multiSelect === true })
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
  const rawAnswers = response.answers as Record<string, unknown>
  const answers: Record<string, string> = {}
  for (const question of request.questions) {
    const answer = boundedAnswer(rawAnswers[question.question], 4_000)
    if (!answer) return null
    answers[question.question] = answer
  }
  return { runId: request.runId, questionId: request.questionId, behavior: 'answered', answers }
}
