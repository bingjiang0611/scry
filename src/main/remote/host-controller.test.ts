import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { HostController, type HostControllerDependencies, type MacRunView, type RemoteIntentRouting } from './host-controller'
import type { IssuedPairingCertificate, PairingDependencies, PairingPersistence, PairingState } from './pairing'
import type { LedgerEvent, LedgerStore } from './session-ledger'
import type { WorkspaceAuthorizer } from './remote-run-policy'

const KEY = 'a'.repeat(64)
const CSR = 'b'.repeat(64)
const ANCHOR = 'c'.repeat(64)
const CERT = 'd'.repeat(64)
const AUTHORIZED = '/authorized/project'

class MemoryPairingStore implements PairingPersistence {
  value: PairingState | undefined
  assertAvailable(): void {}
  load(): unknown { return structuredClone(this.value) }
  commit(state: PairingState): void { this.value = structuredClone(state) }
}
class MemoryLedgerStore implements LedgerStore {
  log: LedgerEvent[] = []
  assertAvailable(): void {}
  loadAll(): LedgerEvent[] { return this.log.map((e) => ({ ...e })) }
  append(event: LedgerEvent): void { this.log.push({ ...event }) }
}

const workspace: WorkspaceAuthorizer = {
  authorize(cwd) { if (cwd !== AUTHORIZED) throw new Error('not authorized'); return cwd }
}

function pairingDeps(): PairingDependencies {
  const time = { wall: 1_000_000, monotonic: 0 }
  const issue = vi.fn(async ({ deviceId }: { deviceId: string }): Promise<IssuedPairingCertificate> => ({
    deviceId, certificatePEM: 'synthetic certificate, not cryptographic evidence', certificateSHA256: CERT,
    publicKeySHA256: KEY, expiresAt: time.wall + 3_600_000
  }))
  return {
    store: new MemoryPairingStore(), hostId: randomUUID(), anchorSHA256: ANCHOR,
    clock: () => time.wall, monotonic: () => time.monotonic,
    verifyCSR: vi.fn(async (csrPEM: string) => ({ csrPEM, csrSHA256: CSR, publicKeySHA256: KEY })), issue
  }
}

type RunProvider = (input: { runId: string; routing: RemoteIntentRouting; progress(detail?: string): void }) => Promise<void>

async function grantedController(runProvider: RunProvider, listProjects?: () => { path: string; label: string }[],
  extra: Partial<HostControllerDependencies> = {}) {
  const controller = new HostController({
    pairing: pairingDeps(), ledgerStore: new MemoryLedgerStore(), workspace, runProvider,
    ...(listProjects ? { listProjects } : {}),
    ...extra
  })
  const pair = await controller.authority.begin()
  await controller.authority.prove({ pairingId: pair.pairingId, secret: pair.secret, csrPEM: 'CSR', deviceLabel: 'iPhone' }, KEY)
  const grant = await controller.authority.confirmLocal(pair.pairingId, KEY)
  return { controller, deviceId: grant.deviceId }
}

const routing = (over: Partial<RemoteIntentRouting> = {}): string =>
  JSON.stringify({ cwd: AUTHORIZED, providerId: 'claude', ...over })

