import { isOptionalString, isDateString, isNonNegativeNumber } from './turn-evidence-validation.js'


function isQuestionOption(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.label === 'string' && raw.label.length > 0 && raw.label.length <= 240 &&
    typeof raw.description === 'string' && raw.description.length > 0 && raw.description.length <= 4_000 &&
    (raw.preview === undefined || (typeof raw.preview === 'string' && raw.preview.length > 0 && raw.preview.length <= 20_000))
}

function isQuestionPrompt(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (typeof raw.question !== 'string' || raw.question.length === 0 || raw.question.length > 2_000) return false
  if (typeof raw.header !== 'string' || raw.header.length === 0 || raw.header.length > 120) return false
  if (!Array.isArray(raw.options) || raw.options.length > 4 || !raw.options.every(isQuestionOption) || typeof raw.multiSelect !== 'boolean') return false
  const labels = raw.options.map((option) => (option as Record<string, unknown>).label)
  return new Set(labels).size === labels.length
}

function isQuestionRequest(value: unknown): value is Record<string, unknown> & { questions: Array<Record<string, unknown>> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return typeof raw.runId === 'string' && raw.runId.length > 0 &&
    typeof raw.questionId === 'string' && raw.questionId.length > 0 &&
    (raw.providerId === undefined || ['claude', 'codex', 'qoder', 'opencode', 'pi'].includes(String(raw.providerId))) &&
    isOptionalString(raw.agentId) && isOptionalString(raw.source) &&
    (raw.questionKind === undefined || ['clarification', 'permission'].includes(String(raw.questionKind))) &&
    Array.isArray(raw.questions) && raw.questions.length > 0 && raw.questions.length <= 4 && raw.questions.every(isQuestionPrompt) &&
    new Set(raw.questions.map((question) => (question as Record<string, unknown>).question)).size === raw.questions.length
}

function isQuestionResponse(value: unknown, request: Record<string, unknown> & { questions: Array<Record<string, unknown>> }): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (raw.runId !== request.runId || raw.questionId !== request.questionId) return false
  if (raw.behavior === 'cancelled') return raw.answers === undefined
  if (raw.behavior !== 'answered' || !raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers)) return false
  const answers = raw.answers as Record<string, unknown>
  if (!Object.values(answers).every((answer) => typeof answer === 'string' && answer.length > 0 && answer.length <= 4_000)) return false
  return request.questions.every((question) => typeof question.question === 'string' && typeof answers[question.question] === 'string')
}

export function isIntervention(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  if (!['clarification', 'permission'].includes(String(raw.kind)) || typeof raw.source !== 'string' || raw.source.length === 0) return false
  if (!['answered', 'user_cancelled', 'provider_cancelled'].includes(String(raw.resolution))) return false
  if (!isDateString(raw.openedAt) || !isDateString(raw.closedAt) || Date.parse(raw.closedAt) < Date.parse(raw.openedAt) || !isNonNegativeNumber(raw.durationMs)) return false
  if (!isQuestionRequest(raw.request) || !isQuestionResponse(raw.response, raw.request)) return false
  if (raw.request.questionKind !== undefined && raw.request.questionKind !== raw.kind) return false
  const response = raw.response as Record<string, unknown>
  return raw.resolution === 'answered' ? response.behavior === 'answered' : response.behavior === 'cancelled'
}
