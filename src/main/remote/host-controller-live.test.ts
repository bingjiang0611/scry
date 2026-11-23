import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { MacRunView } from './host-controller'
import { AUTHORIZED, CERT, grantedController, grantedProjectedController, routing, type RunProvider } from './host-controller-fixtures'

describe('HostController run output and stop', () => {
  type LiveInput = { runId: string; progress(d?: string): void; output(chunk: { kind: 'output'; text: string }): void; stopSignal: AbortSignal }

  it('returns only new run output and leaves the lifecycle authoritative', async () => {
    let emit!: (text: string) => void
    let finish!: () => void
    const { controller, projection } = await grantedProjectedController((async (input: LiveInput) => {
      emit = (text) => input.output({ kind: 'output', text })
      await new Promise<void>((resolve) => { finish = resolve })
    }) as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await vi.waitFor(() => expect(emit).toBeDefined())
    expect(projection.getRun(runId)?.lifecycle).toBe('dispatched')
    const first = await controller.runOutput(CERT, { runId, cursor: 0 })
    expect(first.chunks).toEqual([])
    emit('hello')
    const next = await controller.runOutput(CERT, { runId, cursor: first.cursor })
    expect(next.chunks.map((chunk) => chunk.text)).toEqual(['hello'])
    expect((await controller.runOutput(CERT, { runId, cursor: next.cursor })).chunks).toEqual([])
    finish()
    await controller.idle()
    expect(projection.getRun(runId)?.lifecycle).toBe('settled')
  })

  it('rejects output and stop for a revoked device', async () => {
    const { controller, deviceId } = await grantedController(async () => {})
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await controller.idle()
    await controller.authority.revoke(deviceId)
    await expect(controller.runOutput(CERT, { runId, cursor: 0 })).rejects.toThrow()
    expect(() => controller.stopRun(CERT, { runId })).toThrow('device_not_authorized')
  })

  it('forwards a device stop to the running Provider and records the request, not a result', async () => {
    let stopped = false
    const runProvider = vi.fn(async (input: LiveInput) => {
      await new Promise<void>((resolve) => input.stopSignal.addEventListener('abort', () => { stopped = true; resolve() }))
    })
    const { controller, projection, events } = await grantedProjectedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await vi.waitFor(() => expect(runProvider).toHaveBeenCalled())
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'requested' })
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'already_requested' })
    await controller.idle()
    expect(stopped).toBe(true)
    const kinds = events.map((event) => [event.kind, event.detail])
    expect(kinds).toContainEqual(['run_progress', JSON.stringify({ event: 'stop_requested' })])
    expect(projection.getRun(runId)?.lifecycle).toBe('settled')
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'not_running' })
  })
})

