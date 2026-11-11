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
  parseQoderBackgroundTaskFailures,
  parseQoderHookLog,
  parseQoderSubagentTerminals,
  qoderHookFallbackOnly,
  qoderProviderTurnIdFromLog
} from './qoder'

const { sdk } = t
const { useLease } = bindQoderTestHelpers(t)

describe('Qoder provider adapter · native log evidence', () => {
  beforeEach(() => resetQoderTestState(t))

  it.each([false, true])('后台通知不覆盖 managed native turn ID（stream aborted=%s）', async (aborted) => {
    const configDir = await mkdtemp(join(tmpdir(), 'scry-qoder-log-test-'))
    const runLogDir = join(configDir, 'logs', 'runs', 'run-p125')
    await mkdir(runLogDir, { recursive: true })
    await writeFile(join(runLogDir, 'qodercli.log'), [
      '2026-07-31T16:28:19.807+08:00 INFO  [session=qoder-session turn=native-prompt] input.prompt.received text_preview="work" query_source="sdk"',
      '2026-07-31T16:28:38.706+08:00 INFO  [session=qoder-session turn=native-prompt] turn.started is_subagent=false',
      '2026-07-31T16:29:00.000+08:00 INFO  [session=qoder-session turn=notification] input.prompt.received command_mode="task-notification" query_source="sdk"',
      '2026-07-31T16:29:00.001+08:00 INFO  [session=qoder-session turn=notification] input.prompt.submitted is_subagent=false',
      '2026-07-31T16:29:00.002+08:00 INFO  [session=qoder-session turn=notification] turn.started is_subagent=false'
    ].join('\n'))
    const previousConfigDir = process.env.QODER_CONFIG_DIR
    const previousLogHooks = process.env.SCRY_QODER_LOG_HOOKS
    process.env.QODER_CONFIG_DIR = configDir
    process.env.SCRY_QODER_LOG_HOOKS = '0'
    try {
      useLease({ pid: 125 })
      sdk.query.mockImplementation(() => {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system', subtype: 'init', session_id: 'qoder-session', mcp_servers: [] }
            if (aborted) throw new Error('stream aborted')
            yield { type: 'result', subtype: 'success', session_id: 'qoder-session', result: 'done' }
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

      if (aborted) await expect(handle.promise).rejects.toThrow('stream aborted')
      else await expect(handle.promise).resolves.toMatchObject({ providerTurnId: 'native-prompt', status: 'completed' })
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

  it('按 duration 对齐并发同名 Hook，不把乱序完成状态归给错误脚本', () => {
    const log = [
      '2026-07-11T11:24:25.363+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="project" hook_index=1 display_text="slow-project-hook"',
      '2026-07-11T11:24:25.500+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.started hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" source="user" hook_index=2 display_text="fast-user-hook"',
      '2026-07-11T11:24:26.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=true duration_ms=500 exit_code=0',
      '2026-07-11T11:24:27.000+08:00 INFO  [session=s1 turn=t1 tool=tool1] hook.finished hook_name="PreToolUse:Skill" hook_event_name="PreToolUse" success=false duration_ms=1637 exit_code=1'
    ].join('\n')

    const responses = parseQoderHookLog('run-1', log, 's1').filter((event) => event.stage === 'hook_response')

    expect(responses).toEqual([
      expect.objectContaining({ hookCommand: 'fast-user-hook', hookOutcome: 'success' }),
      expect.objectContaining({ hookCommand: 'slow-project-hook', hookOutcome: 'error', isError: true })
    ])
  })

  it('marks only failed background shell tasks from the Qoder process log', () => {
    const log = [
      '2026-08-05T18:31:57.544+08:00 INFO  [session=s1] tool.shell.backgrounded pid=35509 command="make build-local"',
      '2026-08-05T18:42:08.004+08:00 WARN  [session=s1 turn=t1 tool=tool-1] tool.shell.finished pid=35509 exit_code=143 signal=15 aborted=true output_length=0',
      '2026-08-05T18:42:09.000+08:00 INFO  [session=s1] tool.shell.backgrounded pid=35510 command="echo ok"',
      '2026-08-05T18:42:10.000+08:00 INFO  [session=s1 turn=t1 tool=tool-2] tool.shell.finished pid=35510 exit_code=0 aborted=false output_length=3'
    ].join('\n')

    expect(parseQoderBackgroundTaskFailures('run-1', log, 's1')).toEqual([
      expect.objectContaining({
        kind: 'tool',
        stage: 'tool_result',
        tool: 'Bash',
        toolUseId: 'tool-1',
        output: '后台 Bash 任务异常结束（exit 143 · signal 15）',
        isError: true,
        runtimeMetadata: expect.objectContaining({ backgroundTask: true, exitCode: 143, signal: '15' })
      })
    ])
  })

  it('recovers cancelled and failed Qoder subagent terminals from the process log', () => {
    const log = [
      '2026-09-01T18:21:08.044+08:00 ERROR debug.message [SubagentRun] error agentId=agent-a taskId=task-a sessionId=s1 parentToolUseId=agent-call-a Error [AbortError]: Operation cancelled by user',
      '2026-09-01T18:21:08.045+08:00 ERROR debug.message [SubagentRun] error agentId=agent-b taskId=task-b sessionId=s1 parentToolUseId=agent-call-b Error: writer failed',
      '2026-09-01T18:21:08.046+08:00 ERROR debug.message [SubagentRun] error agentId=agent-c taskId=task-c sessionId=other parentToolUseId=agent-call-c Error [AbortError]: Operation cancelled by user'
    ].join('\n')

    expect(parseQoderSubagentTerminals('run-1', log, 's1')).toEqual([
      expect.objectContaining({
        tool: 'Agent', toolUseId: 'agent-call-a', isError: false,
        runtimeMetadata: expect.objectContaining({ agentStatus: 'stopped', taskId: 'task-a', qoderAgentId: 'agent-a' })
      }),
      expect.objectContaining({
        tool: 'Agent', toolUseId: 'agent-call-b', isError: true,
        runtimeMetadata: expect.objectContaining({ agentStatus: 'failed', taskId: 'task-b', qoderAgentId: 'agent-b' })
      })
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

  it.each([false, true])('排除后台通知的全部 lifecycle ID（SDK root=%s）', (sdkRoot) => {
    const log = [
      '2026-09-09T19:06:42.073+08:00 INFO  [session=s1 turn=root] input.prompt.received command_mode="prompt"' + (sdkRoot ? ' query_source="sdk"' : ''),
      '2026-09-09T19:06:45.186+08:00 INFO  [session=s1 turn=root] turn.started is_subagent=false',
      // Lifecycle lines can be repeated or encountered before the received line.
      '2026-09-09T19:12:17.776+08:00 INFO  [session=s1 turn=notification] turn.started is_subagent=false',
      '2026-09-09T19:12:15.079+08:00 INFO  [session=s1 turn=notification] input.prompt.received command_mode="task-notification" query_source="sdk"',
      '2026-09-09T19:12:17.776+08:00 INFO  [session=s1 turn=notification] input.prompt.submitted is_subagent=false',
      '2026-09-09T19:12:17.777+08:00 INFO  [session=s1 turn=notification] turn.started is_subagent=false',
      '2026-09-09T19:12:18.000+08:00 INFO  [session=other turn=root] input.prompt.received command_mode="task-notification" query_source="sdk"'
    ].join('\n')
    expect(qoderProviderTurnIdFromLog(log, 's1')).toBe('root')
  })

  it('仅有后台通知不能充当用户请求的 turn identity', () => {
    const log = [
      '2026-09-09T19:12:15.079+08:00 INFO  [session=s1 turn=notification] input.prompt.received command_mode="task-notification" query_source="sdk"',
      '2026-09-09T19:12:17.776+08:00 INFO  [session=s1 turn=notification] turn.started is_subagent=false'
    ].join('\n')
    expect(qoderProviderTurnIdFromLog(log, 's1')).toBeUndefined()
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
