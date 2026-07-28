import { describe, it, expect } from 'vitest'
import {
  aggregateCalls,
  aggregateFiles,
  aggregateHooks,
  aggregateSegments,
  aggregateSegmentsRich,
  analyzeBilling,
  applyTraceBatch,
  bashFiles,
  buildSessionReport,
  fileWriteCoverage,
  hookCancellationDetail,
  hookCommandLabel,
  logicalCallEventsForTurn,
  parseUserMessage,
  resultOf,
  updateMcpLiveAfterToggle
} from './format'
import type { Turn } from './format'
import type { TraceEvent } from '@shared/trace'

describe('parseUserMessage', () => {
  it('抽出斜杠命令标签为干净命令，正文清空', () => {
    const text =
      '<command-message>workflow-orchestrator</command-message>\n<command-name>/workflow-orchestrator</command-name>\n<command-args>12345678</command-args>'
    expect(parseUserMessage(text)).toEqual({ command: '/workflow-orchestrator 12345678', body: '' })
  })

  it('无参命令：只有 command-name', () => {
    expect(parseUserMessage('<command-name>/clear</command-name><command-args></command-args>')).toEqual({
      command: '/clear',
      body: ''
    })
  })

  it('普通文本原样进 body、无 command', () => {
    expect(parseUserMessage('修复 foo.ts 的空指针')).toEqual({ command: undefined, body: '修复 foo.ts 的空指针' })
  })

  it('命令标签 + 残留正文：command 抽出，正文保留，无 injectedSkill', () => {
    const text = '<command-name>/x</command-name>\n# 标题\n正文内容'
    expect(parseUserMessage(text)).toEqual({ command: '/x', body: '# 标题\n正文内容', injectedSkill: undefined })
  })

  it('skill 注入：识别 "Base directory for this skill:" 取路径末段为 skill 名', () => {
    const text =
      'Base directory for this skill: /Users/x/IdeaProjects/sample-workspace/.claude/skills/workflow-orchestrator\n\n# workflow-orchestrator\n面向本仓库…'
    const r = parseUserMessage(text)
    expect(r.injectedSkill).toBe('workflow-orchestrator')
    expect(r.command).toBeUndefined()
    expect(r.body.startsWith('Base directory for this skill:')).toBe(true)
  })

  it('普通文本不误判为 skill 注入', () => {
    expect(parseUserMessage('帮我看下这个 skill 怎么写').injectedSkill).toBeUndefined()
  })
})

// 造一条最小 TraceEvent（只填 aggregateCalls 关心的字段）
const ev = (p: Partial<TraceEvent>): TraceEvent =>
  ({ id: 'x', ts: '', runId: 'r', kind: 'tool', stage: 'tool:X', ...p }) as TraceEvent

