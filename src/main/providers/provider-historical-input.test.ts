import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TraceEvent } from '../../shared/trace'
import type { ProviderAdapter, ProviderRunRequest } from './types'

const sdk = vi.hoisted(() => ({ query: vi.fn(), getSessionMessages: vi.fn(), forkSession: vi.fn() }))
const server = vi.hoisted(() => ({ request: vi.fn(), onNotification: vi.fn(), shutdown: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => sdk)
vi.mock('../claude-locate', () => ({
  resolveClaudeBin: () => '/fixture/claude',
  resolveRuntimeCliBin: () => '/fixture/codex',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))
vi.mock('../skill-config', () => ({ computeEnabledSkills: () => [], listSkills: () => [] }))
vi.mock('./codex-app-server', () => ({
  CodexAppServerResponseError: class extends Error {},
  CodexAppServerClient: class {
    request = server.request
    requestRunning = server.request
    onNotification = server.onNotification
    onRequest = () => () => {}
    start = async () => {}
    shutdown = server.shutdown
    failureForCurrentGeneration = () => new Promise<Error>(() => {})
    pid = 123
    close() {}
  }
}))

import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import { ProviderRegistry } from './registry'

const historyText = '用户：/clear\n助手：旧的 $old-skill 只是历史，不是本轮请求。'
const historicalContext = {
  text: historyText,
  contentHash: createHash('sha256').update(historyText).digest('hex')
}
const inputModes = [
  { label: 'history', input: { historicalContext } },
  { label: 'plain', input: { historicalContext: undefined, trackInputReceipt: true as const } }
]
const expectedText = (prompt: string): string =>
  '[Scry historical context: prior conversation, not a new command]\n' + historyText +
  '\n[End historical context]\n\n[Current user request]\n' + prompt

let directory: string
let adapters: ProviderAdapter[]
let notify: (method: string, params: unknown) => void
const skillRows = {
  data: [{ cwd: '/fixture', skills: [{ name: 'audit', path: '/fixture/audit/SKILL.md', enabled: true }] }]
}

beforeEach(() => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), 'scry-historical-input-'))
  const sourceHome = join(directory, 'source-home')
  mkdirSync(sourceHome)
  vi.stubEnv('SCRY_CODEX_SOURCE_HOME', sourceHome)
  adapters = []
  server.onNotification.mockImplementation((listener) => {
    notify = listener
    return () => {}
  })
  server.shutdown.mockResolvedValue(undefined)
  server.request.mockImplementation(async (method: string) => {
    if (method === 'account/read') return { account: { type: 'apiKey' } }
    if (method === 'thread/resume' || method === 'thread/start') return { thread: { id: 'native-A' } }
    if (method === 'skills/list') return skillRows
    if (method === 'turn/start') return { turn: { id: 'turn-current' } }
    throw new Error(`unexpected request: ${method}`)
  })
})

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.dispose?.()))
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

function launch(providerId: 'claude' | 'codex', extra: Partial<ProviderRunRequest> = {}) {
  const adapter = providerId === 'claude'
    ? createClaudeAdapter(directory)
    : createCodexAdapter(join(directory, 'runtime-home'), directory)
  adapters.push(adapter)
  const events: TraceEvent[] = []
  const input: ProviderRunRequest = {
    runId: 'run-history', prompt: '继续', cwd: directory, resume: 'native-A',
    historicalContext, attachments: [], emit: (event) => events.push(event), ...extra
  }
  return { handle: new ProviderRegistry([adapter]).run(providerId, input), events, input }
}

