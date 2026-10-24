import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'
import type { JsonRecord } from './pi-shared'

function nativeCustomAnswerOption(event: JsonRecord): string | undefined {
  if (event.method !== 'select' || !Array.isArray(event.options)) return undefined
  const last = event.options.at(-1)
  return typeof last === 'string' && /^(?:\d+[.)、]\s*)?Type something\.?$/i.test(last.trim()) ? last : undefined
}

export function questionFromExtension(runId: string, event: JsonRecord): AgentQuestionRequest | null {
  const id = typeof event.id === 'string' ? event.id : ''
  const method = String(event.method ?? '')
  if (!id || !['select', 'confirm', 'input', 'editor'].includes(method)) return null
  const title = String(event.title ?? 'Pi Extension').slice(0, 2_000)
  const inputTitle = title.match(/^\[([^\]\n]{1,16})\]\s*([\s\S]+)$/)
  const inputBody = inputTitle?.[2].trim() || title
  const numberedOptions = method === 'input'
    ? [...inputBody.matchAll(/^\s*(\d+)[.)、]\s+(.+)$/gm)]
    : []
  const firstOptionAt = numberedOptions[0]?.index
  const parsedQuestion = firstOptionAt == null
    ? inputBody
    : inputBody.slice(0, firstOptionAt).trim()
  const isMultiSelect = /[（(]\s*可多选\s*[）)]/.test(parsedQuestion)
  const cleanQuestion = parsedQuestion.replace(/\s*[（(]\s*可多选\s*[）)]\s*$/, '').trim()
  const parsedOptions = numberedOptions.map((match) => {
    const copy = match[2].trim()
    const split = copy.match(/^(.+?)\s+[—–]\s+(.+)$/)
    return {
      label: split?.[1].trim() || copy,
      description: split?.[2].trim() || '选择此项',
      answerValue: match[1]
    }
  })
  const header = method === 'input'
    ? inputTitle?.[1].trim() || '回答'
    : title.slice(0, 120)
  const question = method === 'confirm'
    ? String(event.message ?? title)
    : method === 'editor'
      ? '请输入多行内容'
      : method === 'input'
        ? cleanQuestion
        : title
  const labels = method === 'confirm'
    ? ['确认', '取消']
    : Array.isArray(event.options)
      ? event.options.filter((item): item is string => typeof item === 'string').slice(0, 100)
      : []
  const customAnswerOption = nativeCustomAnswerOption(event)
  const options = parsedOptions.length >= 2
    ? parsedOptions
    : labels.filter((label) => label !== customAnswerOption)
      .map((label) => ({ label, description: method === 'confirm' ? `${label}这次操作` : '选择此项' }))
  const placeholder = method === 'input' && typeof event.placeholder === 'string'
    ? event.placeholder.slice(0, 500)
    : ''
  return {
    runId,
    questionId: id,
    providerId: 'pi',
    questionKind: 'clarification',
    source: `pi_extension_ui:${method}`,
    questions: [{
      header,
      question: question.slice(0, 2_000),
      multiSelect: parsedOptions.length >= 2 && isMultiSelect,
      options,
      // Only the known questionnaire sentinel supports a staged select → input reply.
      // Other native select/confirm requests remain closed choices.
      ...((method === 'select' || method === 'confirm') ? { allowCustomAnswer: !!customAnswerOption } : {}),
      ...((method === 'editor' || method === 'input' && options.length === 0)
        ? { inputMode: method === 'editor' ? 'multiline' as const : 'singleline' as const }
        : {}),
      ...(placeholder && options.length === 0 ? { placeholder } : {}),
      ...(method === 'editor' && typeof event.prefill === 'string'
        ? { initialValue: event.prefill } : {})
    }]
  }
}

function extensionResponse(
  event: JsonRecord,
  question: AgentQuestionRequest,
  response: AgentQuestionResponse
): JsonRecord {
  if (response.behavior === 'cancelled') return { type: 'extension_ui_response', id: event.id, cancelled: true }
  const answer = response.answers[question.questions[0].question] ?? ''
  return event.method === 'confirm'
    ? { type: 'extension_ui_response', id: event.id, confirmed: answer === '确认' }
    : { type: 'extension_ui_response', id: event.id, value: answer }
}


export { nativeCustomAnswerOption, extensionResponse }
