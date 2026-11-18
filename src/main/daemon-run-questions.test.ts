import { describe, expect, it } from 'vitest'
import type { ActiveRun } from '../shared/trace'
import { DaemonRunRuntime } from './daemon-run-runtime'
import { DaemonRunTransport } from './daemon-run-transport'
import { TraceOutputBridge } from './trace-output'

// B4-S0-2: a daemon run's questions reach the window under the id it focuses. The
// daemon's broker names a pending question by its ledger run; the window holds the
// canonical id start returned, drops a question of any other run (useAgentSession), and
// its run subscription is keyed by that id. Real Codex approvals arrive while start is
// still waiting for admission, so the step that publishes them may not have read the
// bind yet. src/daemon/host-process-questions.test.ts covers the same against a real daemon.

const RUN = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const CANONICAL = 'remote-run-mw6osn9o-4'
const CONTEXT = { cwd: '/w', providerId: 'codex' }
const bound = { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'bound', ledgerRunId: RUN, scryRunId: CANONICAL, providerId: 'codex', cwd: '/w' }) }
const admitted = { runId: RUN, kind: 'run_progress', detail: JSON.stringify({ event: 'admitted', ledgerRunId: RUN, scryRunId: CANONICAL }) }
const liveRun: ActiveRun = { runId: CANONICAL, providerId: 'codex', cwd: '/w', userText: 'hi', items: [], done: false, providerSettled: false }
// As the daemon's broker lists it: under the ledger run (remote-interaction-broker.ts).
const QUESTION = { runId: RUN, questionId: `${CANONICAL}:approval`, providerId: 'codex', questionKind: 'permission', questions: [] }

// `watch` frames in order; the last repeats without entries. Questions stay pending until answered.
function fixture(watch: Array<{ events?: unknown[] }>) {
  let served = 0
  let pending = [QUESTION]
  const sent: Array<{ channel: string; payload: unknown }> = []
  const subscription: unknown[] = []
  const answers: Record<string, unknown>[] = []
  const request = async (payload: Record<string, unknown>): Promise<unknown> => {
    if (payload.op === 'submit') return { runId: RUN, status: 'recorded', seq: 1 }
    if (payload.op === 'watch') {
      const index = Math.min(served, watch.length - 1)
      const events = index === served ? watch[index]!.events ?? [] : []
      if (index === served) served += 1
      return { watch: { state: 'dispatched', poll: { cursor: index + 1, events } } }
    }
    // The trace is addressed by the canonical id; the ledger id finds no run there.
    if (payload.op === 'desktop') {
      const query = payload.query as { runId?: string } | undefined
      return { desktop: { kind: 'trace', run: query?.runId === CANONICAL ? liveRun : null } }
    }
    if (payload.op === 'questions') return { questions: pending }
    if (payload.op === 'answerQuestion') {
      answers.push(payload)
      pending = []
      return { answer: { status: 'answered' } }
    }
    return { error: 'unknown_op' }
  }
  const runtime = new DaemonRunRuntime({
    transport: new DaemonRunTransport(request),
    send: (channel, payload) => sent.push({ channel, payload }),
    bridge: new TraceOutputBridge({ canSend: () => true, send: () => {}, schedule: (fn) => { fn(); return () => {} } }),
    waitMs: 0,
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
  return { runtime, of, subscription, answers }
}

describe('daemon run questions reach the window under the id it focuses', () => {
  it('holds a question read before the run\'s admission, then opens it under the id start returns', async () => {
    // The first read finds the question but not yet the bind (both landed between the
    // watch and the questions read); the next one reads the bind and the admission.
    const { runtime, of, subscription } = fixture([{}, { events: [bound, admitted] }])
    // Disposed whatever the outcome: a pump left running on this immediate fixture never yields.
    try {
      const started = await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
      expect(started).toMatchObject({ runId: CANONICAL, bound: true })
      expect(of('agent:userQuestion')).toEqual([{ ...QUESTION, runId: CANONICAL }])
      expect(subscription).toEqual([{ kind: 'open', runId: CANONICAL, questionId: QUESTION.questionId }])
    } finally { runtime.dispose() }
  })

  it('closes a question this window answered, under the same id it was opened with', async () => {
    const { runtime, of, subscription, answers } = fixture([{ events: [bound, admitted] }])
    try {
      const started = await runtime.start({ intentId: 'i-1', detail: '{}', context: CONTEXT })
      const [shown] = of('agent:userQuestion') as Array<typeof QUESTION>
      expect(shown?.runId).toBe(started.runId)
      // The window answers with what it was shown; the daemon is answered on its ledger run.
      await expect(runtime.answerQuestion({ runId: shown!.runId, questionId: shown!.questionId, behavior: 'cancelled' })).resolves.toBe(true)
      expect(answers[0]).toMatchObject({ runId: RUN, response: { runId: RUN, questionId: QUESTION.questionId } })
      await runtime.step(RUN, { waitMs: 0 })
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
