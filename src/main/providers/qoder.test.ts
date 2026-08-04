import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
  close: vi.fn(),
  spawn: vi.fn(),
  runtimeCliEnv: vi.fn((_base?: Record<string, string>, _options: { managedRecorder?: boolean } = {}) => ({}))
}))

vi.mock('node:child_process', () => ({ spawn: sdk.spawn }))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/qodercli',
  runtimeCliEnv: sdk.runtimeCliEnv,
  shellEnv: () => ({})
}))

import {
  createQoderAdapter,
  expandQoderProjectCommand,
  parseQoderHookLog,
  qoderHookFallbackOnly,
  qoderProviderTurnIdFromLog
} from './qoder'

describe('Qoder provider adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the SDK Skill catalog as read-only rather than unsupported', async () => {
    await expect(createQoderAdapter().describe()).resolves.toMatchObject({
      id: 'qoder',
      label: 'Qoder',
      transport: 'Qoder Agent SDK',
      capabilities: { skills: 'read', mcp: 'none', commands: 'read', account: 'read' }
    })
  })

  it('reads discovered Skill metadata from the native context usage catalog', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getContextUsage: vi.fn().mockResolvedValue({
        skills: {
          totalSkills: 2,
          includedSkills: 2,
          skillFrontmatter: [
            { name: 'scry-e2e-audit', source: 'project', tokens: 0 },
            { name: 'browser-use', source: 'user', tokens: 0 }
          ]
        }
      }),
      supportedCommands: vi.fn().mockResolvedValue([
        { name: 'scry-e2e-audit', description: 'Repository audit', argumentHint: '' },
        { name: 'browser-use', description: 'Browser control', argumentHint: '' }
      ]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.skills!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({
      mode: 'read',
      state: 'ready',
      data: [
        { name: 'scry-e2e-audit', scope: 'project', description: 'Repository audit', enabled: true },
        { name: 'browser-use', scope: 'user', description: 'Browser control', enabled: true }
      ]
    })
    await adapter.dispose?.()
  })

  it('keeps the control transport alive while reading commands without sending a model prompt', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      supportedCommands: vi.fn().mockResolvedValue([{ name: 'help', description: 'Help', argumentHint: '' }]),
      mcpServerStatus: vi.fn().mockResolvedValue([]),
      getUsageInfo: vi.fn().mockResolvedValue(null),
      accountInfo: vi.fn().mockResolvedValue({ userId: 'user-1' }),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    const result = await adapter.commands!.list({ providerId: 'qoder', cwd: '/repo' })
    expect(result).toMatchObject({ state: 'ready', data: [{ name: 'help' }] })
    expect(sdk.query).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.objectContaining({ [Symbol.asyncIterator]: expect.any(Function) }) }))
    expect(sdk.close).not.toHaveBeenCalled()
    await adapter.dispose?.()
    expect(sdk.close).toHaveBeenCalledOnce()
  })

  it('reads model efforts from the native Qoder catalog', async () => {
    sdk.query.mockReturnValue({
      initializationResult: vi.fn().mockResolvedValue({}),
      getAvailableModels: vi.fn().mockResolvedValue([{
        value: 'performance',
        displayName: 'Performance',
        description: 'fast',
        isDefault: true,
        isEnabled: true,
        efforts: ['low', 'high'],
        defaultEffort: 'high'
      }]),
      close: sdk.close
    })
    const adapter = createQoderAdapter()
    await expect(adapter.runControls!.read({ providerId: 'qoder', cwd: '/repo' })).resolves.toMatchObject({
      state: 'ready',
      data: {
        models: [{
          model: { id: 'performance' },
          efforts: [{ id: 'low' }, { id: 'high', isDefault: true }]
        }]
      }
    })
    await adapter.dispose?.()
  })

  it('deduplicates streamed text and treats impossible all-zero usage as unknown', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'O' } } }
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'K' } } }
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }
        yield { type: 'result', subtype: 'success', result: 'OK', usage: { input_tokens: 0, output_tokens: 0 } }
      },
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-1',
      prompt: 'only OK',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise
    expect(result.stopped).toBe(false)
    expect(events.filter((event) => event.kind === 'model').map((event) => event.text)).toEqual(['O', 'K'])
    expect(events.find((event) => event.kind === 'harness')).toMatchObject({
      stage: 'result',
      tokensIn: undefined,
      tokensOut: undefined,
      costUsd: undefined,
      runtimeMetadata: expect.objectContaining({ reportedZeroUsage: true })
    })
    expect(sdk.runtimeCliEnv).toHaveBeenCalledWith(undefined, {})
  })

  it('managed Qoder 返回 native promptId 与失败状态，并只在显式启用时注入 managed 环境', async () => {
    sdk.runtimeCliEnv.mockImplementation((_base?: Record<string, string>, options: { managedRecorder?: boolean } = {}) =>
      options?.managedRecorder ? { SCRY_RECORDER_MANAGED: '1' } : {}
    )
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
      emit: vi.fn()
    })

    await expect(handle.promise).resolves.toMatchObject({
      externalSessionId: 'qoder-session',
      providerTurnId: 'qoder-turn',
      status: 'failed'
    })
    expect(handle.getProviderTurnId?.()).toBe('qoder-turn')
    expect(sdk.query.mock.calls[0][0].options.env).toMatchObject({ SCRY_RECORDER_MANAGED: '1' })
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
      sdk.query.mockImplementation(({ prompt }) => {
        expect(prompt).toBe(expanded)
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

  it('bridges AskUserQuestion answers through the Qoder SDK permission callback', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close,
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const requestUserInput = vi.fn(async (request) => ({
      runId: request.runId,
      questionId: request.questionId,
      behavior: 'answered' as const,
      answers: { '选择流程？': '全量' }
    }))

    const run = createQoderAdapter().run({
      runId: 'run-question',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      permissionMode: 'full_access',
      requestUserInput
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool as (
      tool: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string }
    ) => Promise<Record<string, unknown>>
    const input = {
      questions: [
        {
          question: '选择流程？',
          header: '流程',
          multiSelect: false,
          options: [
            { label: '全量', description: '完整执行' },
            { label: '快速', description: '缩短流程' }
          ]
        }
      ]
    }

    await expect(
      canUseTool('AskUserQuestion', input, { signal: new AbortController().signal, toolUseID: 'tool-1' })
    ).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { '选择流程？': '全量' } },
      decisionClassification: 'user_temporary'
    })
    await expect(
      canUseTool('Bash', { command: 'pwd' }, { signal: new AbortController().signal, toolUseID: 'tool-2' })
    ).resolves.toEqual({ behavior: 'allow' })
    expect(requestUserInput).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-question', questionId: 'tool-1' }),
      expect.any(AbortSignal)
    )
    await run.promise
  })

  it('passes Qoder model effort through model policy and uses auto review', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    await createQoderAdapter().run({
      runId: 'run-controls',
      prompt: 'work',
      attachments: [],
      model: { id: 'performance' },
      effort: 'high',
      permissionMode: 'auto_review',
      emit: vi.fn()
    }).promise
    const options = sdk.query.mock.calls[0][0].options
    expect(options.permissionMode).toBe('auto')
    expect(options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(options.resolveModel()).toEqual({
      model: 'performance',
      parameters: { reasoningEffort: 'high' }
    })
  })

  it('returns a non-interrupting Qoder denial when the user cancels a question', async () => {
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const run = createQoderAdapter().run({
      runId: 'run-question-cancel',
      prompt: 'ask',
      attachments: [],
      emit: vi.fn(),
      requestUserInput: async (request) => ({
        runId: request.runId,
        questionId: request.questionId,
        behavior: 'cancelled'
      })
    })
    const canUseTool = sdk.query.mock.calls[0][0].options.canUseTool

    await expect(
      canUseTool(
        'AskUserQuestion',
        {
          questions: [
            {
              question: '继续？',
              header: '确认',
              multiSelect: false,
              options: [
                { label: '继续', description: '继续执行' },
                { label: '停止', description: '不再执行' }
              ]
            }
          ]
        },
        { signal: new AbortController().signal, toolUseID: 'tool-1' }
      )
    ).resolves.toMatchObject({
      behavior: 'deny',
      interrupt: false,
      decisionClassification: 'user_reject'
    })
    await run.promise
  })

  it('rejects a run when the Qoder child exits but the SDK stream never settles', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      const close = vi.fn().mockResolvedValue(undefined)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli',
          args: [],
          cwd: '/repo',
          env: {},
          signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
          },
          close,
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      const run = createQoderAdapter().run({
        runId: 'run-exit',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        emit: vi.fn()
      })
      const rejected = expect(run.promise).rejects.toThrow('Qoder CLI 已退出，但 SDK 事件流未结束')
      child.emit('exit', 143, null)
      await vi.advanceTimersByTimeAsync(1000)

      await rejected
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a structured Qoder failure when the CLI exits with code 1 afterwards', async () => {
    const child = Object.assign(new EventEmitter(), { pid: 124, kill: vi.fn() })
    sdk.spawn.mockReturnValue(child)
    const close = vi.fn().mockRejectedValue(new Error('Qoder CLI process exited with code 1'))
    sdk.query.mockImplementation(({ options }) => {
      options.spawnQoderCLIProcess({
        command: '/bin/qodercli',
        args: [],
        cwd: '/repo',
        env: {},
        signal: new AbortController().signal
      })
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            errors: ['Unknown slash command: /rate-workflow']
          }
          child.emit('exit', 1, null)
          throw new Error('Qoder CLI process exited with code 1')
        },
        close,
        interrupt: vi.fn().mockResolvedValue(undefined)
      }
    })

    const events: TraceEvent[] = []
    const result = await createQoderAdapter().run({
      runId: 'run-provider-failure',
      prompt: '/rate-workflow',
      cwd: '/repo',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(result.stopped).toBe(false)
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'harness',
      stage: 'result',
      text: 'Unknown slash command: /rate-workflow',
      isError: true
    }))
  })

  it('SDK 流抛错时仍从 root log 绑定 managed native turn ID', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-log-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p125')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      '2026-07-31T16:28:19.807+08:00 INFO  [session=qoder-session turn=native-prompt] input.prompt.received text_preview="work" query_source="sdk"',
      '2026-07-31T16:28:38.706+08:00 INFO  [session=qoder-session turn=native-prompt] turn.started is_subagent=false'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    const previousLogHooks = process.env.SCRY_QODER_LOG_HOOKS
    process.env.QODER_CONFIG_DIR = configDir
    process.env.SCRY_QODER_LOG_HOOKS = '0'
    try {
      const child = Object.assign(new EventEmitter(), { pid: 125, kill: vi.fn() })
      sdk.spawn.mockReturnValue(child)
      sdk.query.mockImplementation(({ options }) => {
        options.spawnQoderCLIProcess({
          command: '/bin/qodercli',
          args: [],
          cwd: '/repo',
          env: {},
          signal: new AbortController().signal
        })
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
            throw new Error('stream aborted')
          },
          close: vi.fn().mockResolvedValue(undefined),
          interrupt: vi.fn().mockResolvedValue(undefined)
        }
      })

      const handle = createQoderAdapter().run({
        runId: 'run-interrupted',
        prompt: 'work',
        cwd: '/repo',
        attachments: [],
        managedRecorder: true,
        emit: vi.fn()
      })

      await expect(handle.promise).rejects.toThrow('stream aborted')
      expect(handle.getProviderTurnId?.()).toBe('native-prompt')
    } finally {
      if (previousConfigDir == null) delete process.env.QODER_CONFIG_DIR
      else process.env.QODER_CONFIG_DIR = previousConfigDir
      if (previousLogHooks == null) delete process.env.SCRY_QODER_LOG_HOOKS
      else process.env.SCRY_QODER_LOG_HOOKS = previousLogHooks
      await rm(configDir, { recursive: true, force: true })
    }
  })

  it('promotes the Qoder SDK hook name to its runtime command', async () => {
    const command = '"${QODER_PLUGIN_ROOT}/bin/qodersec-launch.cmd" ensure-deps --hook-event SessionStart'
    sdk.query.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'hook-1',
          hook_name: command,
          hook_event: 'SessionStart',
          outcome: 'error',
          exit_code: 1,
          stdout: '',
          stderr: 'dependency failed',
          output: 'dependency failed'
        }
      },
      close: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    })
    const events: TraceEvent[] = []

    await createQoderAdapter().run({
      runId: 'run-hook-command',
      prompt: 'work',
      attachments: [],
      emit: (event) => events.push(event)
    }).promise

    expect(events).toContainEqual(expect.objectContaining({
      kind: 'hook',
      stage: 'hook_response',
      hookName: command,
      hookCommand: command,
      hookOutcome: 'error',
      runtimeMetadata: expect.objectContaining({ source: 'qoder_sdk' })
    }))
  })

  it('parses every same-name Qoder hook script from the current process log', () => {
    const log = [
      '2026-07-11T11:24:25.363+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="project" hook_index=1 display_text="project-hook"',
      '2026-07-11T11:24:25.364+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="user" hook_index=2 display_text="user-hook"',
      '2026-07-11T11:24:26.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=true duration_ms=637 exit_code=0',
      '2026-07-11T11:24:27.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=false duration_ms=1636 exit_code=1'
    ].join('\n')

    const events = parseQoderHookLog('run-1', log, 's1')

    expect(events).toHaveLength(4)
    expect(events.filter((event) => event.stage === 'hook_response')).toEqual([
      expect.objectContaining({ hookCommand: 'project-hook', hookOutcome: 'success', hookExitCode: 0 }),
      expect.objectContaining({ hookCommand: 'user-hook', hookOutcome: 'error', hookExitCode: 1, isError: true })
    ])
  })

  it('从 Qoder root prompt 日志取 native turn identity，不把 hook 的 session turn 当成 promptId', () => {
    const log = [
      '2026-07-31T16:28:19.831+08:00 INFO  [session=s1 turn=s1] hook.started hook_name="UserPromptSubmit" hook_event_name="UserPromptSubmit" source="project"',
      '2026-07-31T16:28:19.807+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.received text_preview="work" query_source="sdk"',
      '2026-07-31T16:28:38.705+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.submitted is_subagent=false',
      '2026-07-31T16:28:38.706+08:00 INFO  [session=s1 turn=prompt-1] turn.started is_subagent=false',
      '2026-07-31T16:28:40.000+08:00 INFO  [session=s1 turn=child] turn.started is_subagent=true'
    ].join('\n')

    expect(qoderProviderTurnIdFromLog(log, 's1')).toBe('prompt-1')
  })

  it('Qoder 日志出现多个 SDK root prompt 时不猜 turn identity', () => {
    const log = [
      '2026-07-31T16:28:19.807+08:00 INFO  [session=s1 turn=prompt-1] input.prompt.received query_source="sdk"',
      '2026-07-31T16:29:19.807+08:00 INFO  [session=s1 turn=prompt-2] input.prompt.received query_source="sdk"'
    ].join('\n')

    expect(qoderProviderTurnIdFromLog(log, 's1')).toBeUndefined()
  })

  it('deduplicates SDK and log hooks by command while preserving repeated log-only hooks', () => {
    const sdk = (command: string): TraceEvent => ({
      id: command, runId: 'run-1', ts: '2026-07-11T00:00:00.000Z', kind: 'hook', stage: 'hook_started',
      hookName: command, hookEvent: 'SessionStart', hookOutcome: 'started', runtimeMetadata: { source: 'qoder_sdk' }
    })
    const fallback = (id: string, command: string): TraceEvent => ({
      id, runId: 'run-1', ts: '2026-07-11T00:00:00.000Z', kind: 'hook', stage: 'hook_started',
      hookName: 'SessionStart:startup', hookEvent: 'SessionStart', hookCommand: command, hookOutcome: 'started',
      runtimeMetadata: { source: 'qoder_cli_log' }
    })

    expect(qoderHookFallbackOnly([sdk('same-hook')], [fallback('a', 'same-hook'), fallback('b', 'same-hook')]))
      .toEqual([expect.objectContaining({ id: 'b' })])
  })
})
