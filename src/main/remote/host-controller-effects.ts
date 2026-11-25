import type { AgentQuestionResponse } from '../../shared/runtime'
import type { RemoteEffectExecutor } from './remote-dispatcher'
import { RemoteInteractionError } from './remote-interaction-broker'

/**
 * R7: the durable control effects (stop, answer) are executed by the daemon, not by the run executor.
 *
 * The queue payload is written by the orchestrator as `{ runId, questionId, answerId, answerPayload }`,
 * so reading a `response` field found nothing and every queued answer failed. A row whose answer the
 * Provider already received is `done`: the question is closed, and re-answering is not the effect's job.
 */
export function createControlEffectExecutor(deps: {
  stops: Map<string, AbortController>
  answer(runId: string, value: { answerId: string; response: AgentQuestionResponse }): unknown
}): RemoteEffectExecutor {
  return (effect) => {
    if (effect.kind === 'provider.run.stop') {
      const controller = effect.runId ? deps.stops.get(effect.runId) : undefined
      controller?.abort()
      // A stop for a run that is no longer live already has its outcome; nothing to wait for.
      return 'done'
    }
    if (effect.kind !== 'question.respond') return 'failed'
    if (!effect.runId) return 'failed'
    let payload: { answerId?: unknown; answerPayload?: unknown }
    try {
      payload = JSON.parse(effect.payload) as { answerId?: unknown; answerPayload?: unknown }
    } catch {
      return 'failed'
    }
    if (typeof payload.answerId !== 'string' || !payload.answerPayload || typeof payload.answerPayload !== 'object') {
      // A payload without a usable answer cannot be retried into one.
      return 'failed'
    }
    try {
      deps.answer(effect.runId, {
        answerId: payload.answerId,
        response: payload.answerPayload as AgentQuestionResponse
      })
      return 'done'
    } catch (error) {
      // The live path, the Mac owner, or another answer already closed the question: the outcome the
      // user asked for is already true. Anything else is a real failure and must not look like success.
      if (error instanceof RemoteInteractionError && error.message === 'question_not_pending') return 'done'
      return 'failed'
    }
  }
}
