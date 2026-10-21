import {
  normalizeAgentQuestionRequest,
  type AgentQuestionRequest,
  type AgentQuestionResponse
} from '../../shared/runtime'

const CUSTOM_ANSWER_TITLE = 'Type your answer:'

type Dialog = Record<string, unknown>
type Reply = { type: 'extension_ui_response'; id: unknown; value?: string; cancelled?: true }

/** Adapts the native ask_user_question RPC walker, not arbitrary extension dialogs. */
export class PiQuestionnaire {
  private index = 0
  private response: AgentQuestionResponse | undefined
  private customInput: { title: string; value: string } | undefined

  private constructor(readonly request: AgentQuestionRequest) {}

  static fromTool(runId: string, toolCallId: string, input: unknown): PiQuestionnaire | null {
    const request = normalizeAgentQuestionRequest(runId, toolCallId, input, undefined, 'pi_questionnaire')
    if (!request || request.questions.length < 2) return null
    request.providerId = 'pi'
    request.questions = request.questions.map((question) => ({
      ...question,
      options: question.options.map((option, index) => ({
        ...option,
        answerValue: String(index + 1)
      }))
    }))
    return new PiQuestionnaire(request)
  }

  matches(event: Dialog): boolean {
    if (this.customInput) return event.method === 'input' && event.title === this.customInput.title
    const question = this.request.questions[this.index]
    if (!question) return false
    const title = `[${question.header}] ${question.question}`
    if (question.multiSelect) {
      const options = question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`).join('\n')
      return event.method === 'input' && event.placeholder === '1,3' &&
        typeof event.title === 'string' && event.title.startsWith(`${title}\n\n${options}\n\n`)
    }
    const previews = question.options.flatMap((option, index) => option.preview
      ? [`--- ${index + 1}. ${option.label} preview ---\n${option.preview.slice(0, 600)}`] : [])
    const expectedTitle = title + (previews.length ? `\n\n${previews.join('\n\n')}` : '')
    const options = [...question.options.map((option, index) => `${index + 1}. ${option.label} — ${option.description}`), `${question.options.length + 1}. Type something.`]
    return event.method === 'select' && event.title === expectedTitle &&
      Array.isArray(event.options) && event.options.length === options.length &&
      event.options.every((option, index) => option === options[index])
  }

  async reply(
    event: Dialog,
    ask: (request: AgentQuestionRequest) => Promise<AgentQuestionResponse>
  ): Promise<Reply> {
    if (this.customInput) {
      const { value } = this.customInput
      this.customInput = undefined
      return { type: 'extension_ui_response', id: event.id, value }
    }
    // No native answer is sent until the user has reviewed and submitted the whole group.
    this.response ??= await ask(this.request)
    if (this.response.behavior === 'cancelled') {
      return { type: 'extension_ui_response', id: event.id, cancelled: true }
    }
    const question = this.request.questions[this.index++]
    const answer = this.response.answers[question.question]
    const selected = question.options.find((option) => option.answerValue === answer)
    const custom = this.response.nativeCustomAnswers?.includes(question.question) || !selected
    if (!question.multiSelect && custom) {
      this.customInput = { title: `[${question.header}] ${question.question}\n\n${CUSTOM_ANSWER_TITLE}`, value: answer }
      return { type: 'extension_ui_response', id: event.id, value: `${question.options.length + 1}. Type something.` }
    }
    const value = !question.multiSelect && selected ? `${answer}. ${selected.label} — ${selected.description}` : answer
    return { type: 'extension_ui_response', id: event.id, value }
  }
}
