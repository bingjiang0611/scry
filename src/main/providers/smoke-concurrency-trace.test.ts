import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentQuestionRequest, AgentQuestionResponse } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import { UserQuestionBroker, type UserQuestionChange } from '../user-question'
import { createSmokeProviderAdapter } from './smoke'

const RUN_ID = 'run-concurrency-trace'
const PROMPT = 'concurrency trace live'
const QUESTION_ID = `${RUN_ID}:concurrency-trace`
const QUESTION_TEXT = 'Continue the concurrency trace fixture?'
const SEED_COUNT = 1000
const PROVIDER_ID = 'codex'

const seedLabel = (index: number): string => String(index).padStart(4, '0')

function startRun(requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>) {
  const adapter = createSmokeProviderAdapter(PROVIDER_ID)
  const emitted: TraceEvent[] = []
  const handle = adapter.run({
    runId: RUN_ID,
    prompt: PROMPT,
    attachments: [],
    emit: (event) => { emitted.push(event) },
    ...(requestUserInput ? { requestUserInput } : {})
  })
  return { emitted, handle }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('smoke concurrency trace fixture', () => {
  // The packaged adapter writes to files named by these variables; the fixture runs
  // offline, so point the environment at "no receipts" for the whole file.
  const isolatedVariables = ['SCRY_ELECTRON_SMOKE_CALLS', 'SCRY_ELECTRON_SMOKE_INPUTS']
  let savedEnvironment: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnvironment = {}
    for (const name of isolatedVariables) {
      savedEnvironment[name] = process.env[name]
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('emits every ordered seed and the ready marker before asking, then completes after the answer', async () => {
    const changes: UserQuestionChange[] = []
    const broker = new UserQuestionBroker((change) => { changes.push(change) })
    const asked = deferred<{ question: AgentQuestionRequest; events: TraceEvent[] }>()
    const askedPrompts: AgentQuestionRequest[] = []
    const { emitted, handle } = startRun((request, signal) => {
      askedPrompts.push(request)
      const pending = broker.request(request, signal)
      asked.resolve({ question: request, events: [...emitted] })
      return pending
    })

    const { question, events: atQuestion } = await asked.promise

    // Everything the fixture promises is on the trace before the user is asked anything.
    expect(askedPrompts).toHaveLength(1)
    expect(atQuestion).toHaveLength(SEED_COUNT + 1)
    const seeds = atQuestion.slice(0, SEED_COUNT)
    expect(seeds.map((event) => event.id)).toEqual(
      Array.from({ length: SEED_COUNT }, (_value, offset) => `${RUN_ID}:concurrency-trace:${seedLabel(offset + 1)}`)
    )
    expect(seeds.map((event) => event.text)).toEqual(
      Array.from({ length: SEED_COUNT }, (_value, offset) => `concurrency trace seed ${seedLabel(offset + 1)}`)
    )
    expect(seeds.filter((event) => !(event.runId === RUN_ID && event.kind === 'harness' && event.stage === 'runtime:progress'))).toEqual([])
    expect(seeds.filter((event) => Number.isNaN(Date.parse(event.ts)))).toEqual([])
    expect(Object.keys(seeds[0]).sort()).toEqual(['id', 'kind', 'runId', 'stage', 'text', 'ts'])
    const seedIds = seeds.map((event) => event.id)
    expect(new Set(seedIds).size).toBe(SEED_COUNT)
    expect(seedIds).toEqual([...seedIds].sort())

    const marker = atQuestion[SEED_COUNT]
    expect(marker).toMatchObject({ id: `${RUN_ID}:concurrency-trace-ready`, runId: RUN_ID, kind: 'model', stage: 'text', text: 'concurrency trace ready' })
    expect(Object.keys(marker).sort()).toEqual(['id', 'kind', 'runId', 'stage', 'text', 'ts'])
    expect(atQuestion.filter((event) => event.kind !== 'harness' && event.kind !== 'model')).toEqual([])
    expect(atQuestion.filter((event) => event.kind === 'tool' || event.kind === 'skill' || event.kind === 'agent')).toEqual([])

    expect(question.runId).toBe(RUN_ID)
    expect(question.questionId).toBe(QUESTION_ID)
    expect(question.providerId).toBe(PROVIDER_ID)
    expect(question.questions).toEqual([
      { header: 'Concurrency trace', question: QUESTION_TEXT, options: [], multiSelect: false }
    ])
    expect(broker.list(RUN_ID).map((item) => item.questionId)).toEqual([QUESTION_ID])

    // A pending question must not settle the run.
    let settled = false
    const settlement = handle.promise.then(
      (result) => { settled = true; return result },
      (error) => { settled = true; throw error }
    )
    await setImmediate()
    expect(settled).toBe(false)

    expect(broker.answer({
      runId: RUN_ID,
      questionId: QUESTION_ID,
      behavior: 'answered',
      answers: { [QUESTION_TEXT]: 'continue' }
    })).toBe(true)
    expect(broker.list(RUN_ID)).toEqual([])

    await expect(settlement).resolves.toMatchObject({
      externalSessionId: `smoke-session-${RUN_ID}`,
      stopped: false,
      status: 'completed'
    })
    expect(changes).toMatchObject([
      { kind: 'open' },
      { kind: 'closed', intervention: { resolution: 'answered', response: { behavior: 'answered' } } }
    ])

    // The answered run continues into the shared tool and result tail instead of returning early.
    const tail = emitted.slice(SEED_COUNT + 1)
    expect(tail.map((event) => `${event.kind}:${event.stage}`)).toEqual(['tool:tool_use', 'tool:tool_result', 'harness:result'])
    expect(tail[2]).toMatchObject({ id: `${RUN_ID}:result`, text: 'smoke fixture completed' })
  })

  it('settles as interrupted through the real broker cancel contract when interrupted while waiting', async () => {
    const changes: UserQuestionChange[] = []
    const broker = new UserQuestionBroker((change) => { changes.push(change) })
    const asked = deferred<AgentQuestionRequest>()
    const { emitted, handle } = startRun((request, signal) => {
      const pending = broker.request(request, signal)
      asked.resolve(request)
      return pending
    })

    await asked.promise
    expect(broker.list(RUN_ID).map((item) => item.questionId)).toEqual([QUESTION_ID])

    handle.interrupt()

    await expect(handle.promise).resolves.toMatchObject({ status: 'interrupted', stopped: true })
    expect(changes).toMatchObject([
      { kind: 'open', request: { runId: RUN_ID, questionId: QUESTION_ID } },
      {
        kind: 'closed',
        runId: RUN_ID,
        questionId: QUESTION_ID,
        intervention: { resolution: 'provider_cancelled', response: { behavior: 'cancelled' } }
      }
    ])
    expect(emitted.slice(SEED_COUNT + 1).map((event) => `${event.kind}:${event.stage}:${event.text}`)).toEqual([
      `harness:result:fixture interrupted`
    ])
  })

  it('fails explicitly when the host provides no requestUserInput', async () => {
    const { emitted, handle } = startRun()
    await expect(handle.promise).rejects.toThrow('Concurrency trace fixture requires requestUserInput')
    expect(emitted.filter((event) => event.stage === 'runtime:progress')).toEqual([])
    expect(emitted.filter((event) => event.kind === 'model' && event.stage === 'text')).toEqual([])
  })
})
