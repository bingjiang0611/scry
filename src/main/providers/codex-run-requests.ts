import { agentPermissionDecision, agentPermissionQuestion, normalizeAgentQuestionRequest } from '../../shared/runtime'
import { record } from './codex-trace'
import type { CodexTurnState } from './codex-run-notifications'
import type { ProviderRunRequest } from './types'

/**
 * App-server requests that arrive mid-turn: tool approvals, user questions and MCP elicitation. The
 * run loop owns the promise; this module owns the decision shape so approval policy stays in one place.
 */
export function createServerRequestHandler(options: {
  state: CodexTurnState
  runRequest: ProviderRunRequest
  approvalControllers: Set<AbortController>
  emit: (event: unknown) => void
}) {
  const { state, runRequest, approvalControllers } = options
  return async (method: string, value: unknown): Promise<unknown> => {
    const params = record(value)
    const requestThreadId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (!state.externalSessionId || (requestThreadId !== state.externalSessionId && !state.childAgents.has(requestThreadId ?? ''))) {
      return undefined
    }
    if (method === 'item/tool/requestUserInput') {
      if (!runRequest.requestUserInput) return { answers: {} }
      const itemId = typeof params.itemId === 'string' && params.itemId ? params.itemId : `${Date.now()}`
      const rawQuestions = Array.isArray(params.questions) ? params.questions.map(record) : []
      if (rawQuestions.some((question) => question.isSecret === true)) {
        throw new Error('Codex requested secret input, which Scry cannot safely render')
      }
      const questionIds = rawQuestions.map((question) => String(question.id ?? ''))
      if (questionIds.some((id) => !id)) return { answers: {} }
      const question = normalizeAgentQuestionRequest(
        runRequest.runId,
        `codex:item/tool/requestUserInput:${itemId}`,
        {
          questions: rawQuestions.map((candidate) => ({
            header: candidate.header,
            question: candidate.question,
            options: Array.isArray(candidate.options) ? candidate.options : [],
            multiSelect: false
          }))
        },
        requestThreadId !== state.externalSessionId ? requestThreadId : undefined,
        'codex:item/tool/requestUserInput',
        true
      )
      if (!question) return { answers: {} }
      const controller = new AbortController()
      approvalControllers.add(controller)
      const autoResolutionMs = typeof params.autoResolutionMs === 'number' && params.autoResolutionMs > 0
        ? params.autoResolutionMs
        : undefined
      const timer = autoResolutionMs == null ? undefined : setTimeout(() => controller.abort(), autoResolutionMs)
      try {
        const response = await runRequest.requestUserInput(question, controller.signal)
        if (response.behavior === 'cancelled') return { answers: {} }
        return {
          answers: Object.fromEntries(rawQuestions.map((candidate, index) => [
            questionIds[index],
            { answers: [response.answers[String(candidate.question ?? '')]] }
          ]))
        }
      } finally {
        if (timer) clearTimeout(timer)
        approvalControllers.delete(controller)
      }
    }
    if ((runRequest.permissionMode ?? 'default') === 'full_access') return undefined
    if (![
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval'
    ].includes(method)) return undefined
    if (!runRequest.requestUserInput) {
      if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' }
      return { decision: 'decline' }
    }
    const command = typeof params.command === 'string' ? params.command : undefined
    const reason = typeof params.reason === 'string' ? params.reason : undefined
    const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : undefined
    const detail = command ?? reason ?? grantRoot ?? JSON.stringify(params.permissions ?? {}).slice(0, 1_200)
    const itemId = String(params.approvalId ?? params.itemId ?? `${Date.now()}`)
    const questionText = method === 'item/commandExecution/requestApproval'
      ? '允许 Codex 执行这条命令吗？'
      : method === 'item/fileChange/requestApproval'
        ? '允许 Codex 修改工作区文件吗？'
        : '允许 Codex 获取额外权限吗？'
    const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : []
    const allowSession = method !== 'item/commandExecution/requestApproval' || available.includes('acceptForSession')
    const question = agentPermissionQuestion(
      runRequest.runId,
      `codex:${method}:${itemId}`,
      'Codex 权限',
      questionText,
      detail,
      allowSession,
      `codex:${method}`
    )
    const controller = new AbortController()
    approvalControllers.add(controller)
    try {
      const response = await runRequest.requestUserInput(question, controller.signal)
      const decision = agentPermissionDecision(question, response)
      if (method === 'item/permissions/requestApproval') {
        return {
          permissions: decision === 'reject' ? {} : record(params.permissions),
          scope: decision === 'session' ? 'session' : 'turn'
        }
      }
      return {
        decision: decision === 'reject'
          ? 'decline'
          : decision === 'session' && allowSession
            ? 'acceptForSession'
            : 'accept'
      }
    } finally {
      approvalControllers.delete(controller)
    }
  }
}