describe('HostController (composition root)', () => {
  it('runs a routed intent end-to-end through the real modules and reflects settlement', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting; progress(d?: string): void }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)

    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ship it' }) })
    expect(submit.status).toBe('recorded')
    await controller.idle()

    expect(seen).toEqual([{ cwd: AUTHORIZED, providerId: 'claude', prompt: 'ship it' }])
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('settled')
    const feed = controller.poll(CERT, { cursor: 0 })
    expect(feed.events.map((e) => e.kind)).toEqual(['intent_recorded', 'run_dispatched', 'run_settled'])
  })

  it('accepts bounded explicit run controls and rejects invalid permission modes', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({
      prompt: 'go', modelId: 'gpt-5.4', modelProviderId: 'openai', effort: 'high', permissionMode: 'full_access'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0]).toMatchObject({ modelId: 'gpt-5.4', modelProviderId: 'openai', effort: 'high', permissionMode: 'full_access' })

    const rejected = controller.submitIntent(CERT, { intentId: randomUUID(), detail: JSON.stringify({
      cwd: AUTHORIZED, providerId: 'claude', prompt: 'go', permissionMode: 'invented'
    }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: rejected.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('accepts bounded encrypted image/text attachments and rejects malformed payloads before Provider execution', async () => {
    const seen: RemoteIntentRouting[] = []
    const runProvider = vi.fn(async ({ routing }: { routing: RemoteIntentRouting }) => { seen.push(routing) })
    const { controller } = await grantedController(runProvider)
    const image = { kind: 'image' as const, name: 'screen.jpg', mimeType: 'image/jpeg', dataBase64: '/9j/', size: 3 }
    const text = { kind: 'text' as const, name: 'error.log', mimeType: 'text/plain', dataBase64: 'Ym9vbQ==', size: 4 }
    const accepted = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'inspect', attachments: [image, text] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: accepted.runId })).toBe('settled')
    expect(seen[0].attachments).toEqual([image, text])

    const fourKiB = Buffer.alloc(4 * 1024, 0x61)
    const realSizedText = {
      kind: 'text' as const,
      name: 'context.txt',
      mimeType: 'text/plain',
      dataBase64: fourKiB.toString('base64'),
      size: fourKiB.length
    }
    const realSized = controller.submitIntent(CERT, {
      intentId: randomUUID(),
      detail: routing({ prompt: 'inspect context', attachments: [realSizedText] })
    })
    await controller.idle()
    expect(controller.runState(CERT, { runId: realSized.runId })).toBe('settled')
    expect(seen[1].attachments).toEqual([realSizedText])

    const malformed = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ attachments: [{ ...image, size: 99 }] }) })
    await controller.idle()
    expect(controller.runState(CERT, { runId: malformed.runId })).toBe('failed')
    expect(runProvider).toHaveBeenCalledTimes(2)
  })

  it('records the intent but fails the run for an unauthorized workspace (never reaching the provider)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ cwd: '/tmp/smuggled' }) })
    await controller.idle()
    expect(runProvider).not.toHaveBeenCalled()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
    const failed = controller.poll(CERT, { cursor: 0 }).events.find((e) => e.kind === 'run_failed')
    expect(failed?.detail).toContain('workspace_not_authorized')
  })

  it('fails the run truthfully when the provider throws', async () => {
    const runProvider = vi.fn(async () => { throw new Error('provider exploded') })
    const { controller } = await grantedController(runProvider)
    const submit = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })
    await controller.idle()
    expect(controller.runState(CERT, { runId: submit.runId })).toBe('failed')
  })

  it('is idempotent on intentId: a retry does not re-run the provider', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller } = await grantedController(runProvider)
    const intentId = randomUUID()
    const first = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    const retry = controller.submitIntent(CERT, { intentId, detail: routing() })
    await controller.idle()
    expect(retry).toEqual({ runId: first.runId, status: 'duplicate' })
    expect(runProvider).toHaveBeenCalledTimes(1)
  })

  it('exposes host-authorized projects only to the granted device (delegates to the gateway)', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider, () => [{ path: AUTHORIZED, label: 'project' }])
    expect(controller.listProjects(CERT)).toEqual([{ path: AUTHORIZED, label: 'project' }])
    expect(() => controller.listProjects('f'.repeat(64))).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.listProjects(CERT)).toThrowError(/device_not_authorized/)
  })

  it('returns an honest empty project list when no source is injected', async () => {
    const { controller } = await grantedController(vi.fn(async () => {}))
    expect(controller.listProjects(CERT)).toEqual([])
  })

  it('denies a stranger certificate and a revoked device', async () => {
    const runProvider = vi.fn(async () => {})
    const { controller, deviceId } = await grantedController(runProvider)
    expect(() => controller.submitIntent('f'.repeat(64), { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    await controller.authority.revoke(deviceId)
    expect(() => controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing() })).toThrowError(/device_not_authorized/)
    expect(runProvider).not.toHaveBeenCalled()
  })
})

