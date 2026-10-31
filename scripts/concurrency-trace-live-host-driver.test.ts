import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

interface TraceQuestion { idSuffix: string; header: string; text: string; answer: string; multiSelect: boolean }
interface Policy { questionId: string; question: string; answer: string }
interface Attention { pendingCount: number | null; updates: number; atMs: number }
interface Detail { questionId: string; questions: Array<{ header: string; question: string; options: string[]; multiSelect: boolean }>; atMs: number }
interface EvidenceRun {
  runId: string
  attention: Attention | null
  question: Detail | null
  questionDetail: 'available' | 'focused-only'
  detailMatchesPolicy: boolean | null
  session: { sessionId: string; externalSessionId: string | null; pending: boolean } | null
  terminal: { stopped: boolean } | null
  error: string | null
}
interface AssessResult {
  issues: Array<{ runId: string; phase: string; error: string }>
  ready: boolean
  held: string[]
  pending: Array<{ runId: string; pendingCount: number | null; attentionUpdates: number; detail: string }>
}
interface AnswerResult {
  accepted: boolean
  questionId: string
  questionIdSource: string
  detail: string
  detailMatchesPolicy: boolean | null
  answers: Record<string, string>
  attentionPendingCount: number
}
interface DriverApi {
  evidence(runIds: string[]): { counts: Record<string, number>; runs: EvidenceRun[]; unattributedError: string | null }
  answer(runId: string): Promise<AnswerResult>
}
interface HostModule {
  TRACE_QUESTION: TraceQuestion
  questionPolicy(runId: string, policy: TraceQuestion): Policy
  assessEvidence(input: { runs: EvidenceRun[]; runIds: string[]; expectedPending?: number }): AssessResult
  installLiveHostDriver(policy?: TraceQuestion, policyFor?: (runId: string, policy: TraceQuestion) => Policy): { installed: boolean; listeners: number }
}

type Handler = (event: Record<string, unknown>) => void

let hostModule: HostModule
let answered: Array<Record<string, unknown>>
let handlers: Record<'session' | 'attention' | 'question' | 'terminal' | 'error', Handler[]>
let windowStub: Record<string, unknown>
let driver: DriverApi

const RUNS = ['run-0', 'run-1', 'run-2', 'run-3']

beforeAll(async () => {
  hostModule = await import(new URL('./fixtures/concurrency-trace-live-host.mjs', import.meta.url).href) as HostModule
})

beforeEach(() => {
  answered = []
  handlers = { session: [], attention: [], question: [], terminal: [], error: [] }
  windowStub = {
    scry: {
      onSession: (callback: Handler) => { handlers.session.push(callback); return () => undefined },
      onQuestionAttention: (callback: Handler) => { handlers.attention.push(callback); return () => undefined },
      onQuestion: (callback: Handler) => { handlers.question.push(callback); return () => undefined },
      onTurnDone: (callback: Handler) => { handlers.terminal.push(callback); return () => undefined },
      onError: (callback: Handler) => { handlers.error.push(callback); return () => undefined },
      start: async (request: { prompt: string }) => ({ runId: `${request.prompt}-run`, externalSessionId: 'ext' }),
      answerQuestion: async (response: Record<string, unknown>) => { answered.push(response); return true },
      activeRuns: async () => [],
      stats: async () => ({ status: 'measured', totals: { turns: 0 } })
    }
  }
  ;(globalThis as { window?: unknown }).window = windowStub
  const installed = hostModule.installLiveHostDriver(hostModule.TRACE_QUESTION, hostModule.questionPolicy)
  expect(installed.installed).toBe(true)
  driver = (windowStub as { __scryLiveHost: DriverApi }).__scryLiveHost
})

const emit = (channel: keyof typeof handlers, event: Record<string, unknown>) => { for (const handler of handlers[channel]) handler(event) }

function withSession(runId: string, { pending = false } = {}) {
  emit('session', { runId, sessionId: `session-${runId}`, externalSessionId: `ext-${runId}`, providerId: 'codex', pending })
}

function withAttention(runId: string, pendingCount: number) {
  emit('attention', { runId, pendingCount })
}

function withDetail(runId: string, overrides: Record<string, unknown> = {}) {
  emit('question', {
    runId,
    questionId: `${runId}:concurrency-trace`,
    providerId: 'codex',
    questions: [{ header: 'Concurrency trace', question: 'Continue the concurrency trace fixture?', options: [], multiSelect: false }],
    ...overrides
  })
}

const assess = () => hostModule.assessEvidence({ runs: driver.evidence(RUNS).runs, runIds: RUNS })

