import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createControlEffectExecutor } from './host-controller-effects'
import { RemoteInteractionError } from './remote-interaction-broker'

// R7: the orchestrator writes `{ runId, questionId, answerId, answerPayload }`. The daemon read a
// `response` field that does not exist there, so every queued answer failed and the row was marked
// failed even though the payload carried everything needed.
function executorWith(answer: (runId: string, value: unknown) => unknown) {
  const calls: Array<{ runId: string; value: unknown }> = []
  const execute = createControlEffectExecutor({
    stops: new Map(),
    answer: (runId, value) => {
      calls.push({ runId, value })
      return answer(runId, value)
    }
  })
  return { execute, calls }
}

const response = {
  runId: 'run-1',
  questionId: 'q1',
  behavior: 'answered' as const,
  answers: { 'Which?': 'A' }
}

it('R7: a queued question.respond delivers the answerId and answerPayload it was written with', () => {
  const answerId = randomUUID()
  const { execute, calls } = executorWith(() => undefined)
  const outcome = execute({
    effectId: 'eff-q',
    kind: 'question.respond',
    runId: 'run-1',
    attempts: 1,
    payload: JSON.stringify({ runId: 'run-1', questionId: 'q1', answerId, answerPayload: response })
  })

  expect(outcome).toBe('done')
  expect(calls).toEqual([{ runId: 'run-1', value: { answerId, response } }])
})

it('R7: a question that is already closed is done, and a payload without an answer is failed', () => {
  const closed = executorWith(() => { throw new RemoteInteractionError('question_not_pending') })
  expect(closed.execute({
    effectId: 'eff-closed',
    kind: 'question.respond',
    runId: 'run-1',
    attempts: 1,
    payload: JSON.stringify({ runId: 'run-1', questionId: 'q1', answerId: randomUUID(), answerPayload: response })
  })).toBe('done')

  const broken = executorWith(() => undefined)
  expect(broken.execute({
    effectId: 'eff-broken', kind: 'question.respond', runId: 'run-1', attempts: 1, payload: '{}'
  })).toBe('failed')
  expect(broken.calls).toEqual([])

  // A real refusal is not reported as success just because the row can be retried.
  const refused = executorWith(() => { throw new RemoteInteractionError('invalid_question_response') })
  expect(refused.execute({
    effectId: 'eff-refused',
    kind: 'question.respond',
    runId: 'run-1',
    attempts: 1,
    payload: JSON.stringify({ runId: 'run-1', questionId: 'q1', answerId: randomUUID(), answerPayload: response })
  })).toBe('failed')
})