describe('HostController live watch and stop', () => {
  type LiveInput = { runId: string; progress(d?: string): void; output(chunk: { kind: 'output'; text: string }): void; stopSignal: AbortSignal }

  it('long-polls until new output arrives instead of returning an empty page', async () => {
    let emit: ((text: string) => void) | undefined
    let finish: (() => void) | undefined
    const runProvider = vi.fn(async (input: LiveInput) => {
      emit = (text) => input.output({ kind: 'output', text })
      await new Promise<void>((resolve) => { finish = resolve })
    })
    const { controller } = await grantedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await vi.waitFor(() => expect(emit).toBeDefined())
    const first = await controller.watchRun(CERT, { runId, cursor: 0, outputCursor: 0, waitMs: 0 })
    expect(first.state).toBe('dispatched')

    const started = Date.now()
    const waiting = controller.watchRun(CERT, { runId, cursor: first.poll.cursor, outputCursor: first.output.cursor, waitMs: 5_000 })
    setTimeout(() => emit!('hello'), 50)
    const woke = await waiting
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(woke.output.chunks.map((chunk) => chunk.text)).toEqual(['hello'])
    expect(woke.poll.events).toEqual([])

    const idle = await controller.watchRun(CERT, { runId, cursor: woke.poll.cursor, outputCursor: woke.output.cursor, waitMs: 30 })
    expect(idle.output.chunks).toEqual([])
    finish!()
    await controller.idle()
    const done = await controller.watchRun(CERT, { runId, cursor: idle.poll.cursor, outputCursor: idle.output.cursor, waitMs: 5_000 })
    expect(done.state).toBe('settled')
  })

  it('rejects watch and stop for a revoked device', async () => {
    const { controller, deviceId } = await grantedController(async () => {})
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await controller.idle()
    await controller.authority.revoke(deviceId)
    await expect(controller.watchRun(CERT, { runId, cursor: 0, outputCursor: 0, waitMs: 0 })).rejects.toThrow()
    expect(() => controller.stopRun(CERT, { runId })).toThrow('device_not_authorized')
  })

  it('forwards a device stop to the running Provider and records the request, not a result', async () => {
    let stopped = false
    const runProvider = vi.fn(async (input: LiveInput) => {
      await new Promise<void>((resolve) => input.stopSignal.addEventListener('abort', () => { stopped = true; resolve() }))
    })
    const { controller } = await grantedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'go' }) })
    await vi.waitFor(() => expect(runProvider).toHaveBeenCalled())
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'requested' })
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'already_requested' })
    await controller.idle()
    expect(stopped).toBe(true)
    const kinds = controller.poll(CERT, { cursor: 0 }).events.map((event) => [event.kind, event.detail])
    expect(kinds).toContainEqual(['run_progress', JSON.stringify({ event: 'stop_requested' })])
    expect(controller.runState(CERT, { runId })).toBe('settled')
    expect(controller.stopRun(CERT, { runId })).toEqual({ status: 'not_running' })
  })
})

