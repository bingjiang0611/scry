import type { AgentQuestionRequest, AgentQuestionResponse } from '../shared/runtime'

/** Only typed native permission decisions may re-enter a running workflow. */
export async function workflowPermissionResponse(
  request: AgentQuestionRequest,
  signal: AbortSignal,
  ask: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>,
  blocked: () => void
): Promise<AgentQuestionResponse> {
  const refuse = (): never => { blocked(); throw new Error('unsupported_interaction') }
  if (request.questionKind !== 'permission' || !request.questions.length || request.questions.some(question =>
    question.inputMode || question.multiSelect || !question.options.length)) return refuse()
  const closed = { ...request, questions: request.questions.map(question => ({ ...question, allowCustomAnswer: false })) }
  const response = await ask(closed, signal)
  if (response.runId !== request.runId || response.questionId !== request.questionId) return refuse()
  if (response.behavior === 'cancelled') return response
  if (response.nativeCustomAnswer || Object.keys(response.answers).length !== request.questions.length) return refuse()
  for (const question of request.questions) {
    const answer = response.answers[question.question]
    if (!question.options.some(option => answer === (option.answerValue ?? option.label))) return refuse()
  }
  return response
}
