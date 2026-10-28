/**
 * One routing call decides whether a new human message needs a workflow.
 *
 * The reply is a discriminated decision rather than prose, so a malformed or
 * ambiguous answer becomes a scope error instead of silently starting work:
 *
 *   { "route": "direct" }
 *   { "route": "clarification", "question": "..." }
 *   { "route": "workflow", "body": <program body>, "sizeOverrideReason"?: "..." }
 *
 * Routing never approves execution. A `workflow` decision only publishes a
 * draft root that the user still has to approve by exact programRevision.
 */
import { workflowTemplateEditCopy as editCopy } from './constants/workflow-template-edit-copy'
import { templateIdPattern, type WorkflowTemplateScope } from './workflow-template'

export type WorkflowTemplateEditTarget = { scope?: WorkflowTemplateScope['kind']; templateId: string }

export function parseWorkflowTemplateEditTarget(value: unknown): WorkflowTemplateEditTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(editCopy.invalidTarget)
  const target = value as Record<string, unknown>
  if (Object.keys(target).some(key => key !== 'scope' && key !== 'templateId') ||
    typeof target.templateId !== 'string' || !templateIdPattern.test(target.templateId) ||
    target.scope !== undefined && target.scope !== 'builtin' && target.scope !== 'personal' && target.scope !== 'project') {
    throw new Error(editCopy.invalidTarget)
  }
  return { templateId: target.templateId, ...(target.scope === undefined ? {} : { scope: target.scope }) }
}

export type WorkflowRouteDecision =
  | { route: 'direct' }
  | { route: 'template_edit'; target?: WorkflowTemplateEditTarget }
  | { route: 'clarification'; question: string }
  | { route: 'workflow'; candidate: { body: unknown; sizeOverrideReason?: string } }

export type WorkflowRouteResult =
  | { kind: 'direct' }
  | { kind: 'template_edit'; target?: WorkflowTemplateEditTarget }
  | { kind: 'clarification'; question: string }
  | { kind: 'workflow'; preview: import('./workflow').WorkflowPlanPreview }

export const WORKFLOW_ROUTE_LIMITS = { question: 2_000 } as const

const QUESTION_MAX = WORKFLOW_ROUTE_LIMITS.question

export function parseWorkflowRouteDecision(output: string): WorkflowRouteDecision {
  const text = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('路由 Provider 未返回有效决定')
  const candidate = value as Record<string, unknown>
  if (candidate.route === 'direct') {
    if (Object.keys(candidate).length !== 1) throw new Error('直接回答的决定不能携带程序')
    return { route: 'direct' }
  }
  if (candidate.route === 'template_edit') {
    if (Object.keys(candidate).some(key => key !== 'route' && key !== 'target')) throw new Error(editCopy.extraFields)
    return { route: 'template_edit', ...('target' in candidate ? { target: parseWorkflowTemplateEditTarget(candidate.target) } : {}) }
  }
  if (candidate.route === 'clarification') {
    const question = candidate.question
    if (typeof question !== 'string' || question.trim().length === 0 || question.length > QUESTION_MAX ||
      Object.keys(candidate).length !== 2) throw new Error('澄清决定缺少有效问题')
    return { route: 'clarification', question }
  }
  if (candidate.route === 'workflow') {
    if (!('body' in candidate)) throw new Error('工作流决定缺少程序')
    const extra = Object.keys(candidate).filter(key => key !== 'route' && key !== 'body' && key !== 'sizeOverrideReason')
    if (extra.length > 0) throw new Error('工作流决定包含额外字段')
    const reason = candidate.sizeOverrideReason
    if (reason !== undefined && typeof reason !== 'string') throw new Error('规模说明无效')
    return { route: 'workflow', candidate: { body: candidate.body, ...(reason === undefined ? {} : { sizeOverrideReason: reason }) } }
  }
  throw new Error('路由 Provider 返回了未知决定')
}

export function workflowRoutingPrompt(roles: string, goal: string, planningPrompt: string,
  mode: import('./workflow-mode').WorkflowRoutingMode = 'auto'): string {
  return [
    'You are routing one new message for Scry. Decide whether it needs a workflow, and if so plan it in this same call. Do not greet, explain or answer the message.',
    'Return exactly one JSON object, with no code fence and no extra keys:',
    mode === 'manual'
      ? 'MANUAL: choose {"route":"direct"} for ordinary tasks unless the user explicitly asks to use a workflow. Recognize intent from meaning, not keywords. Do not upgrade ordinary tasks merely because they are complex.'
      : 'AUTO: choose {"route":"direct"} only for greetings, casual chat and simple explanations. Substantive tasks must use a workflow, even if the program needs only a single call.',
    `{"route":"clarification","question":"..."} only when the goal is genuinely ambiguous in a way that changes the program; the question must be at most ${QUESTION_MAX} characters and ask one thing.`,
    '{"route":"workflow","body":<program body>} for workflow execution intent under the selected mode. The program may have one call or several dependent/parallel steps as the actual goal requires.',
    'Never invent requirements the user did not state. Routing is not approval: a returned program is shown to the user, who must approve it before anything runs.',
    '{"route":"template_edit","target"?:{"scope"?:"builtin"|"personal"|"project","templateId":"<UUID>"}} for requests to edit a saved template in either mode. Omit target when unknown; never invent an ID or treat editing as execution.',
    'Template editing opens a source-aware editor and preserves the original request. It does not execute the template, generate another model call, save or publish automatically.',
    `Configured roles: ${roles}`,
    'When you choose "workflow", the following authoring contract applies verbatim.',
    planningPrompt,
    `Message:\n${goal}`
  ].join('\n')
}
