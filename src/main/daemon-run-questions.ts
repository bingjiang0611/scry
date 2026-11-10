import { randomUUID } from 'node:crypto'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../shared/runtime'
import type { RunCursor } from './daemon-run-cursor'
import type { DaemonRunTransport } from './daemon-run-transport'

// A daemon run's questions, as this window shows and answers them. The daemon names a
// pending question by its own ledger run; the window shows and answers it under the id
// the Provider used. Split from daemon-run-runtime.ts by responsibility.

export interface QuestionSinks {
  send: (channel: string, payload: unknown) => void
  // P3f W2: the run's own subscription, when a view subscribed to it.
  subscription?: {
    publishQuestion(request: AgentQuestionRequest): void
    publishQuestionClosed(runId: string, questionId: string): void
  }
}

/** Publish questions the daemon now holds, and close the ones it no longer does. */
export async function publishQuestions(cursor: RunCursor, transport: Pick<DaemonRunTransport, 'questions'>, sinks: QuestionSinks): Promise<void> {
  const pending = await transport.questions(cursor.runId)
  for (const request of pending) {
    if (cursor.askedQuestions.has(request.questionId)) continue
    cursor.askedQuestions.add(request.questionId)
    if (!cursor.answerIds.has(request.questionId)) cursor.answerIds.set(request.questionId, randomUUID())
    // The channel the preload subscribes to (`onQuestion` = agent:userQuestion); a
    // question sent on a name nobody listens for leaves the run waiting forever.
    sinks.send('agent:userQuestion', request)
    sinks.subscription?.publishQuestion(request)
  }
  for (const asked of [...cursor.askedQuestions]) {
    if (pending.some((request) => request.questionId === asked)) continue
    cursor.askedQuestions.delete(asked)
    cursor.answerIds.delete(asked)
    sinks.send('agent:userQuestionClosed', { runId: cursor.runId, questionId: asked })
    sinks.subscription?.publishQuestionClosed(cursor.scryRunId ?? cursor.runId, asked)
  }
}

export async function answerQuestion(cursor: RunCursor | undefined, response: AgentQuestionResponse, transport: Pick<DaemonRunTransport, 'answerQuestion'>): Promise<boolean> {
  // The answer travels inside the request, so it speaks the same id the daemon knows:
  // its broker refuses a response naming a different run.
  const ledgerRunId = cursor?.runId ?? response.runId
  const answerId = cursor?.answerIds.get(response.questionId) ?? randomUUID()
  const answered = await transport.answerQuestion({
    runId: ledgerRunId, answerId, response: { ...response, runId: ledgerRunId }
  })
  cursor?.askedQuestions.delete(response.questionId)
  return answered
}
