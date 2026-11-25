import { randomUUID } from 'node:crypto'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../shared/runtime'
import { admissionPhase } from './daemon-run-admission'
import { usesScopedRunDelivery, type RunCursor } from './daemon-run-cursor'
import type { DaemonRunTransport } from './daemon-run-transport'

// A daemon run's questions, as this window shows and answers them. The daemon names a
// pending question by its own ledger run; the window shows and answers it under the id
// the Provider used. Split from daemon-run-runtime.ts by responsibility.

/**
 * The id the window holds for this run: what start/follow returned, and what its trace
 * events carry. The window drops a question of any other run (useAgentSession), and the
 * run subscription is keyed by it, so both the open and the close speak it.
 */
export function windowRunId(cursor: RunCursor): string {
  return cursor.scryRunId ?? cursor.runId
}

export interface QuestionSinks {
  send: (channel: string, payload: unknown) => void
  subscription?: {
    publishQuestion(request: AgentQuestionRequest): void
    publishQuestionClosed(runId: string, questionId: string): void
  }
}

export async function publishQuestions(
  cursor: RunCursor,
  pending: AgentQuestionRequest[],
  sinks: QuestionSinks
): Promise<void> {
  // Wait for the App's run ID, as the window routes questions by that ID.
  if (admissionPhase(cursor) !== 'admitted') return
  const runId = windowRunId(cursor)
  if (pending.length !== cursor.askedQuestions.size ||
      pending.some(request => !cursor.askedQuestions.has(request.questionId))) {
    const permissionCount = pending.filter(request => request.questionKind === 'permission').length
    sinks.send('agent:questionAttention', {
      runId, pendingCount: pending.length, permissionCount, inputCount: pending.length - permissionCount
    })
  }
  const windowWide = !usesScopedRunDelivery(cursor)
  for (const pendingRequest of pending) {
    if (cursor.askedQuestions.has(pendingRequest.questionId)) continue
    cursor.askedQuestions.add(pendingRequest.questionId)
    if (!cursor.answerIds.has(pendingRequest.questionId)) cursor.answerIds.set(pendingRequest.questionId, randomUUID())
    // The daemon's broker names it by the ledger run (remote-interaction-broker.ts).
    const request = { ...pendingRequest, runId }
    // The channel the preload subscribes to (`onQuestion` = agent:userQuestion); a
    // question sent on a name nobody listens for leaves the run waiting forever.
    if (windowWide) sinks.send('agent:userQuestion', request)
    sinks.subscription?.publishQuestion(request)
  }
  for (const asked of [...cursor.askedQuestions]) {
    if (pending.some((request) => request.questionId === asked)) continue
    cursor.askedQuestions.delete(asked)
    cursor.answerIds.delete(asked)
    if (windowWide) sinks.send('agent:userQuestionClosed', { runId, questionId: asked })
    sinks.subscription?.publishQuestionClosed(runId, asked)
  }
}

export async function answerQuestion(cursor: RunCursor | undefined, response: AgentQuestionResponse, transport: Pick<DaemonRunTransport, 'answerQuestion'>): Promise<boolean> {
  // The answer travels inside the request, so it speaks the same id the daemon knows:
  // its broker refuses a response naming a different run.
  const ledgerRunId = cursor?.runId ?? response.runId
  const answerId = cursor?.answerIds.get(response.questionId) ?? randomUUID()
  // The question stays asked: the read that no longer finds it pending closes it, as in
  // process an answered question is closed (agent:userQuestionClosed, the subscription).
  return await transport.answerQuestion({
    runId: ledgerRunId, answerId, response: { ...response, runId: ledgerRunId }
  })
}
