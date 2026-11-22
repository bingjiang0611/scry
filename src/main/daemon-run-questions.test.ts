import { describe, expect, it, vi } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import type { AgentQuestionRequest } from '../shared/runtime'
import { announceRun, runEvent, subscribedRun } from './daemon-run-subscription.fixtures'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// B4-S0-2: a daemon run's questions reach the window under the id it focuses. The
// daemon's broker names a pending question by its ledger run; the window holds the
// canonical id start returned, drops a question of any other run (useAgentSession), and
// its run subscription is keyed by that id. Real Codex approvals arrive while start is
// still waiting for admission, before the subscriber receives the admission and its canonical binding. src/daemon/host-process-questions.test.ts covers the same against a real daemon.

const RUN = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const CANONICAL = 'remote-run-mw6osn9o-4'
const CONTEXT = { cwd: '/w', providerId: 'codex' }
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: false, providerSettled: false }
// As the daemon's broker lists it: under the ledger run (remote-interaction-broker.ts).
const QUESTION: AgentQuestionRequest = { runId: RUN, questionId: `${CANONICAL}:approval`, providerId: 'codex', questionKind: 'permission', questions: [] }

function fixture() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const subscription: unknown[] = []
  const answers: Record<string, unknown>[] = []
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded', seq: 1 }
    // The trace is addressed by the canonical id; the ledger id finds no run there.
    if (payload.op === 'desktop') {
      const query = payload.query as { runId?: string } | undefined
      return { desktop: { kind: 'trace', run: query?.runId === CANONICAL ? liveRun : null } }
    }
    if (payload.op === 'answerQuestion') {
      answers.push(payload)
      return { answer: { status: 'answered' } }
    }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
    bindBudgetMs: 500,
    admitBudgetMs: 2_000,
    runTraces: {
      route: () => undefined,
      settle: () => undefined,
      publishQuestion: (question) => subscription.push({ kind: 'open', runId: question.runId, questionId: question.questionId }),
      publishQuestionClosed: (runId, questionId) => subscription.push({ kind: 'closed', runId, questionId })
    }
  })
  const of = (channel: string) => sent.filter((entry) => entry.channel === channel).map((entry) => entry.payload)
  const project = (questions: AgentQuestionRequest[], admitted: boolean) => runtime.applySubscribeEvent(runEvent(
    questions.length ? 'run.question_opened' : 'run.question_closed', RUN, {}, subscribedRun(RUN, { questions, admitted })
  ))
  const start = async (beforeAdmission: boolean) => {
    const pending = runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
    await vi.waitFor(() => expect(runtime.isTracking(RUN)).toBe(true), { interval: 1 })
    if (beforeAdmission) {
      await project([QUESTION], false)
      expect(of('agent:userQuestion')).toEqual([])
    }
    await announceRun(runtime, RUN, { scryRunId: CANONICAL })
    await project([QUESTION], true)
    return await pending
  }
  return { runtime, of, subscription, answers, start, project }
}

describe('daemon run questions reach the window under the id it focuses', () => {
  it('holds a question read before the run\'s admission, then opens it under the id start returns', async () => {
    const { runtime, of, subscription, start } = fixture()
    try {
      const started = await start(true)
      expect(started).toMatchObject({ runId: CANONICAL, bound: true })
      expect(of('agent:userQuestion')).toEqual([{ ...QUESTION, runId: CANONICAL }])
      expect(subscription).toEqual([{ kind: 'open', runId: CANONICAL, questionId: QUESTION.questionId }])
    } finally { runtime.dispose() }
  })

  it('closes a question this window answered, under the same id it was opened with', async () => {
    const { runtime, of, subscription, answers, start, project } = fixture()
    try {
      const started = await start(false)
      const [shown] = of('agent:userQuestion') as Array<typeof QUESTION>
      expect(shown?.runId).toBe(started.runId)
      // The window answers with what it was shown; the daemon is answered on its ledger run.
      await expect(runtime.answerQuestion({ runId: shown!.runId, questionId: shown!.questionId, behavior: 'cancelled' })).resolves.toBe(true)
      expect(answers[0]).toMatchObject({ runId: RUN, response: { runId: RUN, questionId: QUESTION.questionId } })
      await project([], true)
      // As in process, the answered question is closed; never re-opened while it was pending.
      expect(of('agent:userQuestionClosed')).toEqual([{ runId: CANONICAL, questionId: QUESTION.questionId }])
      expect(of('agent:userQuestion')).toHaveLength(1)
      expect(subscription).toEqual([
        { kind: 'open', runId: CANONICAL, questionId: QUESTION.questionId },
        { kind: 'closed', runId: CANONICAL, questionId: QUESTION.questionId }
      ])
    } finally { runtime.dispose() }
  })
})
