import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import type { TraceEvent } from '../../shared/trace'
import { handleRecorderHook, mergeTurnTraceEvents } from './recorder'
import { commitRecord, exportRecords, listRecords, readHealth, safeKey, verifyStore } from './store'

const roots: string[] = []
const pexecFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-recorder-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

const payload = (sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: sessionId,
  timestamp: '2026-07-19T12:00:00.000Z',
  ...extra
})

async function completeTurn(root: string, sessionId: string, prompt = 'implement feature'): Promise<void> {
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt }) })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PreToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_input: { command: 'printf ok' } })
  })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PostToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_response: 'ok' })
  })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }) })
}

describe('turn recorder state machine', () => {
  it('每个顶层轮次只提交一条正式记录，重复 Stop 不重复', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    const records = await listRecords(join(root, '.scry'))

    expect(duplicate.status).toBe('duplicate')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ sequence: 1, sessionId: 's1', generation: 1, turnIndex: 1, status: 'completed' })
    expect(records[0].tools.value).toEqual([
      expect.objectContaining({ id: 's1-tool', name: 'Bash', status: 'success', outputSummary: 'ok' })
    ])
    expect(records[0].usage).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    expect(records[0].diff).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
  })

  it('相同 prompt 的下一轮不会误去重，open 状态内的重复 prompt 会去重', async () => {
    const root = await workspace()
    const first = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    const duplicate = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'same' }) })
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1') })

    expect(first.status).toBe('started')
    expect(duplicate.status).toBe('duplicate')
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.generation, record.turnIndex])).toEqual([[1, 1], [2, 2]])
  })

  it('Codex 连续两轮输入相同 prompt 时按不同时间边界分别记录', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'same' }) })
    const next = await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('c1', { prompt: 'same', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' })
    })

    expect(next.status).toBe('started')
    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { turnIndex: 1, status: 'interrupted', user: { value: { text: 'same' } } },
      { turnIndex: 2, status: 'completed', user: { value: { text: 'same' } } }
    ])
  })

  it('cold-direct fallback 等待正在处理的同 session 事件，不误记 dropped', async () => {
    const root = await workspace()
    const lock = join(root, '.scry', 'locks', 'sessions', 'codex', `${safeKey('c1')}.lock`)
    await mkdir(lock, { recursive: true })
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }))
    const release = new Promise<void>((resolve) => {
      setTimeout(() => void rm(lock, { recursive: true, force: true }).then(() => resolve()), 2_100)
    })

    const [first, retry] = await Promise.all([
      handleRecorderHook({
        provider: 'codex',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('c1', { prompt: 'one' })
      }),
      handleRecorderHook({
        provider: 'codex',
        event: 'UserPromptSubmit',
        workspace: root,
        payload: payload('c1', { prompt: 'one' })
      })
    ])
    await release

    expect([first.status, retry.status].sort()).toEqual(['duplicate', 'started'])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ droppedEvents: 0 })
  }, 10_000)

  it('Codex 相同 prompt 的失败 attempt 与重试按 task lifecycle 分成两轮', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'same', turn_id: 'attempt-1' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        prompt: 'same',
        turn_id: 'attempt-1',
        timestamp: '2026-07-19T12:00:01.000Z',
        status: 'failed',
        error: 'stream disconnected'
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', {
        prompt: 'same',
        turn_id: 'attempt-2',
        timestamp: '2026-07-19T12:00:02.000Z'
      })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', {
        turn_id: 'attempt-2',
        timestamp: '2026-07-19T12:00:03.000Z'
      })
    })

    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { providerTurnId: 'attempt-1', turnIndex: 1, status: 'failed' },
      { providerTurnId: 'attempt-2', turnIndex: 2, status: 'completed' }
    ])
  })

  it('历史 providerTurnId 延迟重放不会终止当前轮或制造新轮', async () => {
    const root = await workspace()
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'one', turn_id: 'turn-1' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'turn-1', timestamp: '2026-07-19T12:00:01.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'two', turn_id: 'turn-2', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    const replay = await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'one', turn_id: 'turn-1', timestamp: '2026-07-19T12:00:03.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'turn-2', timestamp: '2026-07-19T12:00:04.000Z' })
    })

    expect(replay.status).toBe('duplicate')
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.providerTurnId, record.status])).toEqual([
      ['turn-1', 'completed'],
      ['turn-2', 'completed']
    ])
  })

  it('新 prompt 到来时把未结束旧轮提交为 interrupted', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'one' }) })
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'two', timestamp: '2026-07-19T12:00:02.000Z' }) })
    await handleRecorderHook({ provider: 'codex', event: 'turn/completed', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' }) })

    expect((await listRecords(join(root, '.scry'))).map((record) => record.status)).toEqual(['interrupted', 'completed'])
  })

  it('closing 轮的 transcript 仍在变化时，新 prompt 也不会被吞掉', async () => {
    const root = await workspace()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, '')
    await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'one', transcript_path: transcript }) })
    const timer = setInterval(() => void appendFile(transcript, '{}\n'), 10)
    try {
      const pending = await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1', { timestamp: '2026-07-19T12:00:01.000Z' }) })
      expect(pending.status).toBe('pending')
      expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 1 })
      const next = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1', { prompt: 'two', timestamp: '2026-07-19T12:00:02.000Z' }) })
      expect(next.status).toBe('started')
    } finally {
      clearInterval(timer)
    }
    await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload('s1', { timestamp: '2026-07-19T12:00:03.000Z' }) })
    expect((await listRecords(join(root, '.scry'))).map((record) => [record.turnIndex, record.status])).toEqual([[1, 'completed'], [2, 'completed']])
    expect(await readHealth(join(root, '.scry'))).toMatchObject({ pendingCount: 0 })
  })

  it('没有 open turn 的工具事件进入 orphan，不猜测归属', async () => {
    const root = await workspace()
    const result = await handleRecorderHook({ provider: 'qoder', event: 'PreToolUse:Read', workspace: root, payload: payload('q1', { tool_name: 'Read' }) })
    expect(result.status).toBe('orphan')
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  })

  it('重复上报同一 toolUseId 时正式记录只保留一次逻辑调用', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'turn.started', workspace: root, payload: payload('c1', { prompt: 'dedupe', turn_id: 't1' }) })
    for (const timestamp of ['2026-07-19T12:00:00.100Z', '2026-07-19T12:00:00.200Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'printf ok' } })
      })
    }
    for (const timestamp of ['2026-07-19T12:00:00.300Z', '2026-07-19T12:00:00.400Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('c1', { timestamp, turn_id: 't1', tool_name: 'Bash', tool_use_id: 'call-1', tool_response: 'ok' })
      })
    }
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z', turn_id: 't1' })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.tools.value).toEqual([
      expect.objectContaining({ id: 'call-1', status: 'success' })
    ])
  })
})

