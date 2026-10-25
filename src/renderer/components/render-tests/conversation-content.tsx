import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, AssistantTurn, UserMessage, ev, renderWelcome } = shared
type TraceEvent = shared.TraceEvent
type AgentQuestionRequest = shared.AgentQuestionRequest
type Turn = shared.Turn

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  it('未收口的尾部流式文本单独渲染并标 streaming，终态后不再标 streaming', () => {
    const items = [
      ev({ id: 'tool-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'npm test' } }),
      ev({ id: 'delta-1', kind: 'model', stage: 'text_delta', text: '正在' }),
      ev({ id: 'delta-2', kind: 'model', stage: 'text_delta', text: '收敛结论' })
    ]
    const live = renderToStaticMarkup(
      <AssistantTurn turn={{ runId: 'run-live-tail', userText: '继续', done: false, items }} selectedId={null} onSelect={() => {}} />
    )
    expect(live).toContain('class="model-text md streaming"')
    expect(live).toContain('正在收敛结论')
    expect(live.indexOf('npm test')).toBeLessThan(live.indexOf('正在收敛结论'))

    const finished = renderToStaticMarkup(
      <AssistantTurn turn={{ runId: 'run-live-tail', userText: '继续', done: true, items }} selectedId={null} onSelect={() => {}} />
    )
    expect(finished).not.toContain('class="model-text md streaming"')
    expect(finished).toContain('正在收敛结论')
  })
it('兼容合并旧 Codex text 增量，避免每个 token 各占一行', () => {
    const codexTurn: Turn = {
      runId: 'run-codex-legacy-stream',
      userText: '/rate-workflow 84441907',
      done: false,
      items: [
        ev({ id: 'codex-1', kind: 'model', stage: 'text', text: '我', providerId: 'codex', runtimeProvider: 'codex_cli' }),
        ev({ id: 'codex-2', kind: 'model', stage: 'text', text: '将按 `rate', providerId: 'codex', runtimeProvider: 'codex_cli' }),
        ev({ id: 'codex-3', kind: 'model', stage: 'text', text: '-workflow` 执行。', providerId: 'codex', runtimeProvider: 'codex_cli' })
      ]
    }

    const html = renderToStaticMarkup(<AssistantTurn turn={codexTurn} selectedId={null} onSelect={() => {}} />)

    expect(html.match(/class="model-text md/g)).toHaveLength(1)
    expect(html).toContain('我将按 <code>rate-workflow</code> 执行。')
  })
it('Provider 给出孤儿 parent id 时仍展示根 agent 的后续文本和工具', () => {
    const orphanedTurn: Turn = {
      runId: 'run-orphan-parent',
      userText: '继续',
      done: true,
      items: [
        ev({
          id: 'root-delta',
          kind: 'model',
          stage: 'text_delta',
          text: '根 agent 已恢复',
          agentId: 'thread-root',
          parentToolUseId: 'missing-parent'
        }),
        ev({
          id: 'root-command',
          kind: 'tool',
          stage: 'tool:Bash',
          tool: 'Bash',
          toolUseId: 'root-command',
          input: { command: 'pwd' },
          agentId: 'thread-root',
          parentToolUseId: 'missing-parent'
        })
      ]
    }

    const html = renderToStaticMarkup(<AssistantTurn turn={orphanedTurn} selectedId={null} onSelect={() => {}} />)

    expect(html).toContain('根 agent 已恢复')
    expect(html).toContain('pwd')
  })
it('子 agent 的 text_delta 在 Task 内合并展示', () => {
    const pendingQuestion: AgentQuestionRequest = {
      runId: 'run-child-stream',
      questionId: 'child-question',
      questions: [{
        question: '继续吗？',
        header: '确认',
        multiSelect: false,
        options: [{ label: '继续', description: '继续执行' }]
      }]
    }
    const childTurn: Turn = {
      runId: 'run-child-stream',
      userText: '委派',
      done: false,
      items: [
        ev({
          id: 'child-task',
          runId: 'run-child-stream',
          kind: 'agent',
          stage: 'agent:inspect',
          tool: 'Agent',
          name: 'inspect',
          toolUseId: 'child-task'
        }),
        ev({
          id: 'child-delta-1',
          runId: 'run-child-stream',
          kind: 'model',
          stage: 'text_delta',
          text: '子 agent ',
          parentToolUseId: 'child-task'
        }),
        ev({
          id: 'child-delta-2',
          runId: 'run-child-stream',
          kind: 'model',
          stage: 'text_delta',
          text: '已完成',
          parentToolUseId: 'child-task'
        }),
        ev({
          id: 'child-question-use',
          runId: 'run-child-stream',
          kind: 'tool',
          stage: 'tool:AskUserQuestion',
          tool: 'AskUserQuestion',
          toolUseId: 'child-question',
          input: { questions: pendingQuestion.questions },
          parentToolUseId: 'child-task'
        })
      ]
    }

    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={childTurn}
        selectedId="child-delta-2"
        onSelect={() => {}}
        pendingQuestions={[pendingQuestion]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html).toContain('子 agent 已完成')
    expect(html.match(/class="model-text md sub"/g)).toHaveLength(1)
  })
it('Hook 缺少上游命令时明确标记数据边界', () => {
    const hookTurn: Turn = {
      runId: 'run-hook-without-command',
      userText: '查找文件',
      done: true,
      items: [
        ev({
          id: 'hook-start',
          kind: 'hook',
          stage: 'hook_started',
          hookId: 'hook-1',
          hookName: 'PreToolUse:Grep',
          hookEvent: 'PreToolUse'
        }),
        ev({
          id: 'hook-response',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'hook-1',
          hookName: 'PreToolUse:Grep',
          hookEvent: 'PreToolUse',
          hookConfiguredCommands: [
            {
              command: 'python3 $CLAUDE_PROJECT_DIR/.claude/hooks/trace_pre.py',
              source: 'project',
              sourcePath: '/repo/.claude/settings.json'
            },
            {
              command: '/Users/me/.masko-desktop/hooks/hook-sender',
              source: 'user',
              sourcePath: '/Users/me/.claude/settings.json',
              matcher: 'Grep|Read'
            }
          ],
          hookOutcome: 'success',
          hookExitCode: 0
        })
      ]
    }
    const hookHtml = renderToStaticMarkup(<AssistantTurn turn={hookTurn} selectedId={null} onSelect={() => {}} />)

    expect(hookHtml).toContain('1 成功')
    expect(hookHtml).not.toContain('事件明细')
    expect(hookHtml).not.toContain('原始事件')
    expect(hookHtml).not.toContain('hook-1')
    expect(hookHtml).not.toContain('执行命令')
    expect(hookHtml).not.toContain('触发点')
    expect(hookHtml).not.toContain('最近 hookId')
    expect(hookHtml).toContain('当前配置匹配 · 2 条')
    expect(hookHtml).toContain('trace_pre.py')
    expect(hookHtml).toContain('hook-sender')
    expect(hookHtml).toContain('matcher Grep|Read')
    expect(hookHtml).toContain('当前配置无法完整解释实际数量')
    expect(hookHtml).not.toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/trace_pre.py')
    expect(hookHtml).not.toContain('/Users/me/.masko-desktop/hooks/hook-sender')
    expect(hookHtml).not.toContain('/Users/me/.claude/settings.json')
  })
it('Hook 隐藏生命周期事件，并按 hookId 列出命令未上报的取消实例', () => {
    const configured: NonNullable<TraceEvent['hookConfiguredCommands']> = Array.from({ length: 9 }, (_, index) => ({
      command: `hook-${index + 1}.sh`,
      source: 'user' as const,
      sourcePath: '/Users/me/.claude/settings.json'
    }))
    const items: TraceEvent[] = []
    const cancelledHookId = '8bb3ff6c-3927-44c1-8cb9-dd395b923449'
    for (let index = 0; index < 18; index++) {
      items.push(ev({
        id: `start-${index}`,
        kind: 'hook',
        stage: 'hook_started',
        hookId: index === 17 ? cancelledHookId : `hook-${index}`,
        hookName: 'Stop',
        hookEvent: 'Stop'
      }))
    }
    items.push(ev({
      id: 'progress-17',
      kind: 'hook',
      stage: 'hook_progress',
      hookId: cancelledHookId,
      hookName: 'Stop',
      hookEvent: 'Stop'
    }))
    for (let index = 0; index < 17; index++) {
      items.push(ev({
        id: `response-${index}`,
        kind: 'hook',
        stage: 'hook_response',
        hookId: `hook-${index}`,
        hookName: 'Stop',
        hookEvent: 'Stop',
        hookOutcome: 'success'
      }))
    }
    items.push(ev({
      id: 'cancelled-17',
      kind: 'hook',
      stage: 'hook_response',
      hookId: cancelledHookId,
      hookName: 'Stop',
      hookEvent: 'Stop',
      hookOutcome: 'cancelled',
      hookConfiguredCommands: configured,
      durationMs: 5600,
      isError: false
    }))
    const turn: Turn = { runId: 'run-stop-hooks', userText: '继续', done: true, items }

    const hookHtml = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)

    expect(hookHtml).toContain('18 个处理器实例')
    expect(hookHtml).toContain('17 成功 · 1 取消')
    expect(hookHtml).not.toContain('事件明细')
    expect(hookHtml).not.toContain('原始事件')
    expect(hookHtml).toContain('未成功的 Hook · 1')
    expect(hookHtml).toContain('命令未上报')
    expect(hookHtml).toContain('8bb3ff6c-3927-44c1-8cb9-dd395b923449')
    expect(hookHtml).toContain('无法可靠映射到下方 9 条当前配置')
  })
it('Hook 标题按 15 次工具调用计数，展开结果保留 15 × 4 个处理器结果', () => {
    const configured: NonNullable<TraceEvent['hookConfiguredCommands']> = [
      { command: 'user-audit.mjs', source: 'user', sourcePath: '/home/.claude/settings.json' },
      { command: 'hook-sender', source: 'user', sourcePath: '/home/.claude/settings.json' },
      { command: 'trace_pre.py', source: 'project', sourcePath: '/repo/.claude/settings.json' },
      {
        command: 'security_reminder_hook.py',
        source: 'plugin',
        sourcePath: '/home/.claude/plugins/security-guidance/hooks/hooks.json',
        matcher: 'Edit|Write|MultiEdit',
        pluginId: 'security-guidance@claude-plugins-official'
      }
    ]
    const items: TraceEvent[] = []
    for (let i = 0; i < 15; i++) {
      items.push(ev({ id: `bash-${i}`, kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: `bash-${i}` }))
    }
    for (let i = 0; i < 60; i++) {
      items.push(ev({ id: `hook-start-${i}`, kind: 'hook', stage: 'hook_started', hookId: `hook-${i}`, hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse' }))
      items.push(ev({
        id: `hook-response-${i}`,
        kind: 'hook',
        stage: 'hook_response',
        hookId: `hook-${i}`,
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        hookOutcome: 'success',
        hookConfiguredCommands: i === 59 ? configured : undefined
      }))
    }
    const hookTurn: Turn = { runId: 'run-six-by-six', userText: '编辑文件', done: true, items }

    const hookHtml = renderToStaticMarkup(<AssistantTurn turn={hookTurn} selectedId={null} onSelect={() => {}} />)

    expect(hookHtml).toContain('60 个处理器实例')
    expect(hookHtml).toContain('15 次 Bash')
    expect(hookHtml).toContain('hook-run-count">15×')
    expect(hookHtml).not.toContain('hook-run-count">60×')
    expect(hookHtml).toContain('60 成功')
    expect(hookHtml).toContain('每次并行触发的 Hook · 4 个')
    expect(hookHtml).not.toContain('当前配置与运行实例数完整对齐')
    expect(hookHtml).not.toContain('Hook 执行')
    expect(hookHtml).not.toContain('执行命令')
    expect(hookHtml).not.toContain('最近 hookId')
    expect(hookHtml).not.toContain('触发点')
    expect(hookHtml).toContain('插件 · security-guidance')
    expect(hookHtml).toContain('security_reminder_hook.py')
  })
it('HOOKS 周期行按处理器运行区间并集展示占用耗时', () => {
    const hookTurn: Turn = {
      runId: 'run-hook-phase-timing',
      userText: '检查 Hook 耗时',
      done: true,
      items: [
        ev({
          id: 'pre-a',
          ts: '2026-08-07T00:00:03.000Z',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'pre-a',
          hookEvent: 'PreToolUse',
          hookName: 'PreToolUse:Bash',
          hookOutcome: 'success',
          durationMs: 3000
        }),
        ev({
          id: 'pre-b',
          ts: '2026-08-07T00:00:04.000Z',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'pre-b',
          hookEvent: 'PreToolUse',
          hookName: 'PreToolUse:Bash',
          hookOutcome: 'success',
          durationMs: 3000
        }),
        ev({
          id: 'stop-untimed',
          ts: '2026-08-07T00:00:05.000Z',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'stop-untimed',
          hookEvent: 'Stop',
          hookName: 'Stop',
          hookOutcome: 'success'
        })
      ]
    }

    const html = renderToStaticMarkup(<AssistantTurn turn={hookTurn} selectedId={null} onSelect={() => {}} />)

    expect(html).toContain('耗时 ~4.0s')
    expect(html).toContain('按 2/2 个处理器实例的运行区间合并去重')
    expect(html).toContain('耗时 —')
    expect(html).toContain('无法可靠计算周期耗时')
  })
it('用户气泡保留长链接的完整 href', () => {
    const url = 'https://docs.example.com/i/nodes/example-node-id?cid=7886930%3A4041342848&utm_source=im&utm_scene=team_space&iframeQuery=utm_medium%3D'
    const userHtml = renderToStaticMarkup(<UserMessage text={`技术方案：\n${url}`} />)
    expect(userHtml).toContain('class="md user-md"')
    expect(userHtml).toContain(`href="${url.replaceAll('&', '&amp;')}"`)
    expect(userHtml).toContain('技术方案')
  })
it('用户消息不再提供重新编辑入口', () => {
    const userHtml = renderToStaticMarkup(<UserMessage text="原消息" />)
    const chatHtml = renderWelcome({
      turns: [{
        runId: 'run-current', userText: '原消息', done: true, items: [],
        providerTurnId: 'provider-current', forkTurnId: 'fork-current'
      }]
    })

    expect(userHtml).not.toContain('编辑最后一条消息')
    expect(chatHtml).not.toContain('编辑最后一条消息')
    expect(chatHtml).not.toContain('将创建新对话分支')
  })
it('长用户消息用紧凑的折叠控件展示行数与展开状态', () => {
    const userHtml = renderToStaticMarkup(<UserMessage text={Array.from({ length: 13 }, (_, index) => `第 ${index + 1} 行`).join('\n')} />)

    expect(userHtml).toContain('class="expandbtn"')
    expect(userHtml).toContain('aria-expanded="false"')
    expect(userHtml).toContain('<span>展开全部</span>')
    expect(userHtml).toContain('<span class="expandmeta">13 行</span>')
    expect(userHtml).not.toContain('展开全部（')
  })


})