describe('HostController live runs (multi-task and Mac runs)', () => {
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

  it('lists concurrent remote runs with their Provider session and settles them out of the list', async () => {
    const finishes: Array<() => void> = []
    const runProvider = vi.fn(async (input: LiveInput) => {
      input.progress(JSON.stringify({ event: 'session', externalSessionId: `ext-${finishes.length}` }))
      await new Promise<void>((resolve) => finishes.push(resolve))
    })
    const { controller } = await grantedController(runProvider as unknown as RunProvider)
    const a = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'first task' }) })
    const b = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'second task', resume: 'ext-old' }) })
    await vi.waitFor(() => expect(finishes).toHaveLength(2))

    const live = await controller.liveRuns(CERT, { waitMs: 0 })
    expect(live.runs.map((run) => [run.origin, run.prompt, run.state]).sort()).toEqual([
      ['remote', 'first task', 'running'], ['remote', 'second task', 'running']
    ])
    expect(live.runs.every((run) => run.cwd === AUTHORIZED && run.externalSessionId?.startsWith('ext-'))).toBe(true)
    expect(live.runs.every((run) => run.questions.length === 0)).toBe(true)

    // Unchanged list: the long-poll waits; a settled run wakes it promptly.
    const started = Date.now()
    const waiting = controller.liveRuns(CERT, { revision: live.revision, waitMs: 10_000 })
    setTimeout(() => finishes[0]!(), 50)
    const woke = await waiting
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(woke.runs).toHaveLength(1)
    expect(woke.revision).not.toBe(live.revision)
    finishes[1]!()
    await controller.idle()
    expect((await controller.liveRuns(CERT, { waitMs: 0 })).runs).toEqual([])
    expect([a.runId, b.runId].map((runId) => controller.runState(CERT, { runId }))).toEqual(['settled', 'settled'])
  })

  it('marks a remote run waiting while it has an open question', async () => {
    let answered: unknown
    const runProvider = vi.fn(async (input: LiveInput) => {
      answered = await input.requestUserInput(question(input.runId), input.stopSignal)
    })
    const { controller } = await grantedController(runProvider as unknown as RunProvider)
    const { runId } = controller.submitIntent(CERT, { intentId: randomUUID(), detail: routing({ prompt: 'ask me' }) })
    await vi.waitFor(async () => expect((await controller.liveRuns(CERT, { waitMs: 0 })).runs[0]?.state).toBe('waiting'))
    expect((await controller.liveRuns(CERT, { waitMs: 0 })).runs[0]?.questions.map((q) => q.questionId)).toEqual(['q1'])
    controller.answerQuestion(CERT, { runId, answerId: randomUUID(), response: { runId, questionId: 'q1', behavior: 'answered', answers: { 'Which?': 'A' } } as never })
    await controller.idle()
    expect(answered).toMatchObject({ behavior: 'answered' })
  })

  it('exposes only authorized Mac runs and routes device stop/answer to the Mac controls', async () => {
    const macRun: MacRunView = { runId: 'run-abc123-7', providerId: 'claude', cwd: AUTHORIZED, externalSessionId: 'mac-ext',
      prompt: 'x'.repeat(500), questions: [question('run-abc123-7')], stopping: false }
    const hidden: MacRunView = { ...macRun, runId: 'run-abc123-8', cwd: '/elsewhere', questions: [] }
    const source = macSource([macRun, hidden])
    const { controller } = await grantedController(async () => {}, undefined, { macRuns: source })

    const live = await controller.liveRuns(CERT, { waitMs: 0 })
    expect(live.runs).toHaveLength(1)
    expect(live.runs[0]).toMatchObject({ origin: 'mac', runId: 'run-abc123-7', state: 'waiting', externalSessionId: 'mac-ext' })
    expect(live.runs[0]!.prompt).toHaveLength(200)
    expect(live.runs[0]!.questions).toHaveLength(1)

    // Unauthorized project: neither visible nor controllable.
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

  it('denies live runs to a revoked device', async () => {
    const { controller, deviceId } = await grantedController(async () => {}, undefined, { macRuns: macSource([]) })
    await controller.authority.revoke(deviceId)
    await expect(controller.liveRuns(CERT, { waitMs: 0 })).rejects.toThrow('device_not_authorized')
  })
})

describe('HostController history version joined to the live-runs long-poll', () => {
  it('waits while the version is unchanged and returns as soon as it changes, re-authorizing each pass', async () => {
    let version = 'v1'
    const readHistoryVersion = vi.fn(async () => ({ version, readMode: 'indexed' as const }))
    const { controller, deviceId } = await grantedController(async () => {}, undefined, { readHistoryVersion })
    const query = { providerId: 'pi', cwd: AUTHORIZED, externalSessionId: 'ext' }
    const first = await controller.liveRuns(CERT, { waitMs: 10_000, history: { query } })
    expect(first.historyVersion?.version).toBe('v1')

    const started = Date.now()
    const waiting = controller.liveRuns(CERT, { revision: first.revision, waitMs: 10_000, history: { query, known: 'v1' } })
    setTimeout(() => { version = 'v2' }, 50)
    expect((await waiting).historyVersion?.version).toBe('v2')
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(readHistoryVersion.mock.calls.length).toBeGreaterThan(2)

    const idle = await controller.liveRuns(CERT, { revision: first.revision, waitMs: 30, history: { query, known: 'v2' } })
    expect(idle.historyVersion?.version).toBe('v2')
    await controller.authority.revoke(deviceId)
    await expect(controller.liveRuns(CERT, { revision: first.revision, waitMs: 10_000, history: { query, known: 'v2' } })).rejects.toThrow()
  })
})