describe('lifecycle/transcript merge', () => {
  it('优先 transcript 的同一 toolUseId，并去掉 lifecycle 的重复 assistant/usage', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'life-tool', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'life-text', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'life-usage', kind: 'harness', stage: 'result', tokensIn: 9 })
    ]
    const transcript = [
      event({ id: 'transcript-tool', ts: '2026-01-01T00:00:01Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'transcript-text', ts: '2026-01-01T00:00:01Z', kind: 'model', stage: 'text', text: 'answer' }),
      event({ id: 'transcript-usage', ts: '2026-01-01T00:00:01Z', kind: 'harness', stage: 'result', text: 'transcript assistant usage', tokensIn: 9 })
    ]
    expect(mergeTurnTraceEvents(lifecycle, transcript).map((item) => item.id)).toEqual(['transcript-tool', 'transcript-text', 'transcript-usage'])
  })

  it('同一 toolUseId 的 lifecycle 重放不因 timestamp 不同重复计数', () => {
    const event = (overrides: Partial<TraceEvent>): TraceEvent => ({ id: 'id', ts: '2026-01-01T00:00:00Z', runId: 'r', kind: 'tool', stage: 'tool:Bash', ...overrides })
    const lifecycle = [
      event({ id: 'start-1', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'start-2', ts: '2026-01-01T00:00:00.250Z', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-1', ts: '2026-01-01T00:00:01Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' }),
      event({ id: 'result-2', ts: '2026-01-01T00:00:01.250Z', stage: 'tool_result', toolUseId: 't1', tool: 'Bash' })
    ]

    expect(mergeTurnTraceEvents(lifecycle, []).map((item) => item.id)).toEqual(['start-1', 'result-1'])
  })
})

