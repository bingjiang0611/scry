import { createHash } from 'node:crypto'
import { normalizeAgentQuestionResponse, type AgentQuestionRequest, type AgentQuestionResponse } from '../../shared/runtime'
import { UserQuestionBroker } from '../user-question'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MAX_CLOSED = 512

export interface RemoteQuestionAnswer {
  answerId: string
  response: AgentQuestionResponse
}

export type RemoteQuestionAnswerReceipt = { status: 'answered' | 'duplicate' }

interface ClosedAnswer {
  answerId: string
  digest: string
}

function key(runId: string, questionId: string): string {
  return `${runId}\0${questionId}`
}

function digest(value: AgentQuestionResponse): string {
  const canonical = value.behavior === 'cancelled'
    ? { runId: value.runId, questionId: value.questionId, behavior: value.behavior }
    : {
        runId: value.runId,
        questionId: value.questionId,
        behavior: value.behavior,
        answers: Object.fromEntries(Object.entries(value.answers).sort(([left], [right]) => left.localeCompare(right)))
      }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

export class RemoteInteractionError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'RemoteInteractionError'
    this.code = code
  }
}

export class RemoteInteractionBroker {
  readonly #broker: UserQuestionBroker
  readonly #closed = new Map<string, ClosedAnswer>()

  constructor(private readonly recordLifecycle: (runId: string, detail: string) => void) {
    this.#broker = new UserQuestionBroker((change) => {
      if (change.kind !== 'closed' || change.intervention.resolution === 'answered') return
      try {
        this.recordLifecycle(change.runId, JSON.stringify({
          event: 'question_closed',
          questionId: change.questionId,
          resolution: change.intervention.resolution
        }))
      } catch {
        // Provider cancellation already settled the native callback. A failed
        // observation append must not manufacture an answer or re-open it.
      }
    })
  }

  async request(ledgerRunId: string, request: AgentQuestionRequest, signal: AbortSignal): Promise<AgentQuestionResponse> {
    const remoteRequest: AgentQuestionRequest = { ...request, runId: ledgerRunId }
    this.recordLifecycle(ledgerRunId, JSON.stringify({
      event: 'question_opened',
      questionId: remoteRequest.questionId,
      kind: remoteRequest.questionKind ?? 'clarification',
      source: remoteRequest.source ?? 'unknown'
    }))
    const response = await this.#broker.request(remoteRequest, signal)
    return { ...response, runId: request.runId }
  }

  list(runId: string): AgentQuestionRequest[] {
    return this.#broker.list(runId)
  }

  answer(runId: string, value: RemoteQuestionAnswer): RemoteQuestionAnswerReceipt {
    if (!UUID.test(value?.answerId ?? '')) throw new RemoteInteractionError('invalid_answer_id')
    if (!value?.response || typeof value.response !== 'object') throw new RemoteInteractionError('invalid_question_response')
    const questionId = (value.response as { questionId?: unknown }).questionId
    if (typeof questionId !== 'string') throw new RemoteInteractionError('invalid_question_response')
    const answerKey = key(runId, questionId)
    const request = this.#broker.list(runId).find((candidate) => candidate.questionId === questionId)
    if (!request) {
      const closed = this.#closed.get(answerKey)
      if (!closed) throw new RemoteInteractionError('question_not_pending')
      if (value.response.runId !== runId || value.response.questionId !== questionId ||
          (value.response.behavior !== 'answered' && value.response.behavior !== 'cancelled')) {
        throw new RemoteInteractionError('invalid_question_response')
      }
      const normalizedDigest = digest(value.response)
      if (closed.answerId !== value.answerId || closed.digest !== normalizedDigest) throw new RemoteInteractionError('answer_payload_conflict')
      return { status: 'duplicate' }
    }
    const normalized = normalizeAgentQuestionResponse(request, { ...value.response, runId })
    if (!normalized) throw new RemoteInteractionError('invalid_question_response')
    const answerDigest = digest(normalized)
    this.recordLifecycle(runId, JSON.stringify({
      event: 'question_answered',
      questionId,
      answerId: value.answerId,
      digest: answerDigest,
      behavior: normalized.behavior
    }))
    if (!this.#broker.answer(normalized)) throw new RemoteInteractionError('question_not_pending')
    this.#closed.delete(answerKey)
    this.#closed.set(answerKey, { answerId: value.answerId, digest: answerDigest })
    while (this.#closed.size > MAX_CLOSED) this.#closed.delete(this.#closed.keys().next().value!)
    return { status: 'answered' }
  }

  cancelRun(runId: string): void {
    this.#broker.cancelRun(runId)
  }
}
