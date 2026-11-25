import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionMessages: vi.fn(async () => [] as unknown[])
}))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query,
  getSessionMessages: sdk.getSessionMessages,
  forkSession: vi.fn()
}))
vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/qodercli',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))
vi.mock('../process-diagnostics', async () => {
  const actual = await vi.importActual<typeof import('../process-diagnostics')>('../process-diagnostics')
  return { ...actual, captureProcessIdentity: vi.fn(async () => undefined), signalProcessTreeWithIdentity: vi.fn() }
})

/** A fake CLI: one process answers every user message it receives on the prompt stream. */
function fakeCli(nativeSessionId = 'native-1', onTurn?: (turn: number, options: Record<string, unknown>) => void) {
  const seen: string[] = []
  let turn = 0
  const close = vi.fn(async () => undefined)
  const interrupt = vi.fn(async () => undefined)
  async function* serve(
    prompt: AsyncIterable<{ message: { content: { text: string }[] } }>,
    options: Record<string, unknown>
  ) {
    for await (const message of prompt) {
      turn += 1
      seen.push(message.message.content[0].text)
      yield { type: 'system', subtype: 'init', session_id: nativeSessionId, mcp_servers: [] }
      onTurn?.(turn, options)
      yield { type: 'result', subtype: 'success', session_id: nativeSessionId }
    }
  }
  return {
    create: (input: { prompt: AsyncIterable<{ message: { content: { text: string }[] } }>; options?: Record<string, unknown> }) => {
      const iterator = serve(input.prompt, input.options ?? {})
      return { [Symbol.asyncIterator]: () => iterator, close, interrupt }
    },
    seen,
    close,
    interrupt
  }
}

const { createQoderAdapter } = await import('./qoder')
const { createQoderSessionPool } = await import('./qoder-session-pool')

const runInput = (runId: string, prompt: string) => ({
  runId, prompt, cwd: '/repo', attachments: [] as never[], emit: () => {}
})

