import { maskSecrets } from './trace.js'
import type { AgentImageMimeType, AgentInputAttachment, AgentQuestionOption, AgentQuestionPrompt, AgentQuestionRequest, AgentQuestionResponse, AgentSteerRequest } from './runtime-types.js'

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
export function boundedControlValue(value: unknown): string | undefined {
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
  sessionDescription = '允许这类操作直到当前原生会话结束',
  warning?: string
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
      ...(warning ? { warning } : {}),
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

/**
 * 把 Provider 给出的风险说明整理成可直接显示的一行文本。
 *
 * 这段文本来自 Provider，可能含控制字符、ANSI 序列或凭据；它是**数据**，不是指令。
 * 这里只做脱敏、去控制字符和长度收敛，不解释也不执行其中的内容。
 */
export function sanitizeApprovalWarning(value: unknown, maxLength = 400): string | undefined {
  if (typeof value !== 'string') return undefined
  const masked = maskSecrets(value) ?? ''
  const flattened = masked
    // CSI/OSC 等 ANSI 转义序列
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flattened) return undefined
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened
}

export function isSupportedImageMimeType(value: string): value is AgentImageMimeType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp'
}

export function decodedBase64ByteLength(value: string): number | null {
  const compact = value.replace(/\s+/g, '')
  if (!compact || compact.length % 4 !== 0) return null
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  // An unquantified character-class search keeps validation linear without a
  // per-byte JS loop or the backtracking stack of a whole-string Base64 regexp.
  if (/[^A-Za-z0-9+/]/.test(compact.slice(0, compact.length - padding))) return null
  return (compact.length / 4) * 3 - padding
}

export function normalizeAgentAttachments(value: unknown): AgentInputAttachment[] {
  if (!Array.isArray(value)) return []
  const attachments: AgentInputAttachment[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const a = item as Partial<AgentInputAttachment>
    const mimeType = String(a.mimeType ?? '')
    if (
      a.kind !== 'image' ||
      typeof a.name !== 'string' ||
      !isSupportedImageMimeType(mimeType) ||
      typeof a.dataBase64 !== 'string'
    ) continue
    const size = decodedBase64ByteLength(a.dataBase64)
    if (size == null) continue
    attachments.push({
      kind: 'image',
      name: a.name || 'pasted-image',
      mimeType,
      dataBase64: a.dataBase64,
      size,
      width: typeof a.width === 'number' ? a.width : undefined,
      height: typeof a.height === 'number' ? a.height : undefined,
      path: typeof a.path === 'string' ? a.path : undefined
    })
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
  if (response.nativeCustomAnswers !== undefined && (
    request.providerId !== 'pi' || request.source !== 'pi_questionnaire' ||
    !Array.isArray(response.nativeCustomAnswers) || response.nativeCustomAnswers.length > request.questions.length ||
    !response.nativeCustomAnswers.every((text) => typeof text === 'string' &&
      request.questions.some((question) => question.question === text && question.allowCustomAnswer !== false))
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
    ...(response.nativeCustomAnswer === true ? { nativeCustomAnswer: true } : {}),
    ...(Array.isArray(response.nativeCustomAnswers) ? { nativeCustomAnswers: [...response.nativeCustomAnswers] as string[] } : {})
  }
}