describe('Codex rollout recorder evidence', () => {
  it('双 hook 入口重放同一 Codex tool lifecycle 时按 call_id 只记录一次', async () => {
    const root = await workspace()
    const rollout = join(root, 'duplicate-lifecycle-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-1' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          call_id: 'call-1',
          arguments: JSON.stringify({ cmd: 'git status --short' })
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'clean' }
      },
      {
        timestamp: '2026-07-19T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'codex-turn-1', last_agent_message: 'done' }
      }
    ]
    await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)

    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'inspect', turn_id: 'codex-turn-1', rollout_path: rollout })
    })
    for (const timestamp of ['2026-07-19T12:00:00.110Z', '2026-07-19T12:00:00.120Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('c1', {
          timestamp,
          turn_id: 'codex-turn-1',
          tool_name: 'Bash',
          tool_use_id: 'call-1',
          tool_input: { command: 'git status --short' }
        })
      })
    }
    for (const timestamp of ['2026-07-19T12:00:00.310Z', '2026-07-19T12:00:00.320Z']) {
      await handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('c1', {
          timestamp,
          turn_id: 'codex-turn-1',
          tool_name: 'Bash',
          tool_use_id: 'call-1',
          tool_response: 'clean'
        })
      })
    }
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
  })

  it('解析 task/token_count/tool/skill/hook，未观测项不伪造 exact 空数组', async () => {
    const root = await workspace()
    const rollout = join(root, 'rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'codex-turn-1' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'run workflow' } },
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
        payload: { type: 'task_complete', turn_id: 'codex-turn-1', last_agent_message: 'done' }
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
    expect(record.skills.value).toEqual([
      expect.objectContaining({ name: 'rate-workflow' })
    ])
    expect(record.hooks.value).toEqual([
      expect.objectContaining({ id: 'hook-1', event: 'UserPromptSubmit', status: 'success' })
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
  })

  it('还原 slash prompt、展开 Codex exec，并把子 agent 调用并入父轮但不重复 usage', async () => {
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
        input: `const a = await tools.exec_command({"cmd":"printf ok && sed -n '1,40p' .claude/skills/rate-workflow/SKILL.md /Users/test/.claude/skills/browser-use/SKILL.md"}); const b = await tools.exec_command({"cmd":"mcporter call coop.query --args '{}'"});`
      }),
      row('2026-07-19T12:00:00.200Z', 'response_item', {
        type: 'custom_tool_call_output',
        call_id: 'exec-1',
        output: 'ok'
      }),
      row('2026-07-19T12:00:00.250Z', 'response_item', {
        type: 'function_call',
        name: 'spawn_agent',
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
    expect(record.tools.value?.map((call) => [call.name, call.id])).toEqual([
      ['Bash', 'exec-1:1'],
      ['review', 'agent-1'],
      ['Bash', 'exec-map:1'],
      ['Bash', 'exec-map:2'],
      ['Edit', 'patch-1'],
      ['Bash', 'child-bash']
    ])
    expect(record.mcps.value).toEqual([
      expect.objectContaining({ id: 'exec-1:2', name: 'Bash', mcp: expect.objectContaining({ server: 'coop', action: 'query' }) })
    ])
    expect(record.skills.value?.map((call) => call.name)).toEqual(['rate-workflow', 'browser-use'])
    expect(record.files.value).toEqual([{ path: '/repo/new.txt', operation: 'edit' }])
    expect(record.usage.value).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, reasoningTokens: 5 })
  })

  it('未知 transcript 格式不会把 Skill/Hook/Usage 伪装为 exact 空', async () => {
    const root = await workspace()
    const transcript = join(root, 'unknown.jsonl')
    await writeFile(transcript, '{"type":"unknown"}\n')
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('c1', { prompt: 'unknown', turn_id: 'unknown-turn', rollout_path: transcript })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { turn_id: 'unknown-turn', rollout_path: transcript })
    })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.skills).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    expect(record.hooks).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
    expect(record.usage).toMatchObject({ status: 'unavailable', quality: 'unavailable' })
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
      line('2026-07-19T12:00:02.100Z', 'event_msg', token(250, 25, 200)),
      line('2026-07-19T12:00:03.000Z', 'event_msg', { type: 'task_complete', turn_id: 't2' })
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
})

