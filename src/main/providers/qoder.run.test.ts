import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { bindQoderTestHelpers, resetQoderTestState } from './qoder.test-support'

const t = await vi.hoisted(async () => (await import('./qoder.test-support')).createQoderTestState())
vi.mock('node:child_process', () => ({ spawn: t.sdk.spawn }))
vi.mock('../process-diagnostics', async () => (await import('./qoder.test-support')).qoderDiagnosticsModule(t))
vi.mock('@qoder-ai/qoder-agent-sdk', async () => (await import('./qoder.test-support')).qoderSdkModule(t))
vi.mock('./qoder-daemon', async () => (await import('./qoder.test-support')).qoderDaemonModule(t))
vi.mock('../claude-locate', async () => (await import('./qoder.test-support')).qoderLocateModule(t))

import {
  createQoderAdapter,
  expandQoderProjectCommand
} from './qoder'

const { sdk } = t
const { useLease } = bindQoderTestHelpers(t)

describe('Qoder provider adapter · managed runs, plugins and commands', () => {
  beforeEach(() => resetQoderTestState(t))

  it('managed Qoder 返回 native promptId、fork message id 与失败状态，并只在显式启用时注入 managed 环境', async () => {
    sdk.runtimeCliEnv.mockImplementation((_base?: Record<string, string>, options: { managedRecorder?: boolean } = {}) =>
      options?.managedRecorder ? {
        SCRY_RECORDER_MANAGED: '1',
        SCRY_MANAGED_RUN_ID: 'stale-run',
        SCRY_MANAGED_PROMPT_HASH: 'b'.repeat(64)
      } : {}
    )
    sdk.getSessionMessages.mockResolvedValue([{
      type: 'user',
      uuid: 'qoder-user-message',
      session_id: 'qoder-session',
      message: { role: 'user', content: 'work' },
      parent_tool_use_id: null,
      parent_agent_id: null
    }])
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'assistant',
          session_id: 'qoder-session',
          promptId: 'qoder-turn',
          message: { content: [{ type: 'text', text: 'failed' }] }
        }
        yield {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'qoder-session',
          promptId: 'qoder-turn',
          duration_ms: 10,
          duration_api_ms: 8,
          errors: ['failed']
        }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })

    const handle = createQoderAdapter().run({
      runId: 'run-managed',
      prompt: 'work',
      cwd: '/repo',
      attachments: [],
      managedRecorder: true,
      managedRecorderIdentity: {
        runId: 'run-managed',
        promptHash: 'a'.repeat(64)
      },
      emit: vi.fn()
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'qoder-session',
      providerTurnId: 'qoder-turn',
      forkTurnId: 'qoder-user-message',
      status: 'failed'
    })
    expect(handle.getProviderTurnId?.()).toBe('qoder-turn')
    expect(handle.getForkTurnId?.()).toBe('qoder-user-message')
    expect(sdk.startDaemon.mock.calls[0][0].env).toMatchObject({
      SCRY_RECORDER_MANAGED: '1',
      SCRY_MANAGED_RUN_ID: 'run-managed',
      SCRY_MANAGED_PROMPT_HASH: 'a'.repeat(64)
    })
  })

  it('通过 Qoder control API 执行 /plugins reload，不把它发送给模型', async () => {
    const reloadPlugins = vi.fn().mockResolvedValue({
      commands: Array.from({ length: 11 }, (_, index) => ({ name: `command-${index}` })),
      agents: [],
      plugins: [{ name: 'test-plugin', path: '/plugin' }],
      mcpServers: [],
      error_count: 0
    })
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
      },
      reloadPlugins,
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    const result = await createQoderAdapter().run({
      runId: 'run-plugin-reload',
      prompt: '/plugins reload',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(reloadPlugins).toHaveBeenCalledOnce()
    expect(sdk.query.mock.calls[0][0].prompt).not.toBe('/plugins reload')
    expect(result).toMatchObject({ externalSessionId: 'qoder-session', status: 'completed' })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'model',
      stage: 'text',
      text: '插件已重载：1 个插件，11 条命令',
      runtimeMetadata: expect.objectContaining({ source: 'qoder_sdk_control' })
    }))
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'result',
      isError: false
    }))
  })

  it('names the session of a /plugins reload that never receives a message', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      reloadPlugins: vi.fn().mockResolvedValue({ commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 }),
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const seen: string[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-plugin-reload-silent', prompt: '/plugins reload', cwd: '/repo', attachments: [], emit: () => {},
      onExternalSessionId: (id) => seen.push(id)
    }).promise
    const requested = sdk.query.mock.calls[0][0].options.sessionId
    expect(requested).toMatch(/^[0-9a-f-]{36}$/)
    expect(result).toMatchObject({ externalSessionId: requested, status: 'completed' })
    expect(seen).toEqual([requested])
  })

  it('把 Qoder 日志中的后台 shell 失败回写为本轮失败', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-background-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p126')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      '2026-08-05T18:31:57.544+08:00 INFO  [session=qoder-session] tool.shell.backgrounded pid=35509 command="make build-local"',
      '2026-08-05T18:42:08.004+08:00 WARN  [session=qoder-session turn=qoder-turn tool=tool-1] tool.shell.finished pid=35509 exit_code=143 signal=15 aborted=true output_length=0'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    process.env.QODER_CONFIG_DIR = configDir
    try {
      useLease({ pid: 126 })
      sdk.query.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
            yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1', input: {} }] } }
            yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] }, tool_use_result: { kind: 'backgrounded', taskId: 'shell-task' } }
            yield { type: 'result', subtype: 'success', session_id: 'qoder-session', result: 'backgrounded' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })
      const events: TraceEvent[] = []

      const result = await createQoderAdapter().run({
        runId: 'run-background-failure',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        emit: (event) => events.push(event)
      }).promise

      expect(result.status).toBe('failed')
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'tool',
        stage: 'tool_result',
        toolUseId: 'tool-1',
        isError: true,
        runtimeMetadata: expect.objectContaining({ backgroundTask: true, exitCode: 143 })
      }))
      expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({ phase: 'inactive', tasks: [] })
      expect(events.some((event) => event.stage === 'runtime:background_unresolved')).toBe(false)
    } finally {
      if (previousConfigDir == null) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('把真实 Qoder 批量取消日志回写为四个 Agent stopped 终态', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-agent-cancel-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p127')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      ...['a', 'b', 'c', 'd'].map((id, index) =>
        `2026-09-01T18:21:08.0${44 + index}+08:00 ERROR debug.message [SubagentRun] error agentId=agent-${id} taskId=task-${id} sessionId=qoder-session parentToolUseId=agent-${id} Error [AbortError]: Operation cancelled by user`
      ),
      '2026-09-01T18:21:08.360+08:00 WARN  process.exiting exit_code=143 reason="signal_term" message="SIGTERM received"'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    process.env.QODER_CONFIG_DIR = configDir
    try {
      useLease({ pid: 127 })
      sdk.query.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'assistant', session_id: 'qoder-session',
              message: {
                content: ['a', 'b', 'c', 'd'].map((id) => ({
                  type: 'tool_use', id: `agent-${id}`, name: 'Agent', input: { run_in_background: true }
                }))
              }
            }
            for (const id of ['a', 'b', 'c', 'd']) {
              yield { type: 'system', subtype: 'task_started', task_id: `task-${id}`, tool_use_id: `agent-${id}` }
            }
            // A real SDK terminal for one child must win over the duplicate log line.
            yield { type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'stopped', summary: 'stopped' }
            yield { type: 'result', subtype: 'success', session_id: 'qoder-session', result: 'waiting' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })
      const events: TraceEvent[] = []

      const result = await createQoderAdapter().run({
        runId: 'run-four-cancelled-agents', prompt: 'delegate four', cwd: '/repo', attachments: [],
        emit: (event) => events.push(event)
      }).promise

      expect(result.status).toBe('failed')
      const terminals = events.filter((event) => event.tool === 'Agent' && event.stage === 'tool_result')
      expect(terminals).toHaveLength(4)
      expect(terminals.map((event) => [event.toolUseId, event.runtimeMetadata?.agentStatus])).toEqual([
        ['agent-a', 'stopped'], ['agent-b', 'stopped'], ['agent-c', 'stopped'], ['agent-d', 'stopped']
      ])
      expect(terminals.map((event) => event.runtimeMetadata?.source)).toEqual([
        'provider_task_notification', 'qoder_cli_log', 'qoder_cli_log', 'qoder_cli_log'
      ])
      expect(terminals.every((event) => event.isError === false)).toBe(true)
      expect(events.filter((event) => event.backgroundWork).at(-1)?.backgroundWork).toMatchObject({ phase: 'inactive', tasks: [] })
      expect(events.some((event) => event.stage === 'runtime:background_unresolved')).toBe(false)
    } finally {
      if (previousConfigDir == null) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('在送入 SDK 前展开项目 Qoder command，避免 slash command 零 turn 退出', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'scry-qoder-command-test-'))
    const commandsDir = join(cwd, '.qoder', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'rate-native-rate-workflow.md'), [
      '---',
      'description: validate rate workflow',
      '---',
      '# rate-workflow',
      '',
      'Read the canonical skill before acting.'
    ].join('\n'))
    try {
      const expanded = [
        '# rate-workflow',
        '',
        'Read the canonical skill before acting.',
        '',
        'ARGUMENTS: 85008418'
      ].join('\n')
      await expect(
        expandQoderProjectCommand('/rate-native-rate-workflow 85008418', cwd)
      ).resolves.toBe(expanded)
      let capturedPrompt: AsyncIterable<Record<string, unknown>> | undefined
      sdk.query.mockImplementation(({ prompt }) => {
        capturedPrompt = prompt
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'result', subtype: 'success', result: 'done' }
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      await createQoderAdapter().run({
        runId: 'run-project-command',
        prompt: '/rate-native-rate-workflow 85008418',
        cwd,
        attachments: [],
        emit: vi.fn()
      }).promise
      const promptIterator = capturedPrompt![Symbol.asyncIterator]()
      await expect(promptIterator.next()).resolves.toMatchObject({
        done: false,
        value: { type: 'user', message: { content: [{ type: 'text', text: expanded }] } }
      })
      await expect(promptIterator.next()).resolves.toMatchObject({ done: true })
      expect(sdk.query).toHaveBeenCalledOnce()
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('展开 Qoder command 的位置参数，未命中项目 command 时保持原 prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'scry-qoder-command-args-test-'))
    const commandsDir = join(cwd, '.qoder', 'commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'inspect.md'), 'Inspect $0 then $ARGUMENTS[1]. All: $ARGUMENTS')
    try {
      await expect(expandQoderProjectCommand('/inspect "hello world" tail', cwd))
        .resolves.toBe('Inspect hello world then tail. All: "hello world" tail')
      await expect(expandQoderProjectCommand('/missing value', cwd))
        .resolves.toBe('/missing value')
      await expect(expandQoderProjectCommand('/../inspect secret', cwd))
        .resolves.toBe('/../inspect secret')
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
