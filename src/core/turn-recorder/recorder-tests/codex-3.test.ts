import { open as openFile, appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite11(): void {


  it('超过 2 GiB 的稀疏 rollout 只读取当前轮窗口，不整体载入文件', async () => {
    const root = await workspace()
    const rollout = join(root, 'large-rollout.jsonl')
    const sparseSize = 2 * 1024 * 1024 * 1024 + 1024
    const handle = await openFile(rollout, 'w')
    try {
      await handle.truncate(sparseSize)
      await handle.write('\n', sparseSize - 1)
    } finally {
      await handle.close()
    }
    const line = (timestamp: string, type: string, value: Record<string, unknown>): string =>
      JSON.stringify({ timestamp, type, payload: value })
    await appendFile(rollout, `${[
      line('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'large-turn' }),
      line('2026-07-19T12:00:00.010Z', 'event_msg', { type: 'user_message', message: 'large transcript' })
    ].join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('large-session', {
        prompt: 'large transcript',
        turn_id: 'large-turn',
        rollout_path: rollout
      })
    })
    await appendFile(rollout, `${[
      line('2026-07-19T12:00:00.100Z', 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'large-call',
        arguments: JSON.stringify({ cmd: 'printf ok' })
      }),
      line('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'large-call',
        output: 'ok'
      }),
      line('2026-07-19T12:00:01.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'large-turn',
        last_agent_message: 'done'
      })
    ].join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('large-session', {
        turn_id: 'large-turn',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record).toMatchObject({ sessionId: 'large-session', providerTurnId: 'large-turn', status: 'completed' })
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'large-call', name: 'Bash', status: 'success' })
    ])
  }, 15_000)

  it('保留单个 code-mode exec_command 调用及数组输出', async () => {
    const root = await workspace()
    const rollout = join(root, 'rollout-code-exec.jsonl')
    const row = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    await writeFile(rollout, `${[
      row('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'code-turn' }),
      row('2026-07-19T12:00:00.010Z', 'event_msg', { type: 'user_message', message: 'inspect' }),
      row('2026-07-19T12:00:00.100Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'code-exec-1',
        input: 'const r = await tools.exec_command({"cmd":"rg -n \\"UserPromptSubmit|prompt\\" recorder.js","workdir":"/repo","yield_time_ms":10000,"max_output_tokens":26000});\\ntext(r.output);'
      }),
      row('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'code-exec-1',
        output: [
          { type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' },
          { type: 'input_text', text: 'function rejectedBeforeExecution(output) { return /CreateProcess[\\s\\S]*Rejected|rejected:[\\s\\S]*denied/i.test(output) }' }
        ]
      }),
      row('2026-07-19T12:00:00.300Z', 'response_item', {
        type: 'custom_tool_call', name: 'exec_command', call_id: 'rejected-exec', arguments: JSON.stringify({ cmd: 'blocked' })
      }),
      row('2026-07-19T12:00:00.400Z', 'response_item', {
        type: 'custom_tool_call_output', call_id: 'rejected-exec', output: 'CreateProcess policy Rejected'
      }),
      row('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_complete', turn_id: 'code-turn', last_agent_message: 'done' })
    ].map((item) => JSON.stringify(item)).join('\n')}\n`)
    await handleRecorderHook({
      provider: 'codex', event: 'turn.started', workspace: root,
      payload: payload('code-session', { prompt: 'inspect', turn_id: 'code-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex', event: 'turn/completed', workspace: root,
      payload: payload('code-session', { turn_id: 'code-turn', rollout_path: rollout, timestamp: '2026-07-19T12:00:01.000Z' })
    })

    expect((await listRecords(join(root, '.scry')))[0]?.tools.value).toEqual([
      expect.objectContaining({ id: 'code-exec-1', name: 'Bash', status: 'success' })
    ])
  })

  it.each([
    ['spawn_agent', 'agent'],
    ['multi_agent_v1__spawn_agent', 'agent'],
    ['unrelated__spawn_agent', 'tool'],
    ['multi_agent_v1__close_agent', 'tool']
  ])('Codex hook-only 分类保持窄别名且 start/result 不双计: %s', async (name, category) => {
    const root = await workspace()
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
      await handleRecorderHook({ provider: 'codex', event, workspace: root, payload: payload('hook-alias', {
        turn_id: 'alias-turn', prompt: 'inspect', tool_name: name, tool_use_id: 'one-call',
        tool_input: { task_name: 'review' }, tool_response: 'done'
      }) })
    }
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toHaveLength(1)
    expect(record.tools.value?.[0].category).toBe(category)
  })

  it.each([
    [{ input_tokens: 4, output_tokens: 0 }, false, 'partial'],
    [{ input_tokens: 0, output_tokens: 0 }, true, 'available'],
    [{}, false, 'unavailable'],
    [{ input_tokens: -1, output_tokens: NaN, cost_usd: Infinity }, true, 'unavailable']
  ] as const)('usage 完整性从 hook 保留到持久化记录: %j', async (usage, complete, status) => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'opencode', event: 'UserPromptSubmit', workspace: root, payload: payload('usage-session', { prompt: 'inspect' }) })
    await handleRecorderHook({ provider: 'opencode', event: 'Stop', workspace: root, payload: payload('usage-session', { ...(complete ? { usage } : { usage_partial: usage }), usage_complete: complete }) })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.usage.status).toBe(status)
    if (status !== 'unavailable') expect(record.usage.value?.outputTokens).toBe(0)
  })

  it.each([
    [{ context_tokens: 120_000, context_window: 400_000, model: 'gpt-5.5', provider: 'openai' }, true],
    [{ context_tokens: 120_000, context_window: 400_000 }, false],
    [{ context_tokens: 120_000, context_window: 0, model: 'gpt-5.5' }, false],
    [{ context_tokens: -1, context_window: 400_000, model: 'gpt-5.5' }, false]
  ] as const)('lifecycle context_usage 只在模型、窗口、占用都合法时写入 Context: %j', async (context, kept) => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'pi', event: 'UserPromptSubmit', workspace: root, payload: payload('context-session', { prompt: 'inspect' }) })
    await handleRecorderHook({ provider: 'pi', event: 'Stop', workspace: root, payload: payload('context-session', {
      usage: { input_tokens: 10, output_tokens: 2 },
      context_usage: context
    }) })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.usage.value).toMatchObject({ inputTokens: 10, outputTokens: 2 })
    if (kept) {
      expect(record.usage.value).toMatchObject({
        contextTokens: 120_000,
        contextWindow: 400_000,
        contextModel: 'gpt-5.5',
        contextProvider: 'openai',
        contextUsageSource: 'lifecycle_context_usage',
        contextUsageQuality: 'exact'
      })
    } else {
      expect(record.usage.value?.contextTokens).toBeUndefined()
      expect(record.usage.value?.contextWindow).toBeUndefined()
    }
  })
}