describe('Qoder kept session in the run path', () => {
  beforeEach(() => { sdk.query.mockReset(); sdk.getSessionMessages.mockReset().mockResolvedValue([]) })

  it('R3: two new conversations in one workspace never share a CLI process', async () => {
    const clis = [fakeCli('native-a'), fakeCli('native-b')]
    let opened = 0
    sdk.query.mockImplementation((input: never) => clis[opened++]!.create(input))
    const openedKeys: string[] = []
    const released: string[] = []
    const native: string[] = []
    const pool = createQoderSessionPool({
      provider: 'qoder_cli',
      idleMs: 60_000,
      observer: {
        onOpened: (key) => openedKeys.push(key),
        onReleased: (key, reason) => released.push(`${key}:${reason}`),
        onNativeSessionId: (key, id) => native.push(`${key}:${id}`)
      }
    })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const first = await adapter.run(runInput('run-1', 'first')).promise
    const second = await adapter.run(runInput('run-2', 'second')).promise

    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    // Two new conversations are two sessions: sharing one streamed B's prompt into A's context.
    expect(sdk.query).toHaveBeenCalledTimes(2)
    expect(clis[0]!.seen).toEqual(['first'])
    expect(clis[1]!.seen).toEqual(['second'])
    expect(openedKeys).toHaveLength(2)
    expect(native.map((entry) => entry.slice(entry.lastIndexOf(':') + 1))).toEqual(['native-a', 'native-b'])
    await pool.disposeAll()
    expect(released.map((entry) => entry.slice(entry.lastIndexOf(':') + 1))).toEqual(['dispose', 'dispose'])
  })

  it('R3: the second turn of one conversation reuses the same CLI process', async () => {
    const cli = fakeCli('native-1')
    sdk.query.mockImplementation((input: never) => cli.create(input))
    const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const first = await adapter.run(runInput('run-1', 'first')).promise
    expect(first.status).toBe('completed')
    // The native id is what the App sends back as `resume` on the next turn.
    const resumed = await adapter.run({ ...runInput('run-2', 'second'), resume: 'native-1' }).promise

    expect(resumed.status).toBe('completed')
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(cli.seen).toEqual(['first', 'second'])
    await pool.disposeAll()
  })

  it('R3: the second turn receives the permission request, not the finished first turn', async () => {
    const asks: string[] = []
    const cli = fakeCli('native-1', (turn, options) => {
      if (turn !== 2) return
      const canUseTool = options.canUseTool as ((tool: string, input: Record<string, unknown>, permission: unknown) => Promise<unknown>) | undefined
      void canUseTool?.('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
        .then((answer) => { asks.push(`answer:${JSON.stringify(answer)}`) },
          (error: unknown) => { asks.push(`error:${String(error)}`) })
    })
    sdk.query.mockImplementation((input: never) => cli.create(input))
    const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const firstAsks: string[] = []
    const secondAsks: string[] = []
    const requestUserInput = (asksInto: string[]) =>
      async (input: { questions?: { question?: string }[] }) => {
        asksInto.push(input.questions?.[0]?.question ?? 'asked')
        return { behavior: 'allow' as const, updatedInput: {} }
      }

    await adapter.run({ ...runInput('run-1', 'first'), requestUserInput: requestUserInput(firstAsks) } as never).promise
    await adapter.run({
      ...runInput('run-2', 'second'), resume: 'native-1', requestUserInput: requestUserInput(secondAsks)
    } as never).promise

    // The session's permission hook is the current turn's, so the question goes to turn 2 only.
    expect(secondAsks).toHaveLength(1)
    expect(firstAsks).toHaveLength(0)
    expect(sdk.query).toHaveBeenCalledOnce()
    await pool.disposeAll()
  })

  it.each([{ cwd: '/other-repo' }, { agentProfileId: 'alternate' }, { managedRecorder: true }])(
    'does not reuse a Qoder process across launch contexts: %j', async (changed) => {
      const cli = fakeCli()
      sdk.query.mockImplementation((input: never) => cli.create(input))
      const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
      const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })
      try {
        await adapter.run(runInput('run-1', 'first')).promise
        await adapter.run({ ...runInput('run-2', 'second'), resume: 'native-1', ...changed }).promise
        expect(sdk.query).toHaveBeenCalledTimes(2)
      } finally { await pool.disposeAll() }
    }
  )

  it('opens a new process when the turn asks for different options', async () => {
    const cli = fakeCli()
    sdk.query.mockImplementation((input: never) => cli.create(input))
    const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    await adapter.run({ ...runInput('run-3', 'a'), permissionMode: 'default' }).promise
    await adapter.run({ ...runInput('run-4', 'b'), permissionMode: 'auto_accept_edits' }).promise
    expect(sdk.query).toHaveBeenCalledTimes(2)
    await pool.disposeAll()
  })

  it('C3: the answer ends the turn while a child runs, and the child wakes the session', async () => {
    // One process: init, a backgrounded Bash receipt, the answer — then, after the run ended, the
    // child's own report. The run must resolve at the answer, and the report must become a wake.
    const wake = vi.fn()
    let releaseChild: (() => void) | undefined
    const childReported = new Promise<void>((resolve) => { releaseChild = resolve })
    sdk.query.mockImplementation((input: { prompt: AsyncIterable<unknown> }) => ({
      async *[Symbol.asyncIterator]() {
        const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
        await iterator.next()
        yield { type: 'system', subtype: 'init', session_id: 'native-1', mcp_servers: [] }
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash-1', input: { run_in_background: true } }] } }
        yield {
          type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'running' }] },
          tool_use_result: { kind: 'backgrounded', taskId: 'child-1' }
        }
        yield { type: 'result', subtype: 'success', session_id: 'native-1', result: 'started' }
        await childReported
        yield { type: 'system', subtype: 'task_notification', task_id: 'child-1', status: 'completed' }
        await iterator.next()
      },
      getContextUsage: vi.fn(async () => undefined)
    }))
    const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const run = await adapter.run({ ...runInput('run-bg', 'start it'), onBackgroundWake: wake } as never).promise
    // The answer stands on its own: the run is over before the child reports anything.
    if (run.status !== 'completed') console.log('RUNFAIL', JSON.stringify(run).slice(0, 600))
    expect(run.status).toBe('completed')
    expect(wake).not.toHaveBeenCalled()

    releaseChild?.()
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(wake.mock.calls[0][0]).toMatchObject({ taskIds: ['child-1'], reason: 'terminal', cwd: '/repo' })
    await pool.disposeAll()
  })

  it('C2: admits a steer on the live kept session, and refuses one after the turn ended', async () => {
    const seen: string[] = []
    let firstConsumed: () => void = () => {}
    const sawFirst = new Promise<void>((resolve) => { firstConsumed = resolve })
    sdk.query.mockImplementation((input: { prompt: AsyncIterable<{ message: { content: { text: string }[] } }> }) => ({
      async *[Symbol.asyncIterator]() {
        const iterator = input.prompt[Symbol.asyncIterator]()
        const first = await iterator.next()
        seen.push(first.value.message.content[0].text)
        yield { type: 'system', subtype: 'init', session_id: 'native-1', mcp_servers: [] }
        firstConsumed()
        // The steer arrives on the same stream, mid-turn; the turn ends after it.
        const second = await iterator.next()
        seen.push(second.value.message.content[0].text)
        yield { type: 'result', subtype: 'success', session_id: 'native-1' }
      },
      getContextUsage: vi.fn(async () => undefined)
    }))
    const stages: (string | undefined)[] = []
    const pool = createQoderSessionPool({ provider: 'qoder_cli', idleMs: 60_000 })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const handle = adapter.run({
      ...runInput('run-steer', 'first'),
      emit: (event: { stage?: string }) => stages.push(event.stage)
    } as never)
    await sawFirst
    expect(stages).toContain('runtime:steer_capability')
    // Live turn: the message is admitted into this session's input stream.
    await expect(handle.steer?.({ messageId: 'msg-1', prompt: 'also check the test', attachments: [] }))
      .resolves.toEqual({ status: 'accepted' })
    const run = await handle.promise
    expect(run.status).toBe('completed')
    expect(seen).toEqual(['first', 'also check the test'])

    // The turn is over: admitting more input would invent a turn nobody asked for.
    await expect(handle.steer?.({ messageId: 'late', prompt: 'too late', attachments: [] }))
      .resolves.toMatchObject({ status: 'unavailable' })
    await pool.disposeAll()
  })
})
