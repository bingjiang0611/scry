import type { PermissionUpdate } from '@qoder-ai/qoder-agent-sdk'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  exactSessionPermissionDescription,
  exactSessionPermissionSuggestions,
  normalizeAgentQuestionRequest
} from '../../shared/runtime'
import type { ProviderRunRequest } from './types'

type QoderWaitForUser = <T>(action: () => Promise<T>) => Promise<T>

/**
 * Qoder 的 canUseTool 桥接：仍由 Scry 的审批/提问接管，并复用 run 的
 * background monitor 暂停器，避免等待用户时误判后台任务已收敛。
 */
export function qoderCanUseTool(request: ProviderRunRequest, waitForUser: QoderWaitForUser) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
    permission: {
      signal: AbortSignal
      toolUseID: string
      agentID?: string
      suggestions?: PermissionUpdate[]
      title?: string
      description?: string
    }
  ) => {
    if (toolName === 'AskUserQuestion') {
      const question = normalizeAgentQuestionRequest(
        request.runId,
        permission.toolUseID,
        input,
        permission.agentID,
        'qoder:AskUserQuestion'
      )
      if (!question) {
        return { behavior: 'deny' as const, message: 'Scry 收到的提问格式无效', interrupt: false }
      }
      const response = await waitForUser(() => request.requestUserInput!(question, permission.signal))
      if (response.behavior === 'cancelled') {
        return {
          behavior: 'deny' as const,
          message: '用户取消了提问',
          interrupt: false,
          decisionClassification: 'user_reject' as const
        }
      }
      return {
        behavior: 'allow' as const,
        updatedInput: { ...input, answers: response.answers },
        decisionClassification: 'user_temporary' as const
      }
    }
    if ((request.permissionMode ?? 'default') === 'full_access') return { behavior: 'allow' as const }
    const sessionSuggestions = exactSessionPermissionSuggestions(permission.suggestions)
    const sessionDescription = exactSessionPermissionDescription(sessionSuggestions)
    const question = agentPermissionQuestion(
      request.runId,
      permission.toolUseID,
      permission.title ?? '权限请求',
      `允许 ${toolName} 执行这项操作吗？`,
      permission.description ?? JSON.stringify(input).slice(0, 1_200),
      sessionDescription !== undefined,
      `qoder:permission:${toolName}`,
      sessionDescription
    )
    const response = await waitForUser(() => request.requestUserInput!(question, permission.signal))
    const decision = agentPermissionDecision(question, response)
    if (decision === 'reject') {
      return {
        behavior: 'deny' as const,
        message: '用户拒绝了操作',
        interrupt: false,
        decisionClassification: 'user_reject' as const
      }
    }
    const applySessionSuggestions = decision === 'session' && sessionDescription !== undefined
    return {
      behavior: 'allow' as const,
      ...(applySessionSuggestions
        ? { updatedPermissions: sessionSuggestions }
        : {}),
      decisionClassification: applySessionSuggestions ? 'user_permanent' as const : 'user_temporary' as const
    }
}
}
