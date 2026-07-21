import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceEvent } from '../../shared/trace'

const sdk = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }))

vi.mock('@qoder-ai/qoder-agent-sdk', () => ({
  qodercliAuth: () => ({ type: 'qodercli' }),
  query: sdk.query
}))

vi.mock('../claude-locate', () => ({
  resolveRuntimeCliBin: () => '/bin/qodercli',
  runtimeCliEnv: () => ({}),
  shellEnv: () => ({})
}))

import { createQoderAdapter, parseQoderHookLog, qoderHookFallbackOnly } from './qoder'

describe('Qoder provider adapter', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reports the SDK Skill catalog as read-only rather than unsupported', async () => {
    await expect(createQoderAdapter().describe()).resolves.toMatchObject({
      id: 'qoder',
      transport: 'Qoder Agent SDK',
      capabilities: { skills: 'read', mcp: 'read', commands: 'read', account: 'read' }
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
