import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords } from '../store'
import { workspace, payload, registerEarlyStopCase } from './fixture.test'

export function registerSuite10(): void {


  it('解析 task/token_count/tool/hook，Skill 路径引用不算执行', async () => {
    const root = await workspace()
    const rollout = join(root, 'rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-1' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'run workflow' } },
      { timestamp: '2026-07-19T12:00:00.050Z', type: 'event_msg', payload: { type: 'agent_message', message: '先检查' } },
      { timestamp: '2026-07-19T12:00:00.051Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先检查' }] } },
      { timestamp: '2026-07-19T12:00:00.060Z', type: 'response_item', payload: { type: 'reasoning', id: 'reasoning-1', summary: [{ type: 'summary_text', text: '定位文件' }] } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: "sed -n '1,120p' .codex/skills/rate-workflow/SKILL.md" })
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
      },
      { timestamp: '2026-07-19T12:00:00.250Z', type: 'event_msg', payload: { type: 'agent_message', message: '完成' } },
      { timestamp: '2026-07-19T12:00:00.251Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] } },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'event_msg',
        payload: {
          type: 'hook_started',
          hook_id: 'hook-1',
          hook_event: 'UserPromptSubmit',
          hook_name: 'trace_prompt.py',
          command: 'python3 .claude/hooks/trace_prompt.py'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'event_msg',
        payload: {
          type: 'hook_response',
          hook_id: 'hook-1',
          hook_event: 'UserPromptSubmit',
          hook_name: 'trace_prompt.py',
          command: 'python3 .claude/hooks/trace_prompt.py',
          outcome: 'success',
          exit_code: 0
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 80,
              cache_write_input_tokens: 7,
              output_tokens: 11,
              reasoning_output_tokens: 3
            }
          }
        }
      },
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'codex-turn-1', last_agent_message: '完成' }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'run workflow', turn_id: 'codex-turn-1', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        turn_id: 'codex-turn-1',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:01.000Z'
      })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-1', name: 'Bash', status: 'success' })
    ])
    expect(record.skills.value).toEqual([])
    expect(record.hooks.value).toEqual([
      expect.objectContaining({ event: 'UserPromptSubmit', status: 'success' })
    ])
    expect(record.usage).toMatchObject({
      status: 'available',
      quality: 'exact',
      value: {
        inputTokens: 120,
        outputTokens: 11,
        cacheReadTokens: 80,
        cacheCreationTokens: 7,
        reasoningTokens: 3
      }
    })
    expect(record.assistant.value?.text).toBe('先检查完成')
    expect(record.modelSegments?.value).toEqual([
      expect.objectContaining({ order: 0, kind: 'text', text: '先检查' }),
      expect.objectContaining({ order: 1, kind: 'thinking', text: '定位文件', messageId: 'reasoning-1' }),
      expect.objectContaining({ order: 5, kind: 'text', text: '完成' })
    ])
  })

  it('连续重复的 last_token_usage 帧只计一次，真实的下一帧仍然累加', async () => {
    const root = await workspace()
    const rollout = join(root, 'repeat-usage.jsonl')
    const frame = (timestamp: string, input: number, output: number): Record<string, unknown> => ({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: 0
          }
        }
      }
    })
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'repeat-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'count tokens' } },
      // 同一帧被连续广播三次：只能计一次。
      frame('2026-07-19T12:00:00.100Z', 100, 10),
      frame('2026-07-19T12:00:00.200Z', 100, 10),
      frame('2026-07-19T12:00:00.300Z', 100, 10),
      // 真实的第二次请求：必须累加。
      frame('2026-07-19T12:00:00.400Z', 50, 5),
      { timestamp: '2026-07-19T12:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'repeat-turn', last_agent_message: 'done' } }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('repeat', { prompt: 'count tokens', turn_id: 'repeat-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('repeat', { turn_id: 'repeat-turn', rollout_path: rollout, timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.usage).toMatchObject({
      status: 'available',
      value: { inputTokens: 150, outputTokens: 15 }
    })
  })

  it('rollout 里的 hook_started/hook_completed 按 Codex 事件名识别，status=stopped 记为 cancelled', async () => {
    const root = await workspace()
    const rollout = join(root, 'hook-completed-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'hook-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'run hooks' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'event_msg',
        payload: { type: 'hook_started', hook_id: 'hook-ok', hook_event: 'PreToolUse', hook_name: 'branch-check.sh', command: 'sh branch-check.sh' }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'event_msg',
        payload: { type: 'hook_completed', hook_id: 'hook-ok', hook_event: 'PreToolUse', hook_name: 'branch-check.sh', command: 'sh branch-check.sh', status: 'completed', exit_code: 0 }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'event_msg',
        payload: { type: 'hook_completed', hook_id: 'hook-stopped', hook_event: 'Stop', hook_name: 'audit.py', status: 'stopped' }
      },
      { timestamp: '2026-07-19T12:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'hook-turn', last_agent_message: 'done' } }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('hook-c1', { prompt: 'run hooks', turn_id: 'hook-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('hook-c1', { turn_id: 'hook-turn', rollout_path: rollout, timestamp: '2026-07-19T12:00:01.000Z' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.hooks).toMatchObject({ status: 'available', quality: 'exact' })
    expect(record.hooks.value).toEqual([
      expect.objectContaining({ event: 'PreToolUse', name: 'branch-check.sh', status: 'success', durationMs: 100 }),
      expect.objectContaining({ event: 'Stop', name: 'audit.py', status: 'cancelled' })
    ])
  })

  registerEarlyStopCase()


  it('把异步 code-mode 的 wait 输出关联回原始逻辑调用', async () => {
    const root = await workspace()
    const rollout = join(root, 'async-code-mode-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'async-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect async' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: `const cmds = ["printf ok", "jq broken"];
const rs = await Promise.all(cmds.map(cmd => tools.exec_command({ cmd })));
rs.forEach((r, i) => text(\`R\${i + 1}\\n\${r.output}\`));`
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec',
          output: 'Script running with cell ID 44\nWall time 11.0 seconds\nOutput:\n'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait',
          call_id: 'call_wait',
          arguments: '{"cell_id":"44","yield_time_ms":30000}'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: [
            { type: 'input_text', text: 'Script completed\nWall time 0.0 seconds\nOutput:\n' },
            { type: 'input_text', text: 'R1\nok' },
            { type: 'input_text', text: 'R2\njq: error (at input.json:1): broken query' }
          ]
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 10,
              cache_write_input_tokens: 0,
              output_tokens: 5,
              reasoning_output_tokens: 1
            }
          }
        }
      },
      { timestamp: '2026-07-19T12:00:00.600Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'async-turn' } }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('async-session', { prompt: 'inspect async', turn_id: 'async-turn', rollout_path: rollout })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('async-session', { turn_id: 'async-turn', rollout_path: rollout })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ status: 'success', outputSummary: 'ok' }),
      expect.objectContaining({ status: 'failed', outputSummary: 'jq: error (at input.json:1): broken query' })
    ])
    expect(record.errors.value).toEqual([
      expect.objectContaining({ message: 'jq: error (at input.json:1): broken query' })
    ])
  })
}
