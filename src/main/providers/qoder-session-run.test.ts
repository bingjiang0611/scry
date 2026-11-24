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
function fakeCli() {
  const seen: string[] = []
  const close = vi.fn(async () => undefined)
  const interrupt = vi.fn(async () => undefined)
  async function* serve(prompt: AsyncIterable<{ message: { content: { text: string }[] } }>) {
    for await (const message of prompt) {
      seen.push(message.message.content[0].text)
      yield { type: 'system', subtype: 'init', session_id: 'native-1', mcp_servers: [] }
      yield { type: 'result', subtype: 'success', session_id: 'native-1' }
    }
  }
  return {
    create: (input: { prompt: AsyncIterable<{ message: { content: { text: string }[] } }> }) => {
      const iterator = serve(input.prompt)
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

  it('serves two turns of one conversation from a single CLI process', async () => {
    const cli = fakeCli()
    sdk.query.mockImplementation((input: never) => cli.create(input))
    const opened: string[] = []
    const released: string[] = []
    const native: string[] = []
    const pool = createQoderSessionPool({
      provider: 'qoder_cli',
      idleMs: 60_000,
      observer: {
        onOpened: (key) => opened.push(key),
        onReleased: (key, reason) => released.push(`${key}:${reason}`),
        onNativeSessionId: (key, id) => native.push(`${key}:${id}`)
      }
    })
    const adapter = createQoderAdapter('/home/test', { qoderSessions: pool })

    const first = await adapter.run(runInput('run-1', 'first')).promise
    const second = await adapter.run(runInput('run-2', 'second')).promise

    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    // One process, two turns: the second run reuses the session instead of spawning again.
    expect(sdk.query).toHaveBeenCalledOnce()
    expect(cli.seen).toEqual(['first', 'second'])
    expect(opened).toHaveLength(1)
    expect(native.every((entry) => entry.endsWith(':native-1'))).toBe(true)
    await pool.disposeAll()
    expect(released.map((entry) => entry.slice(entry.lastIndexOf(':') + 1))).toEqual(['dispose'])
  })

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
})
