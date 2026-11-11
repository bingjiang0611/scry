import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter
} from './qoder'

const { sdk } = t

describe('Qoder provider adapter · background work', () => {
  beforeEach(() => resetQoderTestState(t))

  it.each(['completed', 'failed', 'stopped'])('keeps control stdin open across a background Bash %s notification turn', async (status) => {
    const getContextUsage = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockImplementation(({ prompt, options }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        let released = false
        const done = input.next().then(() => { released = true })
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash-1', input: { run_in_background: true } }] } }
        yield {
          type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'Command running in background' }] },
          tool_use_result: { kind: 'backgrounded', taskId: 'shell-1', backgroundReason: 'model' }
        }
        yield { type: 'result', subtype: 'success', result: 'started' }
        await Promise.resolve()
        expect(released).toBe(false)
        expect(getContextUsage).not.toHaveBeenCalled()
        yield {
          type: 'user', isSynthetic: true,
          message: { content: [{ type: 'text', text: `<task-notification>\n<task-id>shell-1</task-id>\n<tool-use-id>bash-1</tool-use-id>\n<status>${status}</status>\n<summary>Background command ended</summary>\n</task-notification>` }] }
        }
        await Promise.resolve()
        // Qoder requests model policy here before producing the follow-up result.
        expect(released).toBe(false)
        expect(options.resolveModel()).toMatchObject({ model: 'ultimate' })
        yield { type: 'result', subtype: 'success', result: 'notification handled' }
        await done
        expect(released).toBe(true)
      },
      getContextUsage,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    await expect(createQoderAdapter().run({
      runId: 'background-shell', prompt: 'run', attachments: [], emit: () => {},
      model: { id: 'ultimate' }, effort: 'high'
    }).promise).resolves.toMatchObject({ status: 'completed' })
  })

  it('reports a silent background wait without aborting, then honours explicit whole-run stop', async () => {
    vi.useFakeTimers()
    let controller: AbortController | undefined
    let released = false
    const events: TraceEvent[] = []
    sdk.query.mockImplementation(({ prompt, options }) => {
      controller = options.abortController
      return {
        async *[Symbol.asyncIterator]() {
          const input = prompt[Symbol.asyncIterator]()
          await input.next()
          void input.next().then(() => { released = true })
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash', input: { command: 'obsidian append' } }] } }
          yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'Appended to log.md' }] }, tool_use_result: { kind: 'backgrounded', taskId: 'task' } }
          yield { type: 'assistant', message: { stop_reason: 'end_turn', content: [] } }
          await new Promise<void>((resolve) => controller!.signal.addEventListener('abort', () => resolve(), { once: true }))
        },
        close: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })
    try {
      const handle = createQoderAdapter().run({ runId: 'silent-task', prompt: 'fixture', attachments: [], emit: (event) => events.push(event) })
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({ phase: 'waiting', quiet: true })
      expect(controller!.signal.aborted).toBe(false)
      expect(released).toBe(false)
      handle.interrupt()
      await expect(handle.promise).resolves.toMatchObject({ status: 'interrupted' })
      expect(released).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('keeps the Qoder input stream open until background Agents settle and the root responds again', async () => {
    let inputReleasedBeforeTerminal = false
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        yield {
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use', id: 'agent-1', name: 'local_agent',
              input: { description: 'inspect', run_in_background: true }
            }]
          }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', taskId: 'task-1' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
        const inputDone = input.next().then(() => { inputReleasedBeforeTerminal = true })
        await Promise.resolve()
        expect(inputReleasedBeforeTerminal).toBe(false)
        yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'done' }
        yield { type: 'result', subtype: 'success', result: 'all done' }
        await inputDone
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-background-agent',
      prompt: 'delegate',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('completed')
    expect(inputReleasedBeforeTerminal).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'agent', tool: 'Agent', toolUseId: 'agent-1'
    }))
    expect(events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result' && event.runtimeMetadata?.agentStatus === 'completed')).toHaveLength(1)
  })

  it.each(['text', 'task_updated'] as const)('releases Qoder stdin after a %s terminal and ignores late Agent progress', async (wire) => {
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', agentId: 'explore-1' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'agent-1' }
        // Qoder 1.1.41 sends completion as a synthetic user message, then flushes
        // queued progress/task_updated messages just before the root result.
        yield wire === 'text'
          ? {
              type: 'user', isSynthetic: true, parent_tool_use_id: null,
              message: { role: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>task-1</task-id>\n<tool-use-id>agent-1</tool-use-id>\n<output-file>/tmp/not-read.output</output-file>\n<status>completed</status>\n<summary>Agent "inspect" finished</summary>\n<result>Read-only findings</result>\n</task-notification>' }] }
            }
          : { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        yield { type: 'system', subtype: 'task_progress', task_id: 'task-1', tool_use_id: 'agent-1' }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-1', patch: { status: 'completed' } }
        yield { type: 'result', subtype: 'success', result: 'all done' }
        // Model a live CLI: receiving result is not enough to end the iterator.
        expect(await input.next()).toMatchObject({ done: true })
        yield { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-qoder-wire', prompt: 'delegate', attachments: [], emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('completed')
    const terminals = events.filter((event) => event.tool === 'Agent' && event.runtimeMetadata?.agentStatus === 'completed')
    expect(terminals).toHaveLength(1)
    expect(terminals[0].runtimeMetadata?.source).toBe(wire === 'text' ? 'qoder_task_notification_text' : 'qoder_task_updated')
    expect(events.slice(events.indexOf(terminals[0]) + 1).some((event) => event.stage === 'agent_activity')).toBe(false)
  })

  it.each(['error', 'cancelled', 'canceled', 'interrupted', 'killed', ' cancelled '].flatMap((status) =>
    ['task_updated', 'direct_notification'].map((wire) => [status, wire])
  ))('settles Agent terminal %s via %s and all task-ID aliases before closing stdin', async (status, wire) => {
    const events: TraceEvent[] = []
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        let released = false
        const closed = input.next().then(() => { released = true })
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'agent', input: {} }] } }
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agent' }] }, tool_use_result: { status: 'async_launched', taskId: 'task' } }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-alias', tool_use_id: 'agent' }
        yield wire === 'task_updated'
          ? { type: 'system', subtype: 'task_updated', task_id: 'task-alias', patch: { status } }
          : { type: 'system', subtype: 'task_notification', tool_use_id: 'agent', status }
        yield { type: 'result', subtype: 'success' }
        // Flush the async generator's EOF and its consumer's promise chain.
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(released).toBe(true)
        await closed
      },
      close: vi.fn().mockResolvedValue(undefined)
    }))
    await expect(createQoderAdapter().run({ runId: 'alias', prompt: 'fixture', attachments: [], emit: (event) => events.push(event) }).promise)
      .resolves.toMatchObject({ status: 'completed' })
    expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork?.tasks).toEqual([])
  })

  it('does not report success when transport ends with an unresolved Bash task', async () => {
    const events: TraceEvent[] = []
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'bash', input: {} }] } }
        yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'Appended' }] }, tool_use_result: { kind: 'backgrounded', taskId: 'shell' } }
        yield { type: 'result', subtype: 'success' }
      },
      close: vi.fn().mockResolvedValue(undefined)
    })
    const result = await createQoderAdapter().run({ runId: 'lost-shell', prompt: 'fixture', attachments: [], emit: (event) => events.push(event) }).promise
    expect(result.status).toBe('failed')
    expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
      phase: 'inactive', tasks: [{ taskId: 'shell', status: 'unconfirmed' }]
    })
  })

  it('does not release stdin while another Qoder Agent is unresolved or before the next root result', async () => {
    sdk.query.mockImplementation(({ prompt }) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]()
        await input.next()
        let released = false
        const done = input.next().then(() => { released = true })
        for (const id of ['one', 'two']) {
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id, input: { run_in_background: true } }] } }
          yield { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: id }
        }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-one', patch: { status: 'completed' } }
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-two', patch: { status: 'future_status' } }
        yield { type: 'system', subtype: 'task_updated', task_id: 'unrelated', patch: { status: 'completed' } }
        yield { type: 'result', subtype: 'success', result: 'waiting for two' }
        await Promise.resolve()
        expect(released).toBe(false)
        yield { type: 'system', subtype: 'task_updated', task_id: 'task-two', patch: { status: 'completed' } }
        await Promise.resolve()
        expect(released).toBe(false)
        yield { type: 'result', subtype: 'success', result: 'all done' }
        await done
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    await expect(createQoderAdapter().run({ runId: 'two-agents', prompt: 'delegate', attachments: [], emit: () => {} }).promise)
      .resolves.toMatchObject({ status: 'completed' })
  })

  it('closes every tracked background Agent as stopped when Scry interrupts before notifications arrive', async () => {
    let rootSeen!: () => void
    const root = new Promise<void>((resolve) => { rootSeen = resolve })
    sdk.query.mockImplementation(({ options }) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-stop', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'agent-stop', content: 'launched' }] },
          tool_use_result: { status: 'async_launched', taskId: 'task-stop' }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-stop', tool_use_id: 'agent-stop' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
        rootSeen()
        await new Promise<void>((resolve) => options.abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    }))
    const events: TraceEvent[] = []
    const handle = createQoderAdapter().run({
      runId: 'run-interrupted-agent',
      prompt: 'delegate',
      attachments: [],
      emit: (event) => events.push(event)
    })

    await root
    // qoderPid 是本轮 spawn 的 CLI 进程树：硬杀仅限本 run。
    expect(handle.forceKillScope).toBe('run_scoped')
    handle.interrupt()
    await expect(handle.promise).resolves.toMatchObject({ stopped: true, status: 'interrupted' })
    expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
      phase: 'inactive', taskStop: 'unavailable', tasks: [{ taskId: 'task-stop', status: 'unconfirmed' }]
    })
    expect(events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result')).toContainEqual(expect.objectContaining({
      toolUseId: 'agent-stop',
      isError: false,
      runtimeMetadata: expect.objectContaining({ source: 'qoder_host_interruption', agentStatus: 'stopped' })
    }))
  })

  it('fails the run instead of leaving unknown when Qoder transport ends with an active local Agent', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'agent-lost', name: 'Agent', input: { run_in_background: true } }] }
        }
        yield { type: 'system', subtype: 'task_started', task_id: 'task-lost', tool_use_id: 'agent-lost' }
        yield { type: 'result', subtype: 'success', result: 'waiting' }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-lost-agent', prompt: 'delegate', attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.status).toBe('failed')
    expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({
      phase: 'inactive', taskStop: 'unavailable', tasks: [{ taskId: 'task-lost', status: 'unconfirmed' }]
    })
    expect(events).toContainEqual(expect.objectContaining({
      tool: 'Agent', stage: 'tool_result', toolUseId: 'agent-lost', isError: true,
      runtimeMetadata: expect.objectContaining({ source: 'qoder_transport_ended', agentStatus: 'failed' })
    }))
  })
})
