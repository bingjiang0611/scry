import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload } from './fixture.test'

export function registerSuite12(): void {


  it.each([
    { name: 'spawn_agent' },
    { name: 'multi_agent_v1__spawn_agent' },
    { namespace: 'multi_agent_v1', name: 'spawn_agent' }
  ])('还原 slash prompt、展开 Codex exec，并把子 agent 调用并入父轮但不重复 usage: %j', async (spawnName) => {
    const root = await workspace()
    const parent = join(root, 'rollout-parent.jsonl')
    const childId = '019fa774-618b-75b3-aed1-7f1dd8eb02f2'
    const child = join(root, `rollout-child-${childId}.jsonl`)
    const row = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    const parentLines = [
      row('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 'parent-turn' }),
      row('2026-07-19T12:00:00.010Z', 'event_msg', { type: 'user_message', message: '84441877' }),
      row('2026-07-19T12:00:00.020Z', 'response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<skill><name>rate-workflow</name></skill>' }]
      }),
      row('2026-07-19T12:00:00.100Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'exec-1',
        input: `const a = await tools.exec_command({"cmd":"printf ok && sed -n '1,40p' .claude/skills/rate-workflow/SKILL.md /Users/test/.claude/skills/browser-use/SKILL.md"}); const b = await tools.exec_command({"cmd":"mcporter call workitem.query --args '{}'"});`
      }),
      row('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'exec-1',
        output: 'ok'
      }),
      row('2026-07-19T12:00:00.250Z', 'response_item', {
        type: 'function_call',
        ...spawnName,
        call_id: 'agent-1',
        arguments: JSON.stringify({ task_name: 'review', message: 'review it' })
      }),
      row('2026-07-19T12:00:00.260Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'exec',
        call_id: 'exec-map',
        input: `const cmds = ["printf one", "printf two"]; const rs = await Promise.all(cmds.map(cmd => tools.exec_command({cmd,workdir:"/repo",yield_time_ms:10000})));`
      }),
      row('2026-07-19T12:00:00.270Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'exec-map',
        output: 'one\ntwo'
      }),
      row('2026-07-19T12:00:00.300Z', 'event_msg', {
        type: 'sub_agent_activity',
        kind: 'started',
        event_id: 'agent-1',
        agent_thread_id: childId,
        agent_path: '/root/review'
      }),
      row('2026-07-19T12:00:00.310Z', 'response_item', {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'patch-1',
        input: '*** Begin Patch\n*** Add File: /repo/new.txt\n+new\n*** End Patch\n'
      }),
      row('2026-07-19T12:00:00.320Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'patch-1',
        output: 'Done!'
      }),
      row('2026-07-19T12:00:00.330Z', 'event_msg', {
        type: 'patch_apply_end',
        call_id: 'patch-1',
        turn_id: 'parent-turn',
        changes: ['/repo/new.txt']
      }),
      row('2026-07-19T12:00:00.900Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            output_tokens: 20,
            cached_input_tokens: 80,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 5
          }
        }
      }),
      row('2026-07-19T12:00:01.000Z', 'event_msg', {
        type: 'task_complete',
        turn_id: 'parent-turn',
        last_agent_message: 'done'
      })
    ]
    const childLines = [
      row('2026-07-19T12:00:00.310Z', 'event_msg', { type: 'task_started', turn_id: 'child-turn' }),
      row('2026-07-19T12:00:00.400Z', 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'child-bash',
        arguments: JSON.stringify({ cmd: 'git status --short' })
      }),
      row('2026-07-19T12:00:00.500Z', 'response_item', {
        type: 'function_call_output',
        call_id: 'child-bash',
        output: 'clean'
      }),
      row('2026-07-19T12:00:00.600Z', 'event_msg', {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 900,
            output_tokens: 90,
            cached_input_tokens: 700,
            cache_write_input_tokens: 0,
            reasoning_output_tokens: 10
          }
        }
      }),
      row('2026-07-19T12:00:00.700Z', 'event_msg', { type: 'task_complete', turn_id: 'child-turn' })
    ]
    await writeFile(parent, `${parentLines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    await writeFile(child, `${childLines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: '84441877', turn_id: 'parent-turn', rollout_path: parent })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'parent-turn', rollout_path: parent, timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.user.value?.text).toBe('/rate-workflow 84441877')
    expect(record.tools.value?.filter((call) => call.category === 'agent')).toHaveLength(1)
    expect(record.tools.value?.map((call) => [call.name, call.id])).toEqual([
      ['Bash', 'exec-1:1'],
      ['review', 'agent-1'],
      ['Bash', 'exec-map:1'],
      ['Bash', 'exec-map:2'],
      ['Edit', 'patch-1'],
      ['Bash', 'child-bash']
    ])
    expect(record.mcps.value).toEqual([
      expect.objectContaining({ id: 'exec-1:2', name: 'Bash', mcp: expect.objectContaining({ server: 'workitem', action: 'query' }) })
    ])
    expect(record.skills.value?.map((call) => call.name)).toEqual(['rate-workflow'])
    expect(record.files.value).toEqual([{ path: '/repo/new.txt', operation: 'edit' }])
    expect(record.usage.value).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 5 })
  })

  it('未知 transcript 格式无法匹配指定 turn 时保持 pending，不伪造或借用记录', async () => {
    const root = await workspace()
    const transcript = join(root, 'unknown.jsonl')
    await writeFile(transcript, '{"type":"unknown"}\n')
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'unknown', turn_id: 'unknown-turn', rollout_path: transcript })
    })
    const completed = await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'unknown-turn', rollout_path: transcript })
    })

    expect(completed).toMatchObject({
      status: 'pending',
      reason: 'target turn is not present in transcript snapshot'
    })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  })

  it('token_count 使用累计值做轮间差分，不重复累计 last_token_usage', async () => {
    const root = await workspace()
    const rollout = join(root, 'cumulative-rollout.jsonl')
    const line = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    const token = (input: number, output: number, cache: number) => ({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          cached_input_tokens: cache,
          cache_write_input_tokens: 0,
          reasoning_output_tokens: 0
        },
        // Deliberately repeated/noisy; authoritative per-turn usage comes from cumulative deltas.
        last_token_usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache }
      }
    })
    const lines = [
      line('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 't1' }),
      line('2026-07-19T12:00:00.100Z', 'event_msg', token(100, 10, 80)),
      line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_complete', turn_id: 't1' }),
      line('2026-07-19T12:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 't2' }),
      line('2026-07-19T12:00:02.100Z', 'event_msg', token(250, 25, 200))
    ]
    await writeFile(rollout, `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`)

    for (const [turnId, start, end] of [
      ['t1', '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:01.000Z'],
      ['t2', '2026-07-19T12:00:02.000Z', '2026-07-19T12:00:03.000Z']
    ]) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn.started',
        workspace: root,
        payload: payload('c1', { prompt: turnId, turn_id: turnId, rollout_path: rollout, timestamp: start })
      })
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn/completed',
        workspace: root,
        payload: payload('c1', { turn_id: turnId, rollout_path: rollout, timestamp: end })
      })
    }

    expect((await listRecords(join(root, '.scry'))).map((record) => record.usage.value)).toEqual([
      expect.objectContaining({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 80 }),
      expect.objectContaining({ inputTokens: 150, outputTokens: 15, cacheReadTokens: 120 })
    ])
  })

  it('turn_context 的模型与 token_count 的窗口归属本轮用量和 Context，多模型不挑选', async () => {
    const root = await workspace()
    const rollout = join(root, 'model-rollout.jsonl')
    const line = (timestamp: string, type: string, payload: Record<string, unknown>) => ({ timestamp, type, payload })
    const token = (input: number, lastInput: number) => ({
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0 },
        last_token_usage: { input_tokens: lastInput, output_tokens: 5, cached_input_tokens: 0 },
        model_context_window: 400_000
      }
    })
    const lines = [
      line('2026-07-19T12:00:00.000Z', 'event_msg', { type: 'task_started', turn_id: 't1' }),
      line('2026-07-19T12:00:00.010Z', 'turn_context', { turn_id: 't1', model: 'gpt-5.5' }),
      line('2026-07-19T12:00:00.100Z', 'event_msg', token(100, 60)),
      line('2026-07-19T12:00:00.200Z', 'event_msg', token(250, 150)),
      line('2026-07-19T12:00:01.000Z', 'event_msg', { type: 'task_complete', turn_id: 't1' }),
      line('2026-07-19T12:00:02.000Z', 'event_msg', { type: 'task_started', turn_id: 't2' }),
      line('2026-07-19T12:00:02.010Z', 'turn_context', { turn_id: 't2', model: 'gpt-5.5' }),
      line('2026-07-19T12:00:02.020Z', 'turn_context', { turn_id: 't2', model: 'gpt-5.5-mini' }),
      line('2026-07-19T12:00:02.100Z', 'event_msg', token(400, 170))
    ]
    await writeFile(rollout, `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`)

    for (const [turnId, start, end] of [
      ['t1', '2026-07-19T12:00:00.000Z', '2026-07-19T12:00:01.000Z'],
      ['t2', '2026-07-19T12:00:02.000Z', '2026-07-19T12:00:03.000Z']
    ]) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn.started',
        workspace: root,
        payload: payload('c1', { prompt: turnId, turn_id: turnId, rollout_path: rollout, timestamp: start })
      })
      await handleRecorderHook({
        provider: 'codex',
        event: 'turn/completed',
        workspace: root,
        payload: payload('c1', { turn_id: turnId, rollout_path: rollout, timestamp: end })
      })
    }

    const [single, mixed] = await listRecords(join(root, '.scry'))
    expect(single.provider).toMatchObject({ model: 'gpt-5.5', modelStatus: 'observed', modelSource: 'usage_event' })
    expect(single.usage.value).toMatchObject({
      model: 'gpt-5.5',
      contextTokens: 150,
      contextWindow: 400_000,
      contextModel: 'gpt-5.5',
      contextUsageSource: 'codex_rollout_last_usage',
      contextUsageQuality: 'exact'
    })
    expect(mixed.provider.model).toBeUndefined()
    expect(mixed.usage.value).toMatchObject({ inputTokens: 150 })
    expect(mixed.usage.value?.contextTokens).toBeUndefined()
    expect(mixed.usage.value?.model).toBeUndefined()
  })
}