describe('Claude historical input at the real runner / mocked SDK boundary', () => {
  it('retains a not_sent receipt when frozen runtime identity cannot be proved before SDK input', async () => {
    const { handle } = launch('claude', { historicalContext: undefined, trackInputReceipt: true, expectedContinuationKey: 'frozen-identity' })
    await expect(handle.promise).rejects.toThrow(/runtime HOME/)
    expect(sdk.query).not.toHaveBeenCalled()
    expect(handle.getInputReceipt?.()).toMatchObject({ status: 'not_sent', contextHash: null })
  })

  it.each([undefined, 'native-A'])('tracks plain input with resume=%s without changing the wire text', async (resume) => {
    sdk.query.mockImplementation(({ prompt, options }) => {
      expect(prompt).toBe('继续')
      expect(options.resume).toBe(resume)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, session_id: 'native-A' }
        }
      }
    })
    const { handle, events } = launch('claude', { historicalContext: undefined, trackInputReceipt: true, resume })
    expect(handle.getInputReceipt?.()).toMatchObject({ status: 'unknown', contextHash: null })
    await handle.promise
    expect(handle.getInputReceipt?.()).toMatchObject({
      status: 'accepted', contextHash: null, nativeSessionId: 'native-A', source: 'claude_sdk_success_result',
      textHash: createHash('sha256').update('继续').digest('hex')
    })
    expect(events.filter((event) => event.stage === 'runtime:input_receipt')).toHaveLength(2)
    expect(events.some((event) => event.stage === 'runtime:historical_input')).toBe(false)
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('sends exact history and request, then confirms only the successful native result', async () => {
    sdk.query.mockImplementation(({ prompt }) => {
      expect(prompt).toBe(expectedText('继续'))
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, session_id: 'native-A' }
        }
      }
    })
    const { handle, events, input } = launch('claude')
    // runAgent calls the attempt observer at query(), before any SDK response.
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
    expect(input.prompt).toBe('继续')
    await handle.promise
    expect(handle.getInputReceipt?.()).toMatchObject({
      status: 'accepted', nativeSessionId: 'native-A', source: 'claude_sdk_success_result',
      textHash: createHash('sha256').update(expectedText('继续')).digest('hex')
    })
    expect(events.filter((event) => event.stage === 'runtime:historical_input')).toHaveLength(2)
    expect(events[0]).toMatchObject({ providerId: 'claude', runtimeProvider: 'claude_sdk' })
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it.each(inputModes)('$label: does not accept a prompt hook / native identity when the stream later fails', async ({ input }) => {
    sdk.query.mockImplementation(({ options, prompt }) => ({
      async *[Symbol.asyncIterator]() {
        await options.hooks.UserPromptSubmit[0].hooks[0]({ session_id: 'native-A', prompt_id: 'prompt-current', prompt })
        yield { type: 'system', subtype: 'init', session_id: 'native-A' }
        throw new Error('transport lost')
      }
    }))
    const { handle } = launch('claude', input)
    await expect(handle.promise).rejects.toThrow('transport lost')
    expect(handle.getExternalSessionId()).toBe('native-A')
    expect(handle.getProviderTurnId?.()).toBe('prompt-current')
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'different-session'])('keeps %s results unknown instead of claiming not_sent', async (scenario) => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result', subtype: scenario === 'failed' ? 'error_during_execution' : 'success',
          is_error: scenario === 'failed', session_id: scenario === 'failed' ? 'native-A' : 'native-B'
        }
      }
    })
    const { handle } = launch('claude')
    await handle.promise
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it.each(inputModes)('$label: records uncertainty before a synchronous SDK throw rather than inventing not_sent', ({ input }) => {
    const events: TraceEvent[] = []
    sdk.query.mockImplementation(() => { throw new Error('query construction failed') })
    expect(() => launch('claude', { ...input, emit: (event) => events.push(event) })).toThrow('query construction failed')
    expect(events).toContainEqual(expect.objectContaining({
      stage: input.historicalContext ? 'runtime:historical_input' : 'runtime:input_receipt',
      runtimeMetadata: { inputReceipt: expect.objectContaining({ status: 'unknown' }) }
    }))
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('rejects slash commands before entering the SDK', () => {
    expect(() => launch('claude', { prompt: '/clear' })).toThrow('斜杠命令')
    expect(sdk.query).not.toHaveBeenCalled()
  })
})