describe('HostController questions and Mac controls', () => {
  type LiveInput = { runId: string; progress(d?: string): void; requestUserInput(request: unknown, signal: AbortSignal): Promise<unknown>; stopSignal: AbortSignal }

  const question = (runId: string, questionId = 'q1') => ({
    runId, questionId, providerId: 'claude', questionKind: 'question',
    questions: [{ header: 'Pick', question: 'Which?', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }]
  }) as unknown as MacRunView['questions'][number]

  function macSource(runs: MacRunView[]) {
    return {
      list: () => runs,
      stop: vi.fn((runId: string) => runs.some((run) => run.runId === runId)),
      answer: vi.fn((response: { questionId?: string }) => runs.some((run) => run.questions.some((q) => q.questionId === response.questionId)))
    }
  }

  it('keeps a remote question pending until a device answers it', async () => {
    let answered: unknown
    const runProvider = vi.fn(async (input: LiveInput) => {
      answered = await input.requestUserInput(question(input.runId), input.stopSignal)
    })
    const { controller, projection } = await grantedProjectedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ask me' }) })
    await vi.waitFor(() => expect(projection.handle.db.prepare(
      "SELECT question_id FROM orch_p_interaction WHERE run_id = ? AND state = 'open'"
    ).all(runId)).toEqual([{ question_id: 'q1' }]))
    controller.answerQuestion(CERT, { runId, answerId: randomUUID(), response: { runId, questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'A' } } as never })
    await controller.idle()
    expect(answered).toMatchObject({ behavior: 'answered' })
  })

  it('lets the Mac owner answer a device-started question exactly once through the same broker', async () => {
    let answered: unknown
    const runProvider = vi.fn(async (input: LiveInput) => {
      answered = await input.requestUserInput(question(input.runId), input.stopSignal)
    })
    const { controller, projection } = await grantedProjectedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ask me' }) })
    await vi.waitFor(() => expect(projection.handle.db.prepare(
      "SELECT question_id FROM orch_p_interaction WHERE run_id = ? AND state = 'open'"
    ).all(runId)).toEqual([{ question_id: 'q1' }]))
    // The Mac renderer's response carries the scry runId; the owner path keys by ledger runId.
    expect(controller.answerOwnerQuestion(runId, { runId: 'remote-run-x-0', questionId: 'q-other', behavior: 'answered', answers: { 'Which?': 'A' } } as never)).toBe(false)
    expect(controller.answerOwnerQuestion(runId, { runId: 'remote-run-x-0', questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'A' } } as never)).toBe(true)
    await controller.idle()
    expect(answered).toMatchObject({ behavior: 'answered', answers: { 'Which?': 'A' } })
    // The device and a second Mac answer both see it settled; nothing answers twice.
    expect(() => controller.answerQuestion(CERT, { runId, answerId: randomUUID(), response: { runId, questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'A' } } as never }))
      .toThrow()
    expect(controller.answerOwnerQuestion(runId, { runId, questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'A' } } as never)).toBe(false)
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('routes device stop and answer only for authorized Mac runs', async () => {
    const macRun: MacRunView = { runId: 'run-abc123-7', providerId: 'claude', cwd: AUTHORIZED, externalSessionId: 'mac-ext',
      prompt: 'x'.repeat(500), questions: [question('run-abc123-7')], stopping: false }
    const hidden: MacRunView = { ...macRun, runId: 'run-abc123-8', cwd: '/elsewhere', questions: [] }
    const source = macSource([macRun, hidden])
    const { controller } = await grantedController(async () => {}, undefined, { macRuns: source })

    expect(() => controller.stopRun(CERT, { runId: hidden.runId })).toThrow('unknown_run')
    expect(source.stop).not.toHaveBeenCalled()

    expect(controller.stopRun(CERT, { runId: macRun.runId })).toEqual({ status: 'requested' })
    expect(source.stop).toHaveBeenCalledWith(macRun.runId)

    // A question id the run does not hold, or a response for another run, never reaches the broker.
    expect(() => controller.answerQuestion(CERT, { runId: macRun.runId, answerId: randomUUID(),
      response: { runId: macRun.runId, questionId: 'other', behavior: 'cancelled' } as never })).toThrow('question_not_pending')
    expect(() => controller.answerQuestion(CERT, { runId: macRun.runId, answerId: randomUUID(),
      response: { runId: hidden.runId, questionId: 'q1', behavior: 'cancelled' } as never })).toThrow('question_not_pending')
    expect(source.answer).not.toHaveBeenCalled()
    const response = { runId: macRun.runId, questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'B' } }
    expect(controller.answerQuestion(CERT, { runId: macRun.runId, answerId: randomUUID(), response: response as never }))
      .toEqual({ status: 'answered' })
    expect(source.answer).toHaveBeenCalledWith(response)

    // Already settled on the Mac side: report the truth, not success.
    source.answer.mockReturnValueOnce(false)
    expect(() => controller.answerQuestion(CERT, { runId: macRun.runId, answerId: randomUUID(), response: response as never }))
      .toThrow('question_not_pending')
    // An already-stopping Mac run is not stopped twice.
    macRun.stopping = true
    expect(controller.stopRun(CERT, { runId: macRun.runId })).toEqual({ status: 'already_requested' })
    expect(source.stop).toHaveBeenCalledTimes(1)
  })
})
