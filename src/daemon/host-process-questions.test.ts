import 'reflect-metadata'
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { cleanupTempDirs } from './host-process.fixtures'
import { startTestDaemon } from './host-process.harness'
import { DaemonRunTransport } from '../main/daemon-run-transport'
import { DaemonRunRuntime } from '../main/daemon-run-runtime'
import { startDaemonRunEvents } from '../main/daemon-run-events'
import { createDaemonRunSurface } from '../main/bootstrap/daemon-run-surface'
import type { AgentQuestionRequest } from '../shared/runtime'

afterEach(cleanupTempDirs)

// B4-S0-2, against a real daemon and the App's own daemon-mode start path. In process
// a question of the run just started reaches the window at once, named by the run id
// `agent:start` returned, and the window shows it because that is the run it focuses
// (useAgentSession drops a question of any other run). The daemon's question broker
// names a pending question by its own ledger run, and that id went to the window as
// it was: real Codex approvals and Pi question forms appeared only after the session
// was selected again, when the run snapshot (named by the canonical id) was re-read.

type Sent = { channel: string; payload: unknown }

async function until<T>(read: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe('daemon run questions', () => {
  it('opens and closes a question of the run just started under the id start returned', async () => {
    const daemon = await startTestDaemon()
    const sent: Sent[] = []
    const subscription: Array<{ kind: 'open' | 'closed'; runId: string; questionId: string }> = []
    const requests: Array<Record<string, unknown>> = []
    const transport = new DaemonRunTransport((request) => {
      requests.push(request)
      return daemon.request(request)
    })
    const runtime = new DaemonRunRuntime({
      transport,
      send: (channel, payload) => sent.push({ channel, payload }),
      // The conversation view's run subscription (P3f W2) is keyed by the same id.
      runTraces: {
        route: () => undefined,
        settle: () => undefined,
        publishQuestion: (request) => subscription.push({ kind: 'open', runId: request.runId, questionId: request.questionId }),
        publishQuestionClosed: (runId, questionId) => subscription.push({ kind: 'closed', runId, questionId })
      }
    })
    const events = startDaemonRunEvents({ transport, runtime, send: () => undefined, waitMs: 500 })
    const surface = createDaemonRunSurface({ transport, runtime, currentCwd: () => daemon.workspace })
    const opened = () => sent.filter((entry) => entry.channel === 'agent:userQuestion')
    const closed = () => sent.filter((entry) => entry.channel === 'agent:userQuestionClosed')
    try {
      // The smoke Provider asks for an approval as soon as it runs, as Codex does.
      const result = await surface.start({
        prompt: `side chat ask s0q-${randomUUID().slice(0, 8)}`, providerId: 'codex', cwd: daemon.workspace, commandId: randomUUID()
      })
      const question = await until(() => opened()[0]?.payload as AgentQuestionRequest | undefined, 10_000)
      expect(question).toBeDefined()
      if (!question) return
      // The window focuses `result.runId`: a question under any other id is dropped there.
      expect(question.runId).toBe(result.runId)
      expect(opened()).toHaveLength(1)
      const attention = sent.find(entry => entry.channel === 'agent:questionAttention')
      expect(attention?.payload).toMatchObject({ runId: result.runId, pendingCount: 1, permissionCount: 1, inputCount: 0 })
      expect(sent.indexOf(attention!)).toBeLessThan(sent.indexOf(opened()[0]!))
      expect(subscription.filter((entry) => entry.kind === 'open')).toEqual([{ kind: 'open', runId: result.runId, questionId: question.questionId }])

      // The window answers with the request it was shown (answers keyed by question text).
      await expect(surface.answerQuestion({
        runId: question.runId, questionId: question.questionId, behavior: 'answered',
        answers: { [question.questions[0]!.question]: 'Allow once' }
      })).resolves.toBe(true)
      expect(await until(() => closed()[0], 10_000)).toBeDefined()
      expect(closed().map((entry) => entry.payload)).toEqual([{ runId: result.runId, questionId: question.questionId }])
      expect(subscription.filter((entry) => entry.kind === 'closed')).toEqual([{ kind: 'closed', runId: result.runId, questionId: question.questionId }])
      expect(await until(() => runtime.runView(result.runId)?.done === true ? true : undefined, 10_000)).toBe(true)
      expect(runtime.runView(result.runId)?.error ?? null).toBeNull()
      expect(requests.some(request => request.op === 'subscribe')).toBe(true)
      expect(requests.filter(request => ['questions', 'runState', 'watch'].includes(String(request.op)) ||
        request.method === 'pendingQuestions' || request.method === 'probeLifecycle')).toEqual([])
    } finally {
      events.dispose()
      runtime.dispose()
      await daemon.dispose()
    }
  }, 60_000)
})
