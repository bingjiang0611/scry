import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { AgentQuestionRequest } from '../../shared/runtime'
import { RemoteInteractionBroker, RemoteInteractionError } from './remote-interaction-broker'

const expectCode = (fn: () => unknown, code: string): void => {
  try { fn(); throw new Error('expected failure') }
  catch (error) { expect(error).toBeInstanceOf(RemoteInteractionError); expect((error as RemoteInteractionError).code).toBe(code) }
}

function question(runId = 'provider-run'): AgentQuestionRequest {
  return {
    runId,
    questionId: 'question-1',
    providerId: 'codex',
    questionKind: 'permission',
    source: 'provider',
    questions: [{
      question: 'Allow this operation?',
      header: 'Permission',
      options: [
        { label: 'Allow', description: 'Proceed once' },
        { label: 'Deny', description: 'Do not proceed' }
      ],
      multiSelect: false
    }]
  }
}

describe('RemoteInteractionBroker', () => {
  it('routes a native question and fences duplicate answer receipts', async () => {
    const lifecycle = vi.fn()
    const broker = new RemoteInteractionBroker(lifecycle)
    const ledgerRunId = randomUUID()
    const pending = broker.request(ledgerRunId, question(), new AbortController().signal)
    expect(broker.list(ledgerRunId)).toEqual([expect.objectContaining({ runId: ledgerRunId, questionId: 'question-1' })])
    expect(lifecycle).toHaveBeenCalledWith(ledgerRunId, expect.stringContaining('question_opened'))

    const answerId = randomUUID()
    const response = {
      runId: ledgerRunId,
      questionId: 'question-1',
      behavior: 'answered' as const,
      answers: { 'Allow this operation?': 'Allow' }
    }
    expect(broker.answer(ledgerRunId, { answerId, response })).toEqual({ status: 'answered' })
    await expect(pending).resolves.toEqual({ ...response, runId: 'provider-run' })
    expect(broker.answer(ledgerRunId, { answerId, response })).toEqual({ status: 'duplicate' })
    expectCode(() => broker.answer(ledgerRunId, {
      answerId,
      response: { ...response, answers: { 'Allow this operation?': 'Deny' } }
    }), 'answer_payload_conflict')
    expect(lifecycle).toHaveBeenCalledWith(ledgerRunId, expect.stringContaining('question_answered'))
  })

  it('preserves multiline editor text and closes on Provider cancellation', async () => {
    const broker = new RemoteInteractionBroker(() => {})
    const runId = randomUUID()
    const controller = new AbortController()
    const request = question()
    request.questions = [{ question: 'Edit instructions', header: 'Editor', options: [], multiSelect: false, inputMode: 'multiline' }]
    const pending = broker.request(runId, request, controller.signal)
    const text = 'first line\nsecond line'
    const answerId = randomUUID()
    expect(broker.answer(runId, {
      answerId,
      response: { runId, questionId: request.questionId, behavior: 'answered', answers: { 'Edit instructions': text } }
    })).toEqual({ status: 'answered' })
    await expect(pending).resolves.toMatchObject({ answers: { 'Edit instructions': text }, runId: 'provider-run' })

    const cancelled = broker.request(runId, { ...question(), questionId: 'question-2' }, controller.signal)
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ behavior: 'cancelled', runId: 'provider-run' })
    expect(broker.list(runId)).toEqual([])
  })

  it('does not resolve an answer whose durable lifecycle append is unknown', async () => {
    const broker = new RemoteInteractionBroker((_runId, detail) => {
      if (detail.includes('question_answered')) throw new Error('receipt lost')
    })
    const runId = randomUUID()
    const controller = new AbortController()
    const pending = broker.request(runId, question(), controller.signal)
    expect(() => broker.answer(runId, {
      answerId: randomUUID(),
      response: {
        runId,
        questionId: 'question-1',
        behavior: 'answered',
        answers: { 'Allow this operation?': 'Allow' }
      }
    })).toThrow('receipt lost')
    expect(broker.list(runId)).toHaveLength(1)
    controller.abort()
    await expect(pending).resolves.toMatchObject({ behavior: 'cancelled' })
  })
})
