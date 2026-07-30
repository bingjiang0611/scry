import type { BillingProvider } from './billing.js'
import type { ProviderId } from './provider.js'

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

export interface AgentQuestionRequest {
  runId: string
  questionId: string
  providerId?: ProviderId
  agentId?: string
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

export interface NormalizedAgentStartRequest {
  prompt: string
  cwd?: string
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

export function billingProviderForRuntime(runtimeProvider: RuntimeProvider): BillingProvider | undefined {
  if (runtimeProvider === 'codex_cli') return 'codex'
  if (runtimeProvider === 'qoder_cli') return 'qoder'
  if (runtimeProvider === 'opencode_server') return undefined
  return 'anthropic'
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
  const permissionMode = payload.permissionMode ?? 'full_access'
  if (!['default', 'auto_review', 'full_access'].includes(permissionMode)) {
    throw new Error(`permissionMode=${String(permissionMode)} 不受支持`)
  }
  return {
    prompt: payload.prompt,
    ...(typeof payload.cwd === 'string' && payload.cwd.trim() ? { cwd: payload.cwd } : {}),
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

export function agentPermissionQuestion(
  runId: string,
  questionId: string,
  header: string,
  question: string,
  description: string,
  allowSession = true
): AgentQuestionRequest {
  return {
    runId,
    questionId,
    questions: [{
      header,
      question,
      multiSelect: false,
      options: [
        { label: '允许一次', description },
        ...(allowSession ? [{ label: '本次会话允许', description: '允许这类操作直到当前原生会话结束' }] : []),
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

export function normalizeAgentAttachments(value: unknown): AgentInputAttachment[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is AgentInputAttachment => {
      if (!item || typeof item !== 'object') return false
      const a = item as Partial<AgentInputAttachment>
      return (
        a.kind === 'image' &&
        typeof a.name === 'string' &&
        isSupportedImageMimeType(String(a.mimeType ?? '')) &&
        typeof a.dataBase64 === 'string' &&
        a.dataBase64.length > 0
      )
    })
    .slice(0, 8)
    .map((a) => ({
      kind: 'image',
      name: a.name || 'pasted-image',
      mimeType: a.mimeType,
      dataBase64: a.dataBase64,
      size: typeof a.size === 'number' ? a.size : undefined,
      width: typeof a.width === 'number' ? a.width : undefined,
      height: typeof a.height === 'number' ? a.height : undefined,
      path: typeof a.path === 'string' ? a.path : undefined
    }))
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
  agentId?: string
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
    if (value.options.length < 2 || value.options.length > 4) return null
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
  return { runId, questionId, ...(agentId ? { agentId } : {}), questions }
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