describe('aggregateCalls', () => {
  it('只数 tool_use、排除 tool_result（修正旧的 2× 膨胀计数）', () => {
    const items = [
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash' }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'a' }), // 工具结果，不算一次调用
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash' }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'b' }),
      ev({ kind: 'tool', stage: 'tool:Read', tool: 'Read' }),
      ev({ kind: 'model', stage: 'text', text: 'hi' }), // 非工具事件不算
      ev({ kind: 'harness', stage: 'result' })
    ]
    const r = aggregateCalls(items)
    expect(r.toolTotal).toBe(3) // 2 Bash + 1 Read，结果/文本/result 都排除
    expect(r.tools).toEqual([
      { name: 'Bash', count: 2 },
      { name: 'Read', count: 1 }
    ])
  })

  it('skill / 子agent / mcp 分类计数，mcp 按 server 分组并抽出 action', () => {
    const items = [
      ev({ kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' }),
      ev({ kind: 'agent', stage: 'agent:Explore', name: 'Explore' }),
      ev({ kind: 'tool', stage: 't', tool: 'mcp__tracker__query_issue', isMcp: true, mcpServer: 'tracker' }),
      ev({ kind: 'tool', stage: 't', tool: 'mcp__tracker__query_issue', isMcp: true, mcpServer: 'tracker' }),
      ev({ kind: 'tool', stage: 't', tool: 'mcp__tracker__search', isMcp: true, mcpServer: 'tracker' }),
      ev({ kind: 'tool', stage: 't', tool: 'mcp__oauth__find', isMcp: true, mcpServer: 'oauth' })
    ]
    const r = aggregateCalls(items)
    expect(r.skills).toEqual([{ name: 'workflow-orchestrator', count: 1 }])
    expect(r.agents).toEqual([{ name: 'Explore', count: 1 }])
    expect(r).toMatchObject({
      ordinaryToolTotal: 0,
      skillTotal: 1,
      agentTotal: 1,
      mcpTotal: 4,
      totalCalls: 6
    })
    expect(r.toolTotal).toBe(6) // 兼容旧调用方：全部逻辑调用
    // mcp 按 server total 降序：tracker(3) 在 oauth(1) 前
    expect(r.mcp.map((g) => g.server)).toEqual(['tracker', 'oauth'])
    const tracker = r.mcp.find((g) => g.server === 'tracker')!
    expect(tracker.total).toBe(3)
    expect(tracker.actions).toEqual([
      { action: 'query_issue', tool: 'mcp__tracker__query_issue', count: 2 },
      { action: 'search', tool: 'mcp__tracker__search', count: 1 }
    ])
    // mcp 调用不应混进普通 tools
    expect(r.tools).toEqual([])
  })

  it('action 抽取容忍 server 名带下划线（mcp__a_b_c__do_thing）', () => {
    const r = aggregateCalls([
      ev({ kind: 'tool', stage: 't', tool: 'mcp__claude_ai_X__animate_design', isMcp: true, mcpServer: 'claude_ai_X' })
    ])
    expect(r.mcp[0].actions[0].action).toBe('animate_design')
  })

  it('mcporter bridge 调用按 mcpAction 进入 MCP 分组', () => {
    const r = aggregateCalls([
      ev({
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        isMcp: true,
        mcpServer: 'tracker',
        mcpAction: 'query_issue_detail',
        mcpTool: 'mcporter:tracker.query_issue_detail'
      })
    ])
    expect(r.tools).toEqual([])
    expect(r.mcp).toEqual([
      {
        server: 'tracker',
        total: 1,
        actions: [{ action: 'query_issue_detail', tool: 'mcporter:tracker.query_issue_detail', count: 1 }]
      }
    ])
  })

  it('同一 toolUseId 映射出多个 fileChange 事件时只算一次调用', () => {
    const logical = logicalCallEventsForTurn([
      ev({ id: 'edit-a', kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'call-1', filePath: '/repo/a.ts' }),
      ev({ id: 'edit-b', kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'call-1', filePath: '/repo/b.ts' })
    ])

    expect(logical).toHaveLength(1)
    expect(aggregateCalls(logical)).toMatchObject({ ordinaryToolTotal: 1, totalCalls: 1 })
  })

  it('空输入返回全空、toolTotal=0', () => {
    const r = aggregateCalls([])
    expect(r).toEqual({
      tools: [],
      skills: [],
      agents: [],
      mcp: [],
      ordinaryToolTotal: 0,
      skillTotal: 0,
      agentTotal: 0,
      mcpTotal: 0,
      totalCalls: 0,
      toolTotal: 0
    })
  })
})

describe('aggregateHooks', () => {
  it('区分逻辑调用和原始 lifecycle events，并按触发点/脚本聚合', () => {
    const items = [
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tool-1' }),
      ev({ kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId: 'tool-1' }),
      ev({
        kind: 'hook',
        stage: 'hook_started',
        hookId: 'hk-1',
        hookEvent: 'PreToolUse',
        hookName: 'PreToolUse:Bash'
      }),
      ev({
        kind: 'hook',
        stage: 'hook_progress',
        hookId: 'hk-1',
        hookEvent: 'PreToolUse',
        hookName: 'PreToolUse:Bash'
      }),
      ev({
        kind: 'hook',
        stage: 'hook_response',
        hookId: 'hk-1',
        hookEvent: 'PreToolUse',
        hookName: 'PreToolUse:Bash',
        hookCommand: '.claude/scripts/branch-check-hook.sh',
        hookOutcome: 'success',
        hookExitCode: 0,
        durationMs: 241,
        input: { source: 'project', sourcePath: '/repo/.codex/hooks.json' }
      }),
      ev({
        kind: 'hook',
        stage: 'hook_response',
        hookId: 'hk-2',
        hookEvent: 'PreToolUse',
        hookName: 'PreToolUse:Bash',
        hookCommand: 'python3 .claude/hooks/trace_prompt.py',
        hookOutcome: 'error',
        hookExitCode: 1,
        input: { stderr: 'trace prompt denied', exitCode: 1 },
        isError: true
      }),
      ev({
        kind: 'hook',
        stage: 'hook_started',
        hookId: 'hk-3',
        hookEvent: 'SessionStart',
        hookName: 'SessionStart'
      })
    ]

    const r = aggregateHooks(items)
    expect(r.rawEvents).toBe(5)
    expect(r.logicalRuns).toBe(3) // 2 response + 1 started-only；progress 不额外算一条调用
    expect(r.groups[0]).toMatchObject({
      event: 'PreToolUse',
      trigger: 'PreToolUse:Bash',
      rawEvents: 4,
      logicalRuns: 2,
      responses: 2,
      errors: 1,
      toolCalls: 1,
      triggerRuns: 1
    })
    expect(r.groups[0].scripts.map((s) => s.label)).toEqual(['branch-check-hook.sh', 'trace_prompt.py'])
    expect(r.groups[0].scripts[0]).toMatchObject({
      rawEvents: 3,
      logicalRuns: 1,
      responses: 1,
      started: 1,
      progress: 1,
      exitCode: 0,
      instances: [
        expect.objectContaining({
          hookId: 'hk-1',
          source: 'project',
          sourcePath: '/repo/.codex/hooks.json',
          durationMs: 241,
          outcome: 'success'
        })
      ]
    })
    expect(r.groups[0].scripts[1]).toMatchObject({
      label: 'trace_prompt.py',
      errors: 1,
      failureSummary: 'exit 1: trace prompt denied'
    })
    expect(r.groups[0].scripts[1].unsuccessful.map((event) => event.hookId)).toEqual(['hk-2'])
    expect(r.groups[0].scripts[1].lastError?.hookId).toBe('hk-2')
    expect(r.groups[1]).toMatchObject({ event: 'SessionStart', logicalRuns: 1, pending: 1, triggerRuns: null })
  })

  it('全局桥接命令优先用 expected-marker 展示逻辑脚本短名', () => {
    const command =
      'python3 /Users/example/.local/share/rate-native-agent-hooks/global-hook-bridge.py --target codex --event UserPromptSubmit --expected-marker .claude/hooks/trace_prompt.py'

    expect(hookCommandLabel(command)).toBe('trace_prompt.py')
  })

  it('同一个 app-server hookId 在不同用户轮复用时按 run 分成两个处理器实例', () => {
    const items = ['run-1', 'run-2'].flatMap((runId) => [
      ev({
        id: `${runId}-start`,
        runId,
        kind: 'hook',
        stage: 'hook_started',
        hookId: 'user-prompt-submit:2:path',
        hookEvent: 'UserPromptSubmit',
        hookName: 'UserPromptSubmit:command',
        hookCommand: 'python3 .claude/hooks/trace_prompt.py'
      }),
      ev({
        id: `${runId}-response`,
        runId,
        kind: 'hook',
        stage: 'hook_response',
        hookId: 'user-prompt-submit:2:path',
        hookEvent: 'UserPromptSubmit',
        hookName: 'UserPromptSubmit:command',
        hookCommand: 'python3 .claude/hooks/trace_prompt.py',
        hookOutcome: 'success'
      })
    ])

    const summary = aggregateHooks(items)
    expect(summary).toMatchObject({ logicalRuns: 2, responses: 2, rawEvents: 4 })
    expect(summary.groups[0].scripts[0]).toMatchObject({ logicalRuns: 2, responses: 2, rawEvents: 4 })
    expect(summary.groups[0].scripts[0].instances).toHaveLength(2)
  })

  it('cancelled 单独计数，并只在有可靠证据时区分超时', () => {
    const command = 'python3 $CLAUDE_PROJECT_DIR/.claude/hooks/trace_pre.py'
    const configured = [{
      command,
      source: 'project' as const,
      sourcePath: '/repo/.claude/settings.json',
      timeoutSeconds: 5
    }]
    const inferred = ev({
      kind: 'hook',
      stage: 'hook_response',
      hookId: 'cancel-inferred',
      hookEvent: 'PreToolUse',
      hookName: 'PreToolUse:Read',
      hookCommand: command,
      hookConfiguredCommands: configured,
      hookOutcome: 'cancelled',
      durationMs: 5531,
      isError: false
    })
    const explicit = ev({
      kind: 'hook',
      stage: 'hook_response',
      hookId: 'cancel-explicit',
      hookEvent: 'Stop',
      hookName: 'Stop',
      hookCommand: 'stop.sh',
      hookOutcome: 'cancelled',
      durationMs: 5100,
      input: { timedOut: true, timeoutMs: 5000 },
      isError: false
    })
    const interrupted = ev({
      kind: 'hook',
      stage: 'hook_response',
      hookId: 'cancel-interrupted',
      hookEvent: 'Stop',
      hookName: 'Stop',
      hookCommand: 'stop.sh',
      hookOutcome: 'cancelled',
      durationMs: 200,
      input: { timedOut: false },
      isError: false
    })

    expect(aggregateHooks([inferred]).groups[0]).toMatchObject({ cancelled: 1, errors: 0 })
    expect(aggregateHooks([inferred]).groups[0].scripts[0]).toMatchObject({ cancelled: 1, errors: 0 })
    expect(aggregateHooks([inferred]).groups[0].scripts[0].unsuccessful).toEqual([inferred])
    expect(hookCancellationDetail(inferred)).toEqual({
      kind: 'suspected-timeout',
      durationMs: 5531,
      timeoutMs: 5000,
      timeoutSource: 'current-config'
    })
    expect(hookCancellationDetail(explicit)).toEqual({
      kind: 'timeout',
      durationMs: 5100,
      timeoutMs: 5000,
      timeoutSource: 'upstream'
    })
    expect(hookCancellationDetail(interrupted)).toEqual({ kind: 'cancelled', durationMs: 200 })
  })

  it('按唯一 toolUseId 统计触发工具，并按 hookId 区分完成与 pending', () => {
    const items: TraceEvent[] = []
    for (let i = 0; i < 6; i++) {
      items.push(ev({ id: `edit-${i}`, kind: 'tool', stage: 'tool:Edit', tool: 'Edit', toolUseId: `edit-${i}` }))
      items.push(ev({ id: `edit-result-${i}`, kind: 'tool', stage: 'tool_result', tool: 'Edit', toolUseId: `edit-${i}` }))
    }
    for (let i = 0; i < 37; i++) {
      items.push(ev({ id: `start-${i}`, kind: 'hook', stage: 'hook_started', hookId: `hook-${i}`, hookEvent: 'PreToolUse', hookName: 'PreToolUse:Edit' }))
      if (i < 36) {
        items.push(ev({ id: `response-${i}`, kind: 'hook', stage: 'hook_response', hookId: `hook-${i}`, hookEvent: 'PreToolUse', hookName: 'PreToolUse:Edit' }))
      }
    }

    const group = aggregateHooks(items).groups[0]

    expect(group).toMatchObject({ toolCalls: 6, logicalRuns: 37, responses: 36, pending: 1 })
  })
})

describe('aggregateSegments（P1 按 skill 切段）', () => {
  const ev = (p: Partial<TraceEvent>): TraceEvent =>
    ({ id: 'x', ts: '', runId: 'r', kind: 'tool', stage: 'tool:X', ...p }) as TraceEvent

  it('skill 调用切段，工具/子 agent/读写/错误归到当前段', () => {
    const items = [
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash' }), // 无 skill 段
      ev({ kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' }),
      ev({ kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read' }),
      ev({ kind: 'agent', stage: 'agent:general-purpose', name: 'general-purpose' }),
      ev({ kind: 'tool', stage: 'tool:Write', tool: 'Write', fileOp: 'write' }),
      ev({ kind: 'tool', stage: 'tool_result', isError: true }) // 错误算进 workflow-orchestrator 段
    ]
    const segs = aggregateSegments(items)
    expect(segs).toEqual([
      { skill: '（无 skill）', tools: 1, agents: 0, reads: 0, writes: 0, errors: 0 },
      { skill: 'workflow-orchestrator', tools: 2, agents: 1, reads: 1, writes: 1, errors: 1 }
    ])
  })

  it('具名 skill 段即使 0 工具也保留；无 skill 空段不保留', () => {
    const segs = aggregateSegments([ev({ kind: 'skill', stage: 'skill:foo', name: 'foo' })])
    expect(segs).toEqual([{ skill: 'foo', tools: 0, agents: 0, reads: 0, writes: 0, errors: 0 }])
  })

  it('纯工具无 skill：单个无 skill 段', () => {
    const segs = aggregateSegments([ev({ kind: 'tool', tool: 'Bash' })])
    expect(segs).toEqual([{ skill: '（无 skill）', tools: 1, agents: 0, reads: 0, writes: 0, errors: 0 }])
  })

  it('纯子 agent 无 skill：不混入普通工具数', () => {
    const segs = aggregateSegments([ev({ kind: 'agent', stage: 'agent:general-purpose', name: 'general-purpose' })])
    expect(segs).toEqual([{ skill: '（无 skill）', tools: 0, agents: 1, reads: 0, writes: 0, errors: 0 }])
  })

  it('与调用明细共用 Skill 去重：注入与内部文件证据只切一个段，嵌套 Skill 保留', () => {
    const items = [
      ev({ id: 'root-injection', kind: 'skill', stage: 'skill:root', name: 'root', input: { source: 'skill_injection' } }),
      ev({
        id: 'root-file',
        kind: 'skill',
        stage: 'skill:root',
        name: 'root',
        input: { source: 'skill_file', path: '/repo/.claude/skills/root/phases/00.md' }
      }),
      ev({ id: 'nested', kind: 'skill', stage: 'skill:nested', name: 'nested', toolUseId: 'nested-call' })
    ]
    const logical = logicalCallEventsForTurn(items)
    expect(logical.filter((event) => event.kind === 'skill').map((event) => event.name)).toEqual(['root', 'nested'])
    expect(aggregateSegments(logical).map((segment) => segment.skill)).toEqual(['root', 'nested'])
  })
})

describe('fileWriteCoverage（P2 写覆盖 / 只写不读）', () => {
  it('按真实事件顺序区分先读后改与先写后读，并排除 tool_result', () => {
    const items = [
      ev({ id: 'read-a', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-a', fileOp: 'read', filePath: '/a.ts' }),
      ev({ id: 'read-a-result', stage: 'tool_result', tool: 'Read', toolUseId: 'read-a' }),
      ev({ id: 'edit-a', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'edit-a', fileOp: 'edit', filePath: '/a.ts' }),
      ev({ id: 'edit-a-result', stage: 'tool_result', tool: 'Edit', toolUseId: 'edit-a' }),
      ev({ id: 'write-b', stage: 'tool:Write', tool: 'Write', toolUseId: 'write-b', fileOp: 'write', filePath: '/b.ts' }),
      ev({ id: 'write-b-result', stage: 'tool_result', tool: 'Write', toolUseId: 'write-b', fileOp: 'write', filePath: '/b.ts' }),
      ev({ id: 'read-b', stage: 'file:read', tool: 'FileOp', fileOp: 'read', filePath: '/b.ts' }),
      ev({ id: 'read-c', stage: 'file:read', tool: 'FileOp', fileOp: 'read', filePath: '/c.ts' })
    ]
    expect(fileWriteCoverage(items)).toEqual({ written: 2, readBefore: 1, blind: ['/b.ts'] })
  })

  it('以结果完成顺序判定先读，并排除失败的 Read/Write', () => {
    const items = [
      ev({ id: 'read-use', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', fileOp: 'read', filePath: '/a.ts' }),
      ev({ id: 'edit-use', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'edit', fileOp: 'edit', filePath: '/a.ts' }),
      ev({ id: 'read-result', stage: 'tool_result', toolUseId: 'read', isError: true }),
      ev({ id: 'edit-result', stage: 'tool_result', toolUseId: 'edit', isError: false }),
      ev({ id: 'failed-write-use', stage: 'tool:Write', tool: 'Write', toolUseId: 'failed-write', fileOp: 'write', filePath: '/b.ts' }),
      ev({ id: 'failed-write-result', stage: 'tool_result', toolUseId: 'failed-write', isError: true })
    ]
    expect(fileWriteCoverage(items)).toEqual({ written: 1, readBefore: 0, blind: ['/a.ts'] })
  })

  it('并行 Read/Edit 只在 Read 先完成时算先读', () => {
    const uses = [
      ev({ id: 'read-use', stage: 'tool:Read', tool: 'Read', toolUseId: 'read', fileOp: 'read', filePath: '/a.ts' }),
      ev({ id: 'edit-use', stage: 'tool:Edit', tool: 'Edit', toolUseId: 'edit', fileOp: 'edit', filePath: '/a.ts' })
    ]
    const editFirst = [...uses, ev({ id: 'edit-result', stage: 'tool_result', toolUseId: 'edit' }), ev({ id: 'read-result', stage: 'tool_result', toolUseId: 'read' })]
    const readFirst = [...uses, ev({ id: 'read-result', stage: 'tool_result', toolUseId: 'read' }), ev({ id: 'edit-result', stage: 'tool_result', toolUseId: 'edit' })]
    expect(fileWriteCoverage(editFirst)).toEqual({ written: 1, readBefore: 0, blind: ['/a.ts'] })
    expect(fileWriteCoverage(readFirst)).toEqual({ written: 1, readBefore: 1, blind: [] })
  })

  it('全是只读：written=0', () => {
    expect(fileWriteCoverage([ev({ stage: 'file:read', tool: 'FileOp', fileOp: 'read', filePath: '/x' })])).toEqual({
      written: 0,
      readBefore: 0,
      blind: []
    })
  })
})

describe('aggregateFiles（结构化文件工具足迹）', () => {
  it('tool_result 继承 fileOp 时不重复统计', () => {
    const { structured } = aggregateFiles([
      ev({ id: 'read', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' }),
      ev({ id: 'read-result', stage: 'tool_result', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' })
    ])
    expect(structured).toEqual([{ path: '/a.ts', read: 1, write: 0, edit: 0 }])
  })
})

describe('bashFiles（Bash 文件推断）', () => {
  it('排除 /dev/* 重定向目标（修 basename 显示成 "null" 的 bug）', () => {
    const fs = bashFiles('pwd && ls tracked.txt 2>/dev/null; cat a.log >/dev/null')
    expect(fs).toContain('tracked.txt')
    expect(fs).toContain('a.log')
    expect(fs).not.toContain('/dev/null')
    expect(fs.some((f) => f.endsWith('null'))).toBe(false)
  })
  it('推断带扩展名 / 带路径的 token，跳过 flag 和无扩展名 url', () => {
    const fs = bashFiles('grep -n foo src/x.ts http://y.com/page')
    expect(fs).toContain('src/x.ts')
    expect(fs).not.toContain('-n')
    expect(fs.some((f) => f.startsWith('http'))).toBe(false)
  })
})

describe('updateMcpLiveAfterToggle（MCP 配置态不伪装真实连通）', () => {
  it('启用后标 pending，而不是 connected', () => {
    expect(updateMcpLiveAfterToggle([{ name: 'github', status: 'disabled' }], 'github', true)).toEqual([
      { name: 'github', status: 'pending' }
    ])
  })

  it('禁用后标 disabled；无 live 缓存时补一条状态', () => {
    expect(updateMcpLiveAfterToggle([], 'github', false)).toEqual([{ name: 'github', status: 'disabled' }])
  })
})

describe('analyzeBilling（Billing Guardian token 用量解释）', () => {
  it('区分 SDK usage token、top token turn、model token coverage 和内部 workflow 线索', () => {
    const items: TraceEvent[] = [
      ev({ kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' }),
      ev({ kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/p/a.ts' }),
      ev({ kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/p/b.ts' }),
      ev({ kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/p/c.ts' }),
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'b', danger: { level: 'danger', reason: 'rm 递归强删' } }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'b', isError: true }),
      ev({
        kind: 'harness',
        stage: 'result',
        costUsd: 0.5,
        costSource: 'sdk_estimate',
        costConfidence: 'estimated',
        costUnit: 'usd',
        tokensIn: 100000,
        tokensOut: 200,
        cacheReadTokens: 300,
        contextTokens: 900000,
        modelUsage: [
          {
            model: 'claude-opus-4-8[1m]',
            inputTokens: 100000,
            outputTokens: 200,
            cacheReadTokens: 300,
            costUsd: 0.5,
            costSource: 'sdk_estimate',
            costConfidence: 'estimated',
            costUnit: 'usd',
            contextWindow: 1000000
          }
        ]
      })
    ]
    const turns = [{ runId: 'r', userText: '/workflow-orchestrator 12345678', items, done: true }]
    const b = analyzeBilling(turns)
    expect(b.sourceLabel).toBe('本会话可验证 token')
    expect(b.officialBillLabel).toBe('仅看 token，不算金额')
    expect(b.topTokenTurns[0]).toMatchObject({ turnNo: 1, tokensTotal: 100500, label: '/workflow-orchestrator 12345678' })
    expect(b.models[0]).toMatchObject({ model: 'claude-opus-4-8[1m]', totalTokens: 100500, tokensIn: 100000, tokensOut: 200 })
    expect(b.tokenCoveragePct).toBe(100)
    expect(b.modelTokenCoveragePct).toBe(100)
    expect(b.workflowDirectCoveragePct).toBe(0)
    expect(b.workflowUnattributedPct).toBe(100)
    expect(b.evidence.find((e) => e.kind === 'skill' && e.name === 'workflow-orchestrator')).toMatchObject({
      relatedTokens: 100500,
      attributionMethod: 'turn_allocated'
    })
    expect(b.signals.map((s) => s.title)).toContain('上下文 90%')
    expect(b.signals.some((s) => s.title.includes('高 Token 轮次'))).toBe(true)
    expect(b.signals.some((s) => s.title.includes('突增'))).toBe(false)
  })

  it('Codex input 已含 cached input，总 Token 不重复加 cache', () => {
    const b = analyzeBilling([
      {
        runId: 'codex',
        userText: 'codex',
        done: true,
        items: [
          ev({
            id: 'codex-result',
            kind: 'harness',
            stage: 'result',
            providerId: 'codex',
            runtimeProvider: 'codex_cli',
            tokensIn: 100,
            tokensOut: 20,
            cacheReadTokens: 80,
            modelUsage: [{
              model: 'gpt-5',
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 80,
              billingProvider: 'codex'
            }]
          })
        ]
      }
    ])

    expect(b.totalTokens).toBe(120)
    expect(b.allTurnRows[0].tokensTotal).toBe(120)
    expect(b.models[0].totalTokens).toBe(120)
  })

  it('有其他轮次作基线时才把相对异常称为 Token 突增', () => {
    const turns: Turn[] = [
      { runId: 'baseline', userText: 'baseline', done: true, items: [ev({ kind: 'harness', stage: 'result', tokensIn: 3_000, tokensOut: 2_000 })] },
      { runId: 'spike', userText: 'spike', done: true, items: [ev({ kind: 'harness', stage: 'result', tokensIn: 8_000, tokensOut: 3_000 })] }
    ]
    expect(analyzeBilling(turns).signals.some((signal) => signal.title.includes('Token 突增'))).toBe(true)
  })

  it('首轮不能使用未来低用量轮次反向制造 Token 突增基线', () => {
    const turns: Turn[] = [
      {
        runId: 'first-high',
        userText: 'first',
        done: true,
        items: [ev({ runId: 'first-high', kind: 'harness', stage: 'result', tokensIn: 150_000, tokensOut: 50_000 })]
      },
      {
        runId: 'later-low',
        userText: 'later',
        done: true,
        items: [ev({ runId: 'later-low', kind: 'harness', stage: 'result', tokensIn: 8_000, tokensOut: 2_000 })]
      }
    ]
    const firstSignal = analyzeBilling(turns).signals.find((signal) => signal.evidence?.runId === 'first-high')
    expect(firstSignal?.title).toContain('高 Token 轮次')
    expect(firstSignal?.title).not.toContain('突增')
  })

  it('后续真实相对突增优先于更早但只有绝对高用量的轮次', () => {
    const turns: Turn[] = [
      {
        runId: 'first-high',
        userText: 'first',
        done: true,
        items: [ev({ runId: 'first-high', kind: 'harness', stage: 'result', tokensIn: 250_000, tokensOut: 50_000 })]
      },
      ...Array.from({ length: 30 }, (_, index): Turn => ({
        runId: `low-${index}`,
        userText: 'low',
        done: true,
        items: [ev({ runId: `low-${index}`, kind: 'harness', stage: 'result', tokensIn: 800, tokensOut: 200 })]
      })),
      {
        runId: 'later-spike',
        userText: 'later spike',
        done: true,
        items: [ev({ runId: 'later-spike', kind: 'harness', stage: 'result', tokensIn: 40_000, tokensOut: 10_000 })]
      }
    ]
    const tokenSignal = analyzeBilling(turns).signals.find((signal) => signal.title.includes('Token'))
    expect(tokenSignal?.title).toContain('Token 突增')
    expect(tokenSignal?.evidence?.runId).toBe('later-spike')
  })

  it('同名工具达到频次阈值只提示高频，不断言已经形成循环', () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      ev({ id: `bash-${index}`, kind: 'tool', stage: 'tool:Bash', tool: 'Bash' })
    )
    items.push(ev({ id: 'result', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 2 }))
    const signals = analyzeBilling([{ runId: 'high-frequency', userText: 'x', items, done: true }]).signals
    const signal = signals.find((candidate) => candidate.title.includes('高频工具调用 Bash 8×'))
    expect(signal?.detail).toContain('不等同于循环')
    expect(signals.some((candidate) => candidate.title.includes('疑似工具循环'))).toBe(false)
  })

  it('区分 costUsd=0 和缺失 costUsd，但 token 覆盖按 usage 判断', () => {
    const turns: Turn[] = [
      {
        runId: 'zero',
        userText: 'zero cost',
        done: true,
        items: [ev({ id: 'zero-result', kind: 'harness', stage: 'result', costUsd: 0, tokensIn: 10, tokensOut: 2 })]
      },
      {
        runId: 'missing',
        userText: 'missing cost',
        done: true,
        items: [ev({ id: 'missing-result', kind: 'harness', stage: 'result', tokensIn: 20, tokensOut: 3 })]
      }
    ]
    const b = analyzeBilling(turns)
    expect(b.totalTokens).toBe(35)
    expect(b.knownTokenResultCount).toBe(2)
    expect(b.missingTokenResultCount).toBe(0)
    expect(b.tokenCoveragePct).toBe(100)
    expect(b.topTokenTurns[0]).toMatchObject({ runId: 'missing', tokensTotal: 23 })
  })

  it('按用户 turn 统计 result，并用归档 result 覆盖同轮 transcript assistant usage', () => {
    const turns: Turn[] = [
      {
        runId: 'archived',
        userText: 'archived turn',
        done: true,
        items: [
          ev({
            id: 'archive-result',
            runId: 'archived',
            kind: 'harness',
            stage: 'result',
            text: 'final answer',
            tokensIn: 10,
            tokensOut: 5,
            cacheReadTokens: 20,
            costUsd: 0.1,
            runtimeProvider: 'claude_sdk'
          }),
          ev({
            id: 'transcript-usage-1',
            runId: 'session',
            kind: 'harness',
            stage: 'result',
            text: 'transcript assistant usage',
            tokensIn: 3,
            tokensOut: 2,
            cacheCreationTokens: 7
          }),
          ev({
            id: 'transcript-usage-2',
            runId: 'session',
            kind: 'harness',
            stage: 'result',
            text: 'transcript assistant usage',
            tokensIn: 1,
            tokensOut: 1,
            cacheReadTokens: 9
          })
        ]
      },
      {
        runId: 'transcript-only',
        userText: 'old transcript turn',
        done: true,
        items: [
          ev({
            id: 'old-usage-1',
            runId: 'session',
            kind: 'harness',
            stage: 'result',
            text: 'transcript assistant usage',
            tokensIn: 2,
            tokensOut: 3,
            cacheReadTokens: 4
          }),
          ev({
            id: 'old-usage-2',
            runId: 'session',
            kind: 'harness',
            stage: 'result',
            text: 'transcript assistant usage',
            tokensIn: 1,
            tokensOut: 1
          })
        ]
      }
    ]

    const b = analyzeBilling(turns)

    expect(b.resultTurns).toBe(2)
    expect(b.knownTokenResultCount).toBe(2)
    expect(b.totalTokens).toBe(46)
    expect(b.allTurnRows.map((row) => row.tokensTotal)).toEqual([35, 11])
  })

  it('多条未知 usage result 保持 unknown，不聚合成假 0', () => {
    const result = resultOf({
      runId: 'unknown', userText: 'unknown', done: true,
      items: [
        ev({ id: 'r1', kind: 'harness', stage: 'result' }),
        ev({ id: 'r2', kind: 'harness', stage: 'result' })
      ]
    })

    expect(result).toMatchObject({ tokensIn: undefined, tokensOut: undefined, cacheReadTokens: undefined })
  })

  it('高 Token 轮次保留最高 10 条，并按 token 从高到低排序', () => {
    const turns: Turn[] = Array.from({ length: 12 }, (_, i) => ({
      runId: `turn-${i + 1}`,
      userText: `prompt ${i + 1}`,
      done: true,
      items: [ev({ id: `result-${i + 1}`, kind: 'harness', stage: 'result', tokensIn: (i + 1) * 1000, tokensOut: 0 })]
    }))
    const b = analyzeBilling(turns)
    expect(b.topTokenTurns).toHaveLength(10)
    expect(b.topTokenTurns.map((t) => t.runId)).toEqual([
      'turn-12',
      'turn-11',
      'turn-10',
      'turn-9',
      'turn-8',
      'turn-7',
      'turn-6',
      'turn-5',
      'turn-4',
      'turn-3'
    ])
  })

  it('subagent runaway 在 token 口径下不显示 $0.0000', () => {
    const items: TraceEvent[] = [
      ev({ id: 'agent', kind: 'agent', stage: 'agent:Explore', name: 'Explore', tool: 'Task' }),
      ...Array.from({ length: 19 }, (_, i) => ev({ id: `tool-${i}`, kind: 'tool', stage: 'tool:Read', tool: 'Read' })),
      ev({ id: 'result-missing-cost', kind: 'harness', stage: 'result', tokensIn: 1000, tokensOut: 200 })
    ]
    const b = analyzeBilling([{ runId: 'subagent', userText: 'run subagent', items, done: true }])
    const signal = b.signals.find((s) => s.title.startsWith('子 agent 消耗'))
    expect(signal?.detail).toContain('1.2k tok')
    expect(signal?.detail).not.toContain('$0.0000')
  })

  it('模型用量按 token 展示，不把未知成本显示成 $0.0000', () => {
    const items: TraceEvent[] = [
      ev({
        id: 'result-unknown-model',
        kind: 'harness',
        stage: 'result',
        tokensIn: 100,
        tokensOut: 20,
        modelUsage: [{ model: 'unknown-local-model', inputTokens: 100, outputTokens: 20 }]
      })
    ]
    const b = analyzeBilling([{ runId: 'r', userText: 'x', items, done: true }])
    expect(b.models[0]).toMatchObject({ model: 'unknown-local-model', totalTokens: 120, costKnown: false })
    const md = buildSessionReport([{ runId: 'r', userText: 'x', items, done: true }])
    expect(md).toContain('unknown-local-model 120 tok')
    expect(md).not.toContain('unknown-local-model $0.0000')
  })
})

describe('buildSessionReport（Session Token 用量报告）', () => {
  it('汇总 token 口径 + 盲改/失败提示，无活动则最小输出', () => {
    const items: TraceEvent[] = [
      ev({ kind: 'tool', stage: 'tool:Write', tool: 'Write', fileOp: 'write', filePath: '/p/blind.txt' }),
      ev({ kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' }),
      ev({ kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'b', danger: { level: 'danger', reason: 'rm 递归强删' } }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'b', isError: true }),
      ev({
        kind: 'harness',
        stage: 'result',
        costUsd: 0.5,
        costSource: 'sdk_estimate',
        costConfidence: 'estimated',
        costUnit: 'usd',
        tokensIn: 1000,
        tokensOut: 200,
        modelUsage: [{ model: 'claude-opus-4-8[1m]', costUsd: 0.5, costSource: 'sdk_estimate', costConfidence: 'estimated' }]
      })
    ]
    const turns = [{ runId: 'r', userText: 'x', items, done: true }]
    const md = buildSessionReport(turns, [], { sessionId: 'sess-1' })
    expect(md).toContain('# Session Token 用量报告')
    expect(md).toContain('sess-1')
    expect(md).toContain('本会话可验证 token')
    expect(md).toContain('仅看 token，不算金额')
    expect(md).toContain('1.2k tok')
    expect(md).toContain('数据完整性')
    expect(md).toContain('工具拆分：暂无独立 token 字段')
    expect(md).not.toContain('归因覆盖')
    expect(md).not.toContain('未精确归因')
    expect(md).toContain('不把整轮 token 分摊给具体工具')
    expect(md).not.toContain('Token 关联线索（不可相加）')
    expect(md).not.toContain('不是该工具/Skill/Hook 自身用量')
    expect(md).not.toContain('工具 Bash：出现 1 次 · 所在轮次 token 1.2k tok · 同轮关联')
    expect(md).not.toContain('归因方法=按轮次关联(turn_allocated)')
    expect(md).toContain('[高危] rm 递归强删') // 危险审计（视觉升级后报告文本用 [高危]/[可疑]）
    expect(md).toContain('首次写入前未读') // 首写前未读提示（blind.txt write-only）
    expect(md).toContain('工具失败 1 次')
    expect(md).not.toContain('$0.5000')
  })

  it('报告默认脱敏 userText / evidence name，且不包含工具完整 output', () => {
    const secret = `sk-ant-${'abcdefghijklmnopqrstuvwxyz'}`
    const items: TraceEvent[] = [
      ev({ kind: 'agent', stage: 'agent:review', name: `review ${secret}`, tool: 'Task', toolUseId: 'agent-1' }),
      ev({ kind: 'tool', stage: 'tool_result', toolUseId: 'agent-1', output: `tool output ${secret}` }),
      ev({ kind: 'harness', stage: 'result', costUsd: 0.1, tokensIn: 100, tokensOut: 20 })
    ]
    const md = buildSessionReport([{ runId: 'r', userText: `please inspect ${secret}`, items, done: true }])
    expect(md).toContain('«REDACTED»')
    expect(md).not.toContain(secret)
    expect(md).not.toContain('tool output')
  })

  it('空会话只出标题行', () => {
    expect(buildSessionReport([])).toContain('# Session Token 用量报告')
    expect(buildSessionReport([])).toContain('等待 result')
    expect(buildSessionReport([])).not.toContain('$0.0000')
  })
})

describe('applyTraceBatch（性能：批量合并，语义不变）', () => {
  const e = (p: Partial<TraceEvent> & { id: string }): TraceEvent =>
    ({ ts: '', runId: 'r1', kind: 'tool', stage: 'tool:X', ...p }) as TraceEvent

  it('一批事件 FIFO 保序追加，新 run 自动建 turn', () => {
    const out = applyTraceBatch([], [e({ id: 'a' }), e({ id: 'b' }), e({ id: 'c' })], new Set())
    expect(out).toHaveLength(1)
    expect(out[0].items.map((x) => x.id)).toEqual(['a', 'b', 'c']) // 顺序不乱
  })

  it('连续 text_delta 合并进上一条（和逐事件版一致）', () => {
    const out = applyTraceBatch(
      [],
      [
        e({ id: 't1', kind: 'model', stage: 'text_delta', text: '你' }),
        e({ id: 't2', kind: 'model', stage: 'text_delta', text: '好' }),
        e({ id: 'k', kind: 'tool', stage: 'tool:Bash' })
      ],
      new Set()
    )
    expect(out[0].items).toHaveLength(2) // 两个 delta 合一 + 工具
    expect(out[0].items[0].text).toBe('你好')
  })

  it('按 id 去重，不丢不重', () => {
    const prev: Turn[] = [{ runId: 'r1', userText: '', items: [e({ id: 'a' })], done: false }]
    const out = applyTraceBatch(prev, [e({ id: 'a' }), e({ id: 'b' })], new Set())
    expect(out[0].items.map((x) => x.id)).toEqual(['a', 'b']) // a 不重复
  })

  it('clearedRuns 里的 run 事件被丢弃；空批/无变化返回原引用', () => {
    const prev: Turn[] = [{ runId: 'r1', userText: '', items: [], done: false }]
    expect(applyTraceBatch(prev, [e({ id: 'x', runId: 'gone' })], new Set(['gone']))).toBe(prev)
    expect(applyTraceBatch(prev, [], new Set())).toBe(prev)
  })
})

describe('aggregateSegmentsRich：按 turn 切活跃段 + cost/api 归集（segments.html 数据源）', () => {
  const ev = (p: Partial<TraceEvent> & { id: string }): TraceEvent =>
    ({ ts: '', runId: 'r', kind: 'tool', stage: 'tool:X', ...p }) as TraceEvent
  const turn = (runId: string, items: TraceEvent[]): Turn => ({ runId, userText: '', items, done: true })
  const result = (cost: number, api: number): TraceEvent =>
    ev({ id: `res-${cost}-${api}`, kind: 'harness', stage: 'result', costUsd: cost, durationApiMs: api })

  const turns: Turn[] = [
    // turn1 baseline：Read + Bash
    turn('t1', [
      ev({ id: 'a1', tool: 'Read', fileOp: 'read', filePath: '/x/a.ts' }),
      ev({ id: 'a2', tool: 'Bash' }),
      result(0.05, 8400)
    ]),
    // turn2 skill git-commit 注入
    turn('t2', [
      ev({ id: 'b0', kind: 'skill', stage: 'skill:git-commit', name: 'git-commit' }),
      ev({ id: 'b1', tool: 'Bash' }),
      ev({ id: 'b2', tool: 'Write', fileOp: 'write', filePath: '/x/msg.txt' }),
      result(0.12, 14800)
    ]),
    // turn3 无新 skill → carry-forward 仍 git-commit（应与 turn2 合段）
    turn('t3', [ev({ id: 'c1', tool: 'Bash' }), result(0.02, 3000)]),
    // turn4 subagent
    turn('t4', [
      ev({ id: 'd0', kind: 'agent', stage: 'agent:gp', name: 'general-purpose', tool: 'Agent' }),
      result(0.05, 6400)
    ])
  ]
  const rep = aggregateSegmentsRich(turns)

  it('切成 3 段：baseline / skill(git-commit 跨 turn 合并) / subagent', () => {
    expect(rep.segments.map((s) => s.kind)).toEqual(['baseline', 'skill', 'subagent'])
    expect(rep.segments[1].name).toBe('git-commit')
    expect(rep.segments[1].turnStart).toBe(2)
    expect(rep.segments[1].turnEnd).toBe(3) // turn2+turn3 合并
  })

  it('per-segment cost = 段内 turn result.costUsd 之和（真实归集）', () => {
    expect(rep.segments[0].cost).toBeCloseTo(0.05)
    expect(rep.segments[1].cost).toBeCloseTo(0.14) // 0.12 + 0.02
    expect(rep.totalCost).toBeCloseTo(0.24)
  })

  it('% = 段 api / 总 api；cost vs base 增幅', () => {
    expect(rep.totalApiMs).toBe(32600)
    expect(rep.segments[1].pct).toBeCloseTo((17800 / 32600) * 100, 1)
    expect(rep.segments[1].costDeltaVsBase).toBe(180) // round(0.14/0.05-1)*100
  })

  it('skillSwitches / subagents 计数', () => {
    expect(rep.skillSwitches).toBe(1)
    expect(rep.subagents).toBe(1)
  })
})