describe('record store cursor and recovery semantics', () => {
  it('跨 session 使用全局 sequence，分页 snapshot 不漏晚提交', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await completeTurn(root, 'b')
    const first = await exportRecords(join(root, '.scry'), { after: 0, limit: 1 })
    await completeTurn(root, 'a', 'late')
    const second = await exportRecords(join(root, '.scry'), { after: first.nextCursor, limit: 10, snapshotMaxSequence: first.snapshotMaxSequence })
    const nextSnapshot = await exportRecords(join(root, '.scry'), { after: second.nextCursor, limit: 10 })

    expect(first.records.map((record) => record.sequence)).toEqual([1])
    expect(first).toMatchObject({ nextCursor: 1, hasMore: true, snapshotMaxSequence: 2 })
    expect(second.records.map((record) => record.sequence)).toEqual([2])
    expect(nextSnapshot.records.map((record) => record.sequence)).toEqual([3])
  })

  it('sequence cache 丢失后从正式记录重建，不覆盖旧记录', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    await unlink(join(root, '.scry', 'state', 'next-sequence.json'))
    await writeFile(join(root, '.scry', 'records', 'rename-before-crash.tmp'), '{"partial":true}')
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((record) => record.sequence)).toEqual([1, 2])
    await expect(verifyStore(join(root, '.scry'))).resolves.toEqual({ ok: true, records: 2, errors: [] })
  })

  it('正式文件已 rename 后重试提交保持幂等，并能回收死进程锁', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    const [record] = await listRecords(join(root, '.scry'))
    const { sequence: _sequence, ...draft } = record
    await expect(commitRecord(join(root, '.scry'), draft)).resolves.toMatchObject({ status: 'duplicate', record: { sequence: 1 } })

    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }))
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((item) => item.sequence)).toEqual([1, 2])
  })

  it('立即回收刚刚崩溃进程留下的锁，不等待 TTL', async () => {
    const root = await workspace()
    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }))
    const started = Date.now()
    await completeTurn(root, 'recent-dead-lock')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('缺配置或外部熔断时不创建 .scry', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-recorder-disabled-'))
    roots.push(missing)
    const noConfig = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: missing, payload: payload('s1') })
    expect(noConfig).toMatchObject({ status: 'disabled', reason: 'missing_config' })
    await expect(access(join(missing, '.scry'))).rejects.toThrow()

    const root = await workspace()
    const envDisabled = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1'), env: { SCRY_RECORDER_ENABLED: '0' } })
    expect(envDisabled).toMatchObject({ status: 'disabled', reason: 'environment' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()

    await writeFile(join(root, '.scry-disabled'), '')
    const sentinel = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1') })
    expect(sentinel).toMatchObject({ status: 'disabled', reason: 'sentinel' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()
  })

  it('正式记录是独立 JSON 文件且不含上传配置', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const names = await import('node:fs/promises').then(({ readdir }) => readdir(join(root, '.scry', 'records')))
    expect(names).toHaveLength(1)
    const source = await readFile(join(root, '.scry', 'records', names[0]), 'utf8')
    expect(source).not.toContain('reportTraces')
    expect(source).not.toContain('upload')
  })
})

describe('nested Git turn diff', () => {
  it('按真实子仓归属记录本轮净变化', async () => {
    const root = await workspace()
    const repository = join(root, 'plugin-commerce-app')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(repository))
    await pexecFile('git', ['init'], { cwd: repository })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: repository })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: repository })
    await writeFile(join(repository, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', '.'], { cwd: repository })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: repository })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.repositories = { mode: 'discover-nested-git', maxDepth: 2 }
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'opencode', event: 'chat.message', workspace: root, payload: payload('o1', { prompt: 'edit nested repo' }) })
    await writeFile(join(repository, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'opencode', event: 'session.idle', workspace: root, payload: payload('o1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff).toMatchObject({ status: 'available', quality: 'exact' })
    const canonicalRepository = await realpath(repository)
    expect(record.diff.value?.[0]).toMatchObject({ status: 'captured', repoRoot: canonicalRepository })
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(canonicalRepository, 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 15_000)

  it('即使接入方未忽略 .scry，Recorder 自身文件也不污染 Diff', async () => {
    const root = await workspace()
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'before\n')
    await pexecFile('git', ['add', 'a.txt'], { cwd: root })
    await pexecFile('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline'], { cwd: root })
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8'))
    config.capture.diff = true
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))

    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'edit root' }) })
    await writeFile(join(root, 'a.txt'), 'after\n')
    await handleRecorderHook({ provider: 'codex', event: 'Stop', workspace: root, payload: payload('c1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    const [record] = await listRecords(join(root, '.scry'))
    expect(record.diff.value?.[0].files).toEqual([
      expect.objectContaining({ path: join(await realpath(root), 'a.txt'), added: 1, deleted: 1, patchStatus: 'captured' })
    ])
  }, 15_000)
})
