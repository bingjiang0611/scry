import { describe, it, expect } from 'vitest'
import {
  type NormalizeCtx,
  normalizeSdkMessage,
  normalizeTranscriptLine,
  parseTranscriptToTurns,
  humanEvent
} from './normalize'
import { maskSecrets } from '../shared/trace'

function ctx(): NormalizeCtx {
  let n = 0
  return { runId: 'run-1', newId: () => `ev-${n++}`, now: () => '2026-06-23T00:00:00.000Z' }
}

describe('normalizeSdkMessage', () => {
  it('把 assistant 的 text 和 thinking block 拆成 model 事件', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '先看一下文件' },
            { type: 'text', text: '我来读取' }
          ]
        }
      },
      ctx()
    )
    expect(evs).toHaveLength(2)
    expect(evs[0]).toMatchObject({ kind: 'model', stage: 'thinking', thinking: '先看一下文件' })
    expect(evs[1]).toMatchObject({ kind: 'model', stage: 'text', text: '我来读取' })
  })

  it('识别普通 tool_use，并从 Read/Write/Edit 投影文件足迹', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: '/a/b.ts' } }]
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'tool',
      tool: 'Write',
      toolUseId: 'tu-1',
      fileOp: 'write',
      filePath: '/a/b.ts',
      isMcp: false
    })
  })

  it('Glob 不产生文件足迹（没有 file_path）', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-2', name: 'Glob', input: { pattern: '**/*.ts' } }] }
      },
      ctx()
    )
    expect(evs[0].fileOp).toBeUndefined()
    expect(evs[0].filePath).toBeUndefined()
  })

  it('识别 mcp__server__action 工具', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-3', name: 'mcp__github__list_issues', input: {} }] }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({ isMcp: true, mcpServer: 'github', tool: 'mcp__github__list_issues' })
  })

  it('识别 Bash 里的 mcporter call 为 MCP bridge 调用', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-mcporter',
              name: 'Bash',
              input: { command: 'MC=/Users/me/bin/mcporter; "$MC" call tracker.query_issue_detail --args \'{"issueId":"1"}\'' }
            }
          ]
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'tool',
      tool: 'Bash',
      isMcp: true,
      mcpServer: 'tracker',
      mcpAction: 'query_issue_detail',
      mcpTool: 'mcporter:tracker.query_issue_detail'
    })
  })

  it('Task → agent kind，Skill → skill kind', () => {
    const task = normalizeSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't', name: 'Task', input: { subagent_type: 'Explore' } }] }
      },
      ctx()
    )
    expect(task[0]).toMatchObject({ kind: 'agent', name: 'Explore', stage: 'agent:Explore' })

    const skill = normalizeSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill: 'deep-research' } }] }
      },
      ctx()
    )
    expect(skill[0]).toMatchObject({ kind: 'skill', name: 'deep-research', stage: 'skill:deep-research' })
  })

  it('result 事件带 cost/token/duration', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.12,
        duration_ms: 3400,
        usage: { input_tokens: 100, output_tokens: 50 }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'harness',
      stage: 'result',
      costUsd: 0.12,
      costSource: 'sdk_estimate',
      costConfidence: 'estimated',
      costUnit: 'usd',
      tokensIn: 100,
      tokensOut: 50,
      durationMs: 3400,
      isError: false
    })
  })

  it('P0：result 有 modelUsage 时 token 从 per-model 聚合（顶层 usage 会少算）+ cache/api 字段', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.88,
        duration_ms: 33000,
        duration_api_ms: 21900,
        usage: { input_tokens: 15422, output_tokens: 100, cache_read_input_tokens: 44316, cache_creation_input_tokens: 73913 }, // 顶层=最后一次调用
        modelUsage: {
          'claude-opus-4-8[1m]': {
            inputTokens: 30054,
            outputTokens: 381,
            cacheReadInputTokens: 66665,
            cacheCreationInputTokens: 110635,
            costUSD: 0.88,
            contextWindow: 1000000
          }
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      costUsd: 0.88,
      costSource: 'sdk_estimate',
      costConfidence: 'estimated',
      costUnit: 'usd',
      tokensIn: 30054, // 取 modelUsage 聚合，非顶层 15422
      tokensOut: 381,
      cacheReadTokens: 66665,
      cacheCreationTokens: 110635,
      durationApiMs: 21900,
      contextTokens: 133651 // 顶层 usage 完整 prompt：15422+44316+73913（当前上下文占用）
    })
    expect(evs[0].modelUsage).toEqual([
      {
        model: 'claude-opus-4-8[1m]',
        inputTokens: 30054,
        outputTokens: 381,
        cacheReadTokens: 66665,
        cacheCreationTokens: 110635,
        costUsd: 0.88,
        costSource: 'sdk_estimate',
        costConfidence: 'estimated',
        costUnit: 'usd',
        contextWindow: 1000000
      }
    ])
  })

  it('Context% 用最近 assistant usage，不用 result 的累计 cache_read', () => {
    const c = ctx()
    normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          usage: { input_tokens: 2, cache_read_input_tokens: 198776, cache_creation_input_tokens: 1379 },
          content: [{ type: 'text', text: 'done' }]
        }
      },
      c
    )
    const evs = normalizeSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 8834, cache_read_input_tokens: 1528715, cache_creation_input_tokens: 175481 },
        modelUsage: {
          'claude-opus-4-8[1m]': {
            inputTokens: 8834,
            outputTokens: 12312,
            cacheReadInputTokens: 1528715,
            cacheCreationInputTokens: 175481,
            contextWindow: 1000000
          }
        }
      },
      c
    )
    expect(evs[0].contextTokens).toBe(200157)
  })

  it('P0：assistant 事件带 message.id（messageId=llm_request 级）+ parent_tool_use_id', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: { id: 'msg_abc', content: [{ type: 'text', text: 'hi' }] }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({ messageId: 'msg_abc', parentToolUseId: 'toolu_parent', text: 'hi' })
  })

  it('user message 的 tool_result 生成 tool_result 事件', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'ok output', is_error: false }] }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'tool',
      stage: 'tool_result',
      toolUseId: 'tu-1',
      text: 'ok output',
      isError: false
    })
  })

  it('用 tool_use 身份补全 Qoder MCP tool_result', () => {
    const c = ctx()
    normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp__scry-e2e__repo_tree', input: { path: '.' } }]
        }
      },
      c
    )
    const result = normalizeSdkMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: 'ok', is_error: false }] }
      },
      c
    )[0]
    expect(result).toMatchObject({
      kind: 'tool',
      stage: 'tool_result',
      toolUseId: 'mcp-1',
      tool: 'mcp__scry-e2e__repo_tree',
      isMcp: true,
      mcpServer: 'scry-e2e',
      mcpAction: 'repo_tree',
      isError: false
    })
  })

  it('skill 注入 user message 生成 skill 事件', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'text',
              text: 'Base directory for this skill: /Users/x/sample-workspace/.claude/skills/workflow-orchestrator\n\n# workflow-orchestrator'
            }
          ]
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({ kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator', tool: 'Skill' })
  })

  it('从 Read 的 skill 文件路径通用推断 skill 事件', () => {
    const filePath = '/Users/x/sample-workspace/.claude/skills/consumer-doc/SKILL.md'
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'msg_skill_read',
          content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: filePath } }]
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'skill',
      stage: 'skill:consumer-doc',
      name: 'consumer-doc',
      tool: 'Skill',
      messageId: 'msg_skill_read',
      input: { source: 'skill_file', path: filePath }
    })
    expect(evs[1]).toMatchObject({ kind: 'tool', tool: 'Read', toolUseId: 'read-1', filePath })
  })

  it('从 Bash 命令里的 skill 路径通用推断 skill 事件', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'bash-1',
              name: 'Bash',
              input: { command: 'cd /Users/x/sample-workspace && sed -n "1,120p" .claude/skills/consumer-doc/SKILL.md' }
            }
          ]
        }
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'skill',
      stage: 'skill:consumer-doc',
      name: 'consumer-doc',
      input: { source: 'skill_path_in_bash' }
    })
    expect(evs[1]).toMatchObject({ kind: 'tool', tool: 'Bash', toolUseId: 'bash-1' })
  })

  it('同一轮里 Bash 路径和 Read 同一个 skill 时只推断一次', () => {
    const c = ctx()
    const bash = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'bash-1',
              name: 'Bash',
              input: { command: 'cat .claude/skills/consumer-doc/SKILL.md' }
            }
          ]
        }
      },
      c
    )
    const read = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: '/Users/x/sample-workspace/.claude/skills/consumer-doc/SKILL.md' }
            }
          ]
        }
      },
      c
    )
    expect(bash.filter((e) => e.kind === 'skill')).toHaveLength(1)
    expect(read.filter((e) => e.kind === 'skill')).toHaveLength(0)
    expect(read[0]).toMatchObject({ kind: 'tool', tool: 'Read', toolUseId: 'read-1' })
  })

  it('中间切到别的 skill 后，再读回原 skill 会重新分段', () => {
    const c = ctx()
    const readSkill = (name: string) =>
      normalizeSdkMessage(
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `read-${name}`,
                name: 'Read',
                input: { file_path: `/Users/x/sample-workspace/.claude/skills/${name}/SKILL.md` }
              }
            ]
          }
        },
        c
      ).find((e) => e.kind === 'skill')

    expect(readSkill('workflow-orchestrator')).toMatchObject({ name: 'workflow-orchestrator' })
    expect(readSkill('consumer-doc')).toMatchObject({ name: 'consumer-doc' })
    expect(readSkill('workflow-orchestrator')).toMatchObject({ name: 'workflow-orchestrator' })
  })

  it('SDK hook_response 生成 hook 事件', () => {
    const evs = normalizeSdkMessage(
      {
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hk-1',
        hook_name: 'branch-check-hook.sh',
        hook_event: 'PreToolUse',
        output: 'branch ok',
        stdout: 'branch ok',
        stderr: '',
        exit_code: 0,
        outcome: 'success',
        session_id: 'sess-1'
      },
      ctx()
    )
    expect(evs[0]).toMatchObject({
      kind: 'hook',
      stage: 'hook_response',
      hookId: 'hk-1',
      hookName: 'branch-check-hook.sh',
      hookEvent: 'PreToolUse',
      hookOutcome: 'success',
      hookExitCode: 0,
      text: 'branch ok',
      isError: false
    })
  })

  it('未知 message 类型返回空', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'init' }, ctx())).toEqual([])
  })
})

describe('humanEvent', () => {
  it('生成 human prompt 事件并截断到 500 字', () => {
    const ev = humanEvent('x'.repeat(600), ctx())
    expect(ev.kind).toBe('human')
    expect(ev.stage).toBe('prompt')
    expect(ev.text).toHaveLength(500)
  })
})

describe('normalizeTranscriptLine', () => {
  it('解析 subagent transcript 行，带上 agentId', () => {
    const c: NormalizeCtx = { ...ctx(), agentId: 'sub-9' }
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'i', name: 'Read', input: { file_path: '/x.ts' } }] }
    })
    const evs = normalizeTranscriptLine(line, c)
    expect(evs[0]).toMatchObject({ agentId: 'sub-9', tool: 'Read', fileOp: 'read', filePath: '/x.ts' })
  })

  it('坏行（半截写入）静默跳过', () => {
    expect(normalizeTranscriptLine('{"type":"assist', ctx())).toEqual([])
  })
})

describe('parseTranscriptToTurns', () => {
  it('历史 transcript 保留 skill 注入事件', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '<command-name>/workflow-orchestrator</command-name><command-args>12345678</command-args>' }
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Base directory for this skill: /Users/x/sample-workspace/.claude/skills/workflow-orchestrator\n\n# workflow-orchestrator'
            }
          ]
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 2, cache_read_input_tokens: 198776, cache_creation_input_tokens: 1379 },
          content: [{ type: 'text', text: 'done' }]
        }
      })
    ].join('\n')
    const turns = parseTranscriptToTurns(content, ctx())
    expect(turns).toHaveLength(1)
    expect(turns[0].items[0]).toMatchObject({ kind: 'skill', name: 'workflow-orchestrator' })
    expect(turns[0].items.at(-1)).toMatchObject({
      kind: 'harness',
      stage: 'result',
      contextTokens: 200157,
      tokensIn: 2,
      tokensOut: 0,
      cacheReadTokens: 198776,
      cacheCreationTokens: 1379,
      modelUsage: [
        {
          model: 'claude-opus-4-8[1m]',
          inputTokens: 2,
          outputTokens: 0,
          cacheReadTokens: 198776,
          cacheCreationTokens: 1379,
          contextWindow: 1000000
        }
      ]
    })
    expect(turns[0].items.at(-1)?.costUsd).toBeUndefined()
  })

  it('隐藏 Claude resume meta 轮次，把其 Hook 证据归到下一条真实用户输入并保留原始时间', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-14T02:38:14.536Z',
        message: { role: 'user', content: '<command-name>/workflow-orchestrator</command-name><command-args>12345678</command-args>' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-14T02:38:15.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '请选择范围' }] }
      }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        timestamp: '2026-07-14T02:52:41.387Z',
        message: { role: 'user', content: 'Continue from where you left off.' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-14T02:52:41.500Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] }
      }),
      JSON.stringify({
        type: 'attachment',
        timestamp: '2026-07-14T02:52:42.000Z',
        attachment: {
          type: 'hook_success',
          hookName: 'SessionStart:resume',
          hookEvent: 'SessionStart',
          toolUseID: 'resume-hook',
          command: 'restore-active-state-hook.sh',
          exitCode: 0
        }
      }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-07-14T02:52:43.685Z',
        message: { role: 'user', content: '1A' }
      }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-07-14T02:52:44.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: '继续执行' }] }
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())

    expect(turns.map((turn) => turn.userText)).toEqual([
      '<command-name>/workflow-orchestrator</command-name><command-args>12345678</command-args>',
      '1A'
    ])
    expect(turns.flatMap((turn) => turn.items).map((event) => event.text)).not.toContain('No response requested.')
    expect(turns[0].items.find((event) => event.text === '请选择范围')?.ts).toBe('2026-07-14T02:38:15.000Z')
    expect(turns[1].items.find((event) => event.hookId === 'resume-hook')).toMatchObject({
      hookName: 'SessionStart:resume',
      ts: '2026-07-14T02:52:42.000Z'
    })
    expect(turns[1].items.find((event) => event.text === '继续执行')?.ts).toBe('2026-07-14T02:52:44.000Z')
  })

  it('历史 transcript 按 cache_creation 5m/1h 拆分并保留 token', () => {
    const content = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '算一下' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5',
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 30,
            cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 }
          },
          content: [{ type: 'text', text: 'done' }]
        }
      })
    ].join('\n')
    const result = parseTranscriptToTurns(content, ctx())[0].items.at(-1)
    expect(result).toMatchObject({
      kind: 'harness',
      stage: 'result',
      tokensIn: 100,
      tokensOut: 10,
      cacheReadTokens: 1000,
      cacheCreationTokens: 30,
      cacheCreation5mTokens: 20,
      cacheCreation1hTokens: 10
    })
    expect(result?.costUsd).toBeUndefined()
  })

  it('历史 transcript 保留 system hook 事件，包含首个 user 之前的 SessionStart', () => {
    const content = [
      JSON.stringify({
        type: 'system',
        subtype: 'hook_started',
        hook_id: 'hk-start',
        hook_name: 'SessionStart:resume',
        hook_event: 'SessionStart',
        session_id: 'sess-1'
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '继续跑' }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hk-bash',
        hook_name: 'PreToolUse:Bash',
        hook_event: 'PreToolUse',
        outcome: 'success',
        exit_code: 0,
        output: 'ok',
        session_id: 'sess-1'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] }
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())
    const hooks = turns[0].items.filter((e) => e.kind === 'hook')
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toMatchObject({
      stage: 'hook_started',
      hookName: 'SessionStart:resume',
      hookEvent: 'SessionStart',
      hookOutcome: 'started'
    })
    expect(hooks[1]).toMatchObject({
      stage: 'hook_response',
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      hookOutcome: 'success',
      hookExitCode: 0
    })
  })

  it('历史 transcript 中 outcome=cancelled 的 hook_response 不算脚本错误', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '继续跑' }
      }),
      JSON.stringify({
        type: 'system',
        subtype: 'hook_response',
        hook_id: 'hk-stop',
        hook_name: 'Stop',
        hook_event: 'Stop',
        outcome: 'cancelled',
        exit_code: 1,
        output: '',
        session_id: 'sess-1'
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())
    const hook = turns[0].items.find((e) => e.kind === 'hook')
    expect(hook).toMatchObject({
      hookName: 'Stop',
      hookOutcome: 'cancelled',
      hookExitCode: 1,
      isError: false
    })
  })

  it('历史 transcript 保留 Claude jsonl attachment 形式的 hook_success / hook_additional_context', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '继续跑' }
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          hookName: 'PreToolUse:Bash',
          hookEvent: 'PreToolUse',
          toolUseID: 'toolu_bash',
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
          command: '.claude/scripts/branch-check-hook.sh',
          durationMs: 123
        }
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          hookName: 'PreToolUse:Bash',
          hookEvent: 'PreToolUse',
          toolUseID: 'toolu_bash',
          content: ['branch ok']
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] }
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())
    const hooks = turns[0].items.filter((e) => e.kind === 'hook')
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toMatchObject({
      stage: 'hook_response',
      hookId: 'toolu_bash',
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      hookCommand: '.claude/scripts/branch-check-hook.sh',
      hookOutcome: 'success',
      hookExitCode: 0,
      durationMs: 123,
      text: 'ok'
    })
    expect(hooks[1]).toMatchObject({
      stage: 'hook_progress',
      hookId: 'toolu_bash',
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      hookOutcome: 'progress',
      text: 'branch ok'
    })
  })

  it('历史 transcript 保留 hook_cancelled / async_hook_response attachment', () => {
    const content = [
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'hook_cancelled',
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          toolUseID: 'hk-start',
          command: 'node audit-hook.mjs',
          durationMs: 5545,
          timedOut: true,
          timeoutMs: 5000
        }
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: '继续跑' }
      }),
      JSON.stringify({
        type: 'attachment',
        attachment: {
          type: 'async_hook_response',
          hookName: 'UserPromptSubmit',
          hookEvent: 'UserPromptSubmit',
          stdout: '',
          stderr: 'jq: command not found',
          exitCode: 1,
          response: {}
        }
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] }
      })
    ].join('\n')

    const turns = parseTranscriptToTurns(content, ctx())
    const hooks = turns[0].items.filter((e) => e.kind === 'hook')
    expect(hooks).toHaveLength(2)
    expect(hooks[0]).toMatchObject({
      stage: 'hook_response',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      hookCommand: 'node audit-hook.mjs',
      hookOutcome: 'cancelled',
      durationMs: 5545,
      input: expect.objectContaining({ timedOut: true, timeoutMs: 5000 }),
      isError: false
    })
    expect(hooks[1]).toMatchObject({
      stage: 'hook_response',
      hookName: 'UserPromptSubmit',
      hookEvent: 'UserPromptSubmit',
      hookOutcome: 'error',
      hookExitCode: 1,
      text: 'jq: command not found',
      isError: true
    })
  })
})

describe('normalizeSdkMessage stream_event（C1 token 流式）', () => {
  it('content_block_delta 的 text_delta → model/text_delta', () => {
    const evs = normalizeSdkMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } },
      ctx()
    )
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ kind: 'model', stage: 'text_delta', text: '你好' })
  })

  it('非 text_delta 的 stream_event（thinking_delta/工具入参/start）忽略', () => {
    const thinking = normalizeSdkMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } } },
      ctx()
    )
    const start = normalizeSdkMessage({ type: 'stream_event', event: { type: 'content_block_start' } }, ctx())
    expect(thinking).toEqual([])
    expect(start).toEqual([])
  })
})

describe("normalizeSdkMessage P3 审计标记", () => {
  it("危险 Bash tool_use 带 danger 标记", () => {
    const evs = normalizeSdkMessage(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "rm -rf build" } }] } },
      ctx()
    )
    expect(evs[0].danger).toEqual({ level: "danger", reason: "rm 递归强删" })
  })
  it("安全工具无 danger", () => {
    const evs = normalizeSdkMessage(
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/x.ts" } }] } },
      ctx()
    )
    expect(evs[0].danger).toBeUndefined()
  })
})

describe('maskSecrets（落库前脱敏，RFC §11）', () => {
  it('锚形状密钥被替换为占位符', () => {
    const fakeGithubPat = ['gh', 'p_', '0123456789abcdefghij0123456789abcdef'].join('')
    expect(maskSecrets('key=sk-ant-api03-abcdefGHIJKLmnop1234567890XYZ')).toBe('key=«REDACTED»')
    expect(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe('Authorization: «REDACTED»')
    expect(maskSecrets(`token ${fakeGithubPat}`)).toBe('token «REDACTED»')
  })
  it('正常文本不误伤（裸 sk-/risk- 等不匹配）', () => {
    expect(maskSecrets('修复 risk-control 模块的 sk- 前缀解析')).toBe('修复 risk-control 模块的 sk- 前缀解析')
    expect(maskSecrets('file_path=/a/b/c.ts')).toBe('file_path=/a/b/c.ts')
  })
  it('undefined / 空串原样返回', () => {
    expect(maskSecrets(undefined)).toBeUndefined()
    expect(maskSecrets('')).toBe('')
  })
})
