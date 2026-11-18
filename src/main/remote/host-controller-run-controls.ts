import { randomUUID } from 'node:crypto'
import type { AgentQuestionResponse } from '../../shared/runtime'
import type { MacRunSource, MacRunView } from './host-controller-types'
import type { RemoteInteractionBroker, RemoteQuestionAnswerReceipt } from './remote-interaction-broker'
import { RemoteInteractionError } from './remote-interaction-broker'
import type { SessionLedger } from './session-ledger'

// Device-facing run controls: answering a question and stopping a run. A Mac run
// is answered and stopped through the Mac's own broker; a remote run through the
// per-run controller that the executor installed.
export interface RunControlDeps {
  authorizeDevice(peer: string): void
  isRemoteRun(runId: string): boolean
  macRun(runId: string): MacRunView
  macRuns?: MacRunSource
  interactions: RemoteInteractionBroker
  stops: Map<string, AbortController>
  ledger: SessionLedger
}

export interface AnswerInput { runId: string; answerId: string; response: AgentQuestionResponse }

export function answerRunQuestion(deps: RunControlDeps, peerCertSHA256: string, input: AnswerInput): RemoteQuestionAnswerReceipt {
    deps.authorizeDevice(peerCertSHA256)
    if (!deps.isRemoteRun(input.runId)) {
      const run = deps.macRun(input.runId)
      const response = input.response as { runId?: unknown; questionId?: unknown } | null
      if (!response || response.runId !== input.runId ||
          !run.questions.some((question) => question.questionId === response.questionId)) {
        throw new RemoteInteractionError('question_not_pending')
      }
      // The Mac broker settles a question once. A false return means it was
      // already answered (here or on the Mac) or closed; never report success.
      if (!deps.macRuns!.answer(input.response)) throw new RemoteInteractionError('question_not_pending')
      return { status: 'answered' }
    }
    return deps.interactions.answer(input.runId, { answerId: input.answerId, response: input.response })
}

export function answerOwnerRunQuestion(deps: RunControlDeps, runId: string, response: AgentQuestionResponse): boolean {
    try {
      return deps.interactions.answer(runId, { answerId: randomUUID(), response: { ...response, runId } }).status === 'answered'
    } catch (error) {
      if (error instanceof RemoteInteractionError) return false
      throw error
    }
}

export function stopRun(deps: RunControlDeps, peerCertSHA256: string, input: { runId: string }): { status: 'requested' | 'already_requested' | 'not_running' } {
    deps.authorizeDevice(peerCertSHA256)
    if (!deps.isRemoteRun(input.runId)) {
      const run = deps.macRun(input.runId)
      if (run.stopping) return { status: 'already_requested' }
      return { status: deps.macRuns!.stop(input.runId) ? 'requested' : 'not_running' }
    }
    const stop = deps.stops.get(input.runId)
    if (!stop) return { status: 'not_running' }
    if (stop.signal.aborted) return { status: 'already_requested' }
    deps.ledger.markProgress(input.runId, JSON.stringify({ event: 'stop_requested' }))
    stop.abort()
    return { status: 'requested' }
}
