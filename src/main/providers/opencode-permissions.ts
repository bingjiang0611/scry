import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  agentPermissionDecision,
  agentPermissionQuestion,
  normalizeAgentQuestionRequest,
  type AgentPermissionMode
} from '../../shared/runtime'
import { unsupportedPermissionMode } from './run-controls'
import { unwrap } from './opencode-errors'
import { record } from './opencode-records'
import type { ProviderRunRequest } from './types'

export function openCodePermissionRules(mode: AgentPermissionMode | undefined): Array<{
  permission: string
  pattern: string
  action: 'allow' | 'ask'
}> {
  if (mode === 'full_access') return [{ permission: '*', pattern: '*', action: 'allow' }]
  if (mode === 'auto_review') throw new Error('OpenCode 不支持自动审查权限模式')
  if (mode === 'auto_accept_edits') {
    // OpenCode 的 permission.edit 看起来可以只放行编辑，但 Scry 现在传的是规则数组形态，
    // 尚未在真实 OpenCode 上验证过它与 SDK 对象形态的等价性。未验证就不声明支持。
    throw unsupportedPermissionMode('OpenCode', '自动接受编辑', 'Scry 尚未验证 OpenCode 的编辑级放行规则')
  }
  return [{ permission: '*', pattern: '*', action: 'ask' }]
}

export async function handleOpenCodePermission(
  request: ProviderRunRequest,
  client: OpencodeClient,
  raw: unknown,
  sessionId: string,
  signal = new AbortController().signal
): Promise<boolean> {
  const event = record(raw)
  const versioned = event.type === 'permission.v2.asked'
  if (!versioned && event.type !== 'permission.asked') return false
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return false
  const requestId = String(payload.id ?? '')
  if (!requestId) return false
  const operation = String(payload.permission ?? payload.action ?? '操作')
  const resources = payload.patterns ?? payload.resources
  const patterns = Array.isArray(resources) ? resources.map(String).join('、') : ''
  const question = agentPermissionQuestion(
    request.runId,
    `opencode:${requestId}`,
    'OpenCode 权限',
    `是否允许 ${operation}？`,
    patterns || 'OpenCode 请求执行此操作',
    true,
    `opencode:${String(event.type)}`
  )
  const response = request.requestUserInput
    ? await request.requestUserInput(question, signal)
    : { runId: request.runId, questionId: question.questionId, behavior: 'cancelled' as const }
  const decision = agentPermissionDecision(question, response)
  const reply = decision === 'once' ? 'once' : decision === 'session' ? 'always' : 'reject'
  if (versioned) {
    await unwrap(
      client.v2.session.permission.reply({ sessionID: sessionId, requestID: requestId, reply }),
      'permission.reply'
    )
  } else {
    await unwrap(
      client.permission.reply({ requestID: requestId, directory: request.cwd, reply }),
      'permission.reply'
    )
  }
  return true
}

function openCodeAnswers(question: NonNullable<ReturnType<typeof normalizeAgentQuestionRequest>>, answers: Record<string, string>): string[][] {
  return question.questions.map((prompt) => {
    const answer = answers[prompt.question]
    return prompt.multiSelect ? answer.split(', ').filter(Boolean) : [answer]
  })
}

export async function handleOpenCodeQuestion(
  request: ProviderRunRequest,
  client: OpencodeClient,
  raw: unknown,
  sessionId: string,
  signal = new AbortController().signal
): Promise<boolean> {
  const event = record(raw)
  const versioned = event.type === 'question.v2.asked'
  if (!versioned && event.type !== 'question.asked') return false
  const payload = record(event.properties ?? event.data)
  if (payload.sessionID !== sessionId) return false
  const requestId = String(payload.id ?? '')
  const questions = Array.isArray(payload.questions) ? payload.questions.map(record) : []
  const tool = record(payload.tool)
  if (!requestId) return false
  const question = normalizeAgentQuestionRequest(
    request.runId,
    String(tool.callID ?? `opencode:question:${requestId}`),
    {
      questions: questions.map((candidate) => ({
        header: candidate.header,
        question: candidate.question,
        options: Array.isArray(candidate.options) ? candidate.options : [],
        multiSelect: candidate.multiple === true
      }))
    },
    undefined,
    `opencode:${String(event.type)}`,
    true
  )
  const response = question && request.requestUserInput
    ? await request.requestUserInput(question, signal)
    : null
  if (!question || !response || response.behavior === 'cancelled') {
    if (versioned) {
      await unwrap(client.v2.session.question.reject({ sessionID: sessionId, requestID: requestId }), 'question.reject')
    } else {
      await unwrap(client.question.reject({ requestID: requestId, directory: request.cwd }), 'question.reject')
    }
    return true
  }
  const answers = openCodeAnswers(question, response.answers)
  if (versioned) {
    await unwrap(
      client.v2.session.question.reply({
        sessionID: sessionId,
        requestID: requestId,
        questionV2Reply: { answers }
      }),
      'question.reply'
    )
  } else {
    await unwrap(client.question.reply({ requestID: requestId, directory: request.cwd, answers }), 'question.reply')
  }
  return true
}