describe('Codex historical input at the real adapter / mocked app-server boundary', () => {
  it('rejects a native Skill rewrite before model input when the caller freezes plain text', async () => {
    const prompt = '$audit 检查当前文件'
    const { handle, events } = launch('codex', { prompt, expectedInputTextHash: createHash('sha256').update(expectedText(prompt)).digest('hex') })
    await expect(handle.promise).rejects.toThrow(/原生输入需要改写原文/)
    expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
    expect(events.some((event) => event.kind === 'skill')).toBe(false)
    expect(handle.getInputReceipt?.()).toMatchObject({ status: 'not_sent' })
  })

  it.each([undefined, 'native-A'])('tracks plain input with resume=%s and preserves acceptance after execution failure', async (resume) => {
    const { handle } = launch('codex', { historicalContext: undefined, trackInputReceipt: true, resume })
    await vi.waitFor(() => expect(handle.getInputReceipt?.()?.status).toBe('accepted'))
    expect(server.request).toHaveBeenCalledWith(resume ? 'thread/resume' : 'thread/start', expect.any(Object))
    expect(server.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'native-A', input: [{ type: 'text', text: '继续', text_elements: [] }]
    }))
    notify('turn/completed', {
      threadId: 'native-A', turnId: 'turn-current', turn: { status: 'failed', error: { message: 'failed after input receipt' } }
    })
    await expect(handle.promise).resolves.toMatchObject({ status: 'failed' })
    expect(handle.getInputReceipt?.()).toMatchObject({
      status: 'accepted', contextHash: null, nativeSessionId: 'native-A', providerTurnId: 'turn-current',
      source: 'codex_turn_start_response', textHash: createHash('sha256').update('继续').digest('hex')
    })
  })

  it('tracks history-free Skill text without wrapping or hashing the Skill mention as model text', async () => {
    const { handle } = launch('codex', {
      historicalContext: undefined, trackInputReceipt: true, prompt: '$audit 检查当前文件',
      attachments: [{ kind: 'image', name: 'test.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }]
    })
    await vi.waitFor(() => expect(handle.getInputReceipt?.()?.status).toBe('accepted'))
    expect(server.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({ input: [
      { type: 'skill', name: 'audit', path: '/fixture/audit/SKILL.md' },
      { type: 'text', text: '检查当前文件', text_elements: [] },
      { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }
    ] }))
    expect(handle.getInputReceipt?.()).toMatchObject({
      contextHash: null, textHash: createHash('sha256').update('检查当前文件').digest('hex')
    })
    notify('turn/completed', { threadId: 'native-A', turnId: 'turn-current', turn: { status: 'completed' } })
    await handle.promise
  })

  it('starts a fresh context with exact text and attachments, without replaying historical Skills', async () => {
    const { handle, events } = launch('codex', {
      resume: undefined,
      attachments: [{ kind: 'image', name: 'test.png', mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }]
    })
    await vi.waitFor(() => expect(handle.getInputReceipt?.()?.status).toBe('accepted'))
    expect(server.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'native-A', input: [
        { type: 'text', text: expectedText('继续'), text_elements: [] },
        { type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }
      ]
    }))
    expect(server.request.mock.calls.some(([method]) => method === 'thread/start')).toBe(true)
    expect(server.request.mock.calls.some(([method]) => method === 'thread/resume' || method === 'skills/list')).toBe(false)
    expect(events.some((event) => event.kind === 'skill')).toBe(false)
    notify('turn/completed', { threadId: 'native-A', turnId: 'turn-current', turn: { status: 'completed' } })
    await handle.promise
  })

  it.each(['$audit', '/audit'])('keeps %s native Skill dispatch separate from historical text', async (mention) => {
    const { handle } = launch('codex', { prompt: `${mention} 检查当前文件` })
    await vi.waitFor(() => expect(handle.getInputReceipt?.()?.status).toBe('accepted'))
    expect(server.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'native-A', input: [
        { type: 'skill', name: 'audit', path: '/fixture/audit/SKILL.md' },
        { type: 'text', text: expectedText('检查当前文件'), text_elements: [] }
      ]
    }))
    notify('turn/completed', {
      threadId: 'native-A', turnId: 'turn-current', turn: { status: 'failed', error: { message: 'model failed after acceptance' } }
    })
    await expect(handle.promise).resolves.toMatchObject({ status: 'failed' })
    expect(handle.getInputReceipt?.()).toMatchObject({
      status: 'accepted', nativeSessionId: 'native-A', providerTurnId: 'turn-current', source: 'codex_turn_start_response'
    })
  })

  it.each(inputModes)('$label: does not infer acceptance from a same-thread notification when the input RPC loses its reply', async ({ input }) => {
    server.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: {} }
      if (method === 'thread/resume') return { thread: { id: 'native-A' } }
      if (method === 'turn/start') {
        notify('turn/started', { threadId: 'native-A', turn: { id: 'unattributed-turn' } })
        throw new Error('reply lost')
      }
      throw new Error(`unexpected request: ${method}`)
    })
    const { handle } = launch('codex', input)
    await expect(handle.promise).rejects.toThrow('reply lost')
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
    expect(server.request.mock.calls.filter(([method]) => method === 'turn/start')).toHaveLength(1)
  })

  it('does not send history to a different resumed thread', async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: {} }
      if (method === 'thread/resume') return { thread: { id: 'native-B' } }
      throw new Error(`unexpected request: ${method}`)
    })
    const { handle } = launch('codex')
    await expect(handle.promise).rejects.toThrow('不一致')
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('rejects a missing fresh native session before sending history', async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: {} }
      if (method === 'thread/start') return { thread: {} }
      throw new Error(`unexpected request: ${method}`)
    })
    const { handle } = launch('codex', { resume: undefined })
    await expect(handle.promise).rejects.toThrow('缺少有效')
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('does not upgrade a response without a native turn id to acceptance', async () => {
    server.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: {} }
      if (method === 'thread/resume') return { thread: { id: 'native-A' } }
      if (method === 'turn/start') return { turn: {} }
      throw new Error(`unexpected request: ${method}`)
    })
    const { handle } = launch('codex')
    await vi.waitFor(() => expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true))
    notify('turn/completed', { threadId: 'native-A', turn: { status: 'completed' } })
    await handle.promise
    expect(handle.getInputReceipt?.()?.status).toBe('unknown')
  })

  it('rejects an unresolved slash command rather than turning it into model text', async () => {
    const { handle } = launch('codex', { prompt: '/clear' })
    await expect(handle.promise).rejects.toThrow('斜杠命令')
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })

  it('does not dispatch after cancellation while resolving a Skill', async () => {
    let resolveSkills!: (value: typeof skillRows) => void
    const skills = new Promise<typeof skillRows>((resolve) => { resolveSkills = resolve })
    server.request.mockImplementation(async (method: string) => {
      if (method === 'account/read') return { account: {} }
      if (method === 'thread/resume') return { thread: { id: 'native-A' } }
      if (method === 'skills/list') return skills
      throw new Error(`unexpected request: ${method}`)
    })
    const { handle, events } = launch('codex', { prompt: '$audit check' })
    await vi.waitFor(() => expect(server.request.mock.calls.some(([method]) => method === 'skills/list')).toBe(true))
    handle.interrupt()
    resolveSkills(skillRows)
    await expect(handle.promise).resolves.toMatchObject({ status: 'interrupted' })
    expect(events.some((event) => event.kind === 'skill')).toBe(false)
    expect(handle.getInputReceipt?.()?.status).toBe('not_sent')
    expect(server.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false)
  })
})