describe('live lane host question evidence', () => {
  it('treats the broadcast attention as the held evidence, not the focused detail', () => {
    for (const runId of RUNS) {
      withSession(runId)
      withAttention(runId, 1)
    }
    // Production only sends the detail payload to the focused run.
    withDetail('run-1')
    const result = assess()
    expect(result.issues).toEqual([])
    expect(result.ready).toBe(true)
    expect(result.held).toEqual(RUNS)
    const runs = driver.evidence(RUNS).runs
    expect(runs.map((run) => run.questionDetail)).toEqual(['focused-only', 'available', 'focused-only', 'focused-only'])
    expect(runs[1].detailMatchesPolicy).toBe(true)
    expect(runs[0].detailMatchesPolicy).toBeNull()
    expect(result.pending[0]).toMatchObject({ runId: 'run-0', pendingCount: 1, detail: 'focused-only' })
  })

  it('is not ready while a run has no pending question, no session or no external session id', () => {
    for (const runId of RUNS) {
      withSession(runId)
      withAttention(runId, runId === 'run-2' ? 0 : 1)
    }
    const zeroPending = assess()
    expect(zeroPending.ready).toBe(false)
    expect(zeroPending.held).toEqual(['run-0', 'run-1', 'run-3'])
    expect(zeroPending.pending.find((entry) => entry.runId === 'run-2')?.pendingCount).toBe(0)

    withAttention('run-2', 1)
    expect(assess().ready).toBe(true)

    // This lane asks exactly one question per run, so a second pending question is not the
    // held evidence this lane waits for.
    withAttention('run-0', 2)
    const twoPending = assess()
    expect(twoPending.ready).toBe(false)
    expect(twoPending.held).not.toContain('run-0')
    expect(twoPending.pending.find((entry) => entry.runId === 'run-0')?.pendingCount).toBe(2)
    withAttention('run-0', 1)
    expect(assess().ready).toBe(true)

    // A pending session update (not yet recorded) is not held evidence either.
    withSession('run-3', { pending: true })
    expect(assess().held).toEqual(['run-0', 'run-1', 'run-2'])
  })

  it('reports an error or a premature terminal immediately', () => {
    for (const runId of RUNS) {
      withSession(runId)
      withAttention(runId, 1)
    }
    emit('error', { runId: 'run-2', message: 'provider failed' })
    const withError = assess()
    expect(withError.ready).toBe(false)
    expect(withError.issues).toEqual([{ runId: 'run-2', phase: 'error', error: 'provider failed' }])

    // A terminal while no pending question attention is recorded is its own failure. This says
    // nothing about history: the latest attention count for run-3 is zero right now.
    withAttention('run-3', 0)
    emit('terminal', { runId: 'run-3', stopped: false })
    const premature = assess()
    expect(premature.ready).toBe(false)
    expect(premature.issues.filter((issue) => issue.runId === 'run-3').map((issue) => issue.phase)).toEqual(['terminal-before-question'])
    expect(premature.issues.find((issue) => issue.runId === 'run-3')?.error).toMatch(/pendingCount 0, expected exactly 1/)
    expect(premature.held).not.toContain('run-3')

    // A run whose latest attention count is the one expected question, and which then completed,
    // is simply no longer held: that is the normal post-answer state, not an issue for it.
    emit('terminal', { runId: 'run-1', stopped: false })
    const completed = assess()
    expect(completed.held).not.toContain('run-1')
    expect(completed.issues.filter((issue) => issue.runId === 'run-1')).toEqual([])
    // run-3's original failure is still reported; the per-run assertion above is what changed.
    expect(completed.issues.filter((issue) => issue.runId === 'run-3').map((issue) => issue.phase)).toEqual(['terminal-before-question'])
  })

  it('answers a focused-only run from the fixture policy and records that provenance', async () => {
    withSession('run-0')
    withAttention('run-0', 1)
    const result = await driver.answer('run-0')
    expect(result).toMatchObject({
      accepted: true,
      questionId: 'run-0:concurrency-trace',
      questionIdSource: 'fixture-policy',
      detail: 'focused-only',
      detailMatchesPolicy: null,
      attentionPendingCount: 1
    })
    expect(answered).toEqual([{
      runId: 'run-0',
      questionId: 'run-0:concurrency-trace',
      behavior: 'answered',
      answers: { 'Continue the concurrency trace fixture?': 'continue' }
    }])
  })

  it('refuses to answer without pending attention or with a detail that breaks the policy', async () => {
    withSession('run-0')
    await expect(driver.answer('run-0')).rejects.toThrow(/no pending question attention/)
    withAttention('run-0', 1)
    withDetail('run-0', { questionId: 'run-0:other-question' })
    await expect(driver.answer('run-0')).rejects.toThrow(/detail questionId/)
    expect(answered).toEqual([])
    const runs = driver.evidence(['run-0']).runs
    expect(runs[0].detailMatchesPolicy).toBe(false)
  })

  it('keeps the question id policy-derived per run', () => {
    expect(hostModule.questionPolicy('run-7', hostModule.TRACE_QUESTION)).toEqual({
      questionId: 'run-7:concurrency-trace',
      question: 'Continue the concurrency trace fixture?',
      answer: 'continue'
    })
    expect(hostModule.TRACE_QUESTION.text).toBe('Continue the concurrency trace fixture?')
  })
})
