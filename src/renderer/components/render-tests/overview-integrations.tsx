import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, logicalCallEventsForTurn, OverviewPanel, turnCallRowsFromMap, ev, turn } = shared
type TraceEvent = shared.TraceEvent
type Turn = shared.Turn

describe('OverviewPanel 渲染：verdict 卡 + context + top tools + 文件足迹 + git diff + 累计 + sqlite 分析', () => {
  const html = renderToStaticMarkup(
    <OverviewPanel
      turns={[turn]}
      sessionId="dea0c990-714d-4888-aed0-7a13952d84ad"
      selected={null}
      onSelect={() => {}}
      gitDiff={{ status: 'captured', files: [
        { path: '/tmp/probe.txt', added: 5, deleted: 2 },
        { path: '/x/other.ts', added: 1, deleted: 0 }
      ] }}
      usage={{ cost: 0.5, tin: 3000, tout: 400, turns: 2 }}
      stats={{
        status: 'ready',
        totals: { cost: 0.5, tin: 3000, tout: 400, turns: 2 },
        topTools: [
          { tool: 'Read', n: 12, mcp: 0 },
          { tool: 'Bash', n: 7, mcp: 0 }
        ],
        byCwd: [
          { cwd: '/a/proj-x', cost: 0.3, turns: 1 },
          { cwd: '/b/proj-y', cost: 0.2, turns: 1 }
        ],
        byModel: [{ model: 'claude-opus-4-8[1m]', tin: 30000, tout: 400, cost: 0.5 }],
        toolStats: [{ tool: 'Bash', n: 4, avgMs: 2300, errors: 1 }],
        dangerTrend: [{ reason: 'rm 递归强删', level: 'danger', n: 3 }]
      }}
    />
  )
  it('每轮 Skill 调用把注入和内部文件证据折叠为一次，同时保留嵌套 Skill', () => {
    const skillEvidenceTurn: Turn = {
      runId: 'skill-evidence',
      userText: '/workflow-orchestrator 12345678',
      done: true,
      items: [
        ev({
          id: 'rate-injection',
          runId: 'skill-evidence',
          kind: 'skill',
          stage: 'skill:workflow-orchestrator',
          name: 'workflow-orchestrator',
          input: { source: 'skill_injection' }
        }),
        ev({
          id: 'rate-phase',
          runId: 'skill-evidence',
          kind: 'skill',
          stage: 'skill:workflow-orchestrator',
          name: 'workflow-orchestrator',
          messageId: 'phase-message',
          input: { source: 'skill_file', path: '/repo/.claude/skills/workflow-orchestrator/phases/00_intake.md' }
        }),
        ev({
          id: 'tracker-call',
          runId: 'skill-evidence',
          kind: 'skill',
          stage: 'skill:issue-intake',
          name: 'issue-intake',
          toolUseId: 'skill-tracker'
        }),
        ev({
          id: 'rate-reference',
          runId: 'skill-evidence',
          kind: 'skill',
          stage: 'skill:workflow-orchestrator',
          name: 'workflow-orchestrator',
          messageId: 'reference-message',
          input: { source: 'skill_file', path: '/repo/.claude/skills/workflow-orchestrator/references/fast-track.md' }
        }),
        ev({ id: 'skill-result', runId: 'skill-evidence', kind: 'harness', stage: 'result' })
      ]
    }
    const logicalSkills = logicalCallEventsForTurn(skillEvidenceTurn.items).filter((event) => event.kind === 'skill')
    expect(logicalSkills.map((event) => event.name)).toEqual(['workflow-orchestrator', 'issue-intake'])

    const skillHtml = renderToStaticMarkup(
      <OverviewPanel turns={[skillEvidenceTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    const turnCalls = skillHtml.slice(skillHtml.indexOf('turn-call-list'), skillHtml.indexOf('每轮仅展示'))
    expect(turnCalls).toContain('aria-label="Skill 2，展开明细"')
    expect(turnCalls).toContain('turn-call-group turn-call-toggle skill')
    expect(turnCalls).toContain('turn-call-count">2</span>')
  })
it('每轮 Skill 明细不把 git show 中的 Skill 路径引用算成执行', () => {
    const evidenceTurn: Turn = {
      runId: 'skill-reference-evidence',
      userText: '更新 changelog',
      done: true,
      items: [
        ev({
          id: 'kami-call', runId: 'skill-reference-evidence', kind: 'skill', stage: 'skill:kami',
          name: 'kami', tool: 'Skill', toolUseId: 'skill-kami'
        }),
        ...['hsf-invoke', 'rate-workflow', 'yixiu-experiment'].map((name, index) => ev({
          id: `reference-${index}`, runId: 'skill-reference-evidence', kind: 'skill', stage: `skill:${name}`,
          name, tool: 'Skill', input: { source: 'skill_path_in_bash', command: `git show -- .claude/skills/${name}/SKILL.md` }
        })),
        ev({ id: 'bash-call', runId: 'skill-reference-evidence', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash-1' }),
        ev({ id: 'result', runId: 'skill-reference-evidence', kind: 'harness', stage: 'result' })
      ]
    }

    const html = renderToStaticMarkup(
      <OverviewPanel turns={[evidenceTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    const turnCalls = html.slice(html.indexOf('turn-call-list'), html.indexOf('每轮仅展示'))
    expect(turnCalls).toContain('aria-label="Skill 1，展开明细"')
    expect(turnCalls).toContain('kami')
    expect(turnCalls).not.toContain('hsf-invoke')
    expect(turnCalls).not.toContain('rate-workflow')
    expect(turnCalls).not.toContain('yixiu-experiment')
  })
it('每轮 Skill 明细按首次调用顺序展示，不按次数或名称重排', () => {
    const rows = turnCallRowsFromMap(new Map([
      ['rate-native-rate-workflow', 1],
      ['rate-workflow', 1],
      ['browser-harness', 2],
      ['rate-native-rate-doc', 1],
      ['rate-doc', 1],
      ['config-center', 1]
    ]), true)

    expect(rows.map((row) => row.name)).toEqual([
      'rate-native-rate-workflow',
      'rate-workflow',
      'browser-harness',
      'rate-native-rate-doc',
      'rate-doc',
      'config-center'
    ])
  })
it('同名 Skill 有两个不同 toolUseId 时仍计为两次真实调用', () => {
    const logicalSkills = logicalCallEventsForTurn([
      ev({ id: 'skill-1', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator', toolUseId: 'skill-1' }),
      ev({ id: 'skill-2', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator', toolUseId: 'skill-2' })
    ]).filter((event) => event.kind === 'skill')

    expect(logicalSkills).toHaveLength(2)
  })
it('Codex 明确 Skill 输入优先于命令路径证据，多个内部命令仍只计一次', () => {
    const logicalSkills = logicalCallEventsForTurn([
      ev({
        id: 'codex-explicit',
        kind: 'skill',
        stage: 'skill:workflow-orchestrator',
        name: 'workflow-orchestrator',
        input: { source: 'explicit_user_input' }
      }),
      ev({
        id: 'codex-command-1',
        kind: 'skill',
        stage: 'skill:workflow-orchestrator',
        name: 'workflow-orchestrator',
        toolUseId: 'command-1',
        input: { source: 'skill_path_in_command' }
      }),
      ev({
        id: 'codex-command-2',
        kind: 'skill',
        stage: 'skill:workflow-orchestrator',
        name: 'workflow-orchestrator',
        toolUseId: 'command-2',
        input: { source: 'skill_path_in_command' }
      })
    ]).filter((event) => event.kind === 'skill')

    expect(logicalSkills.map((event) => event.id)).toEqual(['codex-explicit'])
  })
it('每轮调用段保留零调用轮次，不让标题与会话总轮数冲突', () => {
    const noCallTurn: Turn = {
      runId: 'r2',
      userText: '只返回文本，不调用工具',
      done: true,
      items: [ev({ id: 'r2-result', runId: 'r2', kind: 'harness', stage: 'result' })]
    }
    const rowsHtml = renderToStaticMarkup(
      <OverviewPanel turns={[turn, noCallTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(rowsHtml).toContain('每轮调用')
    expect(rowsHtml).toContain('2 turns')
    expect(rowsHtml).toContain('T02')
    expect(rowsHtml).toContain('只返回文本，不调用工具')
    expect(rowsHtml).toContain('aria-label="MCP 0，无明细"')
    expect(rowsHtml).toContain('aria-label="Skill 0，无明细"')
    expect(rowsHtml).toContain('aria-label="Hooks 0，无明细"')
    expect(rowsHtml).toContain('aria-label="文件 0，无明细"')
  })
it('Hooks 按轮聚合，不把会话总数重复展示到每一轮', () => {
    const hook = (id: string, runId: string): TraceEvent => ev({
      id,
      runId,
      kind: 'hook',
      stage: 'hook_response',
      hookId: id,
      hookEvent: 'PostToolUse',
      hookName: 'PostToolUse:Read',
      hookCommand: 'event_router.py',
      hookOutcome: 'success'
    })
    const hookTurnsHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[
          { runId: 'hook-r1', userText: '第一轮', done: true, items: [hook('hook-1', 'hook-r1')] },
          { runId: 'hook-r2', userText: '第二轮', done: true, items: [hook('hook-2', 'hook-r2'), hook('hook-3', 'hook-r2')] }
        ]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )
    const turnCalls = hookTurnsHtml.slice(hookTurnsHtml.indexOf('turn-call-list'), hookTurnsHtml.indexOf('每轮仅展示'))

    expect(turnCalls).toContain('aria-label="Hooks 1，展开明细"')
    expect(turnCalls).toContain('aria-label="Hooks 2，展开明细"')
    expect(turnCalls).not.toContain('aria-label="Hooks 3，展开明细"')
  })
it('HOOKS 段：展示本会话实际触发的 hook', () => {
    expect(html).toContain('HOOKS')
    expect(html).toContain('事件 1 类')
    expect(html).toContain('1 次执行')
    expect(html).toContain('1 条事件')
    expect(html).not.toContain('触发次数未单独上报')
    expect(html).toContain('PreToolUse')
    expect(html).toContain('PreToolUse:Edit')
    expect(html).toContain('branch-check-hook.sh')
    expect(html).toContain('成功 1')
    expect(html).toContain('处理器实例 · 1 个')
    expect(html).toContain('逻辑 Hook · 1 个')
    expect(html).toContain('1 条投递 · 运行时')
    expect(html).not.toContain('$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh')
    expect(html).not.toContain('来自 SDK hook_*')
  })
it('HOOKS 段：区分实际执行、逻辑 Hook 与当前配置投递，并隐藏长路径', () => {
    const configuredCommands = [
      {
        command:
          'python3 /Users/example/.local/share/rate-native-agent-hooks/global-hook-bridge.py --event UserPromptSubmit --group-index 0 --expected-marker .claude/hooks/trace_prompt.py',
        source: 'user' as const,
        sourcePath: '/Users/example/.codex/hooks.json',
        timeoutSeconds: 10
      },
      {
        command:
          'python3 /Users/example/.local/share/rate-native-agent-hooks/global-hook-bridge.py --event UserPromptSubmit --group-index 1 --expected-marker .claude/hooks/scry-recorder.sh',
        source: 'user' as const,
        sourcePath: '/Users/example/.codex/hooks.json',
        timeoutSeconds: 20
      },
      {
        command:
          'sh -c \'CLAUDE_PROJECT_DIR="$PWD"; python3 $CLAUDE_PROJECT_DIR/.claude/hooks/trace_prompt.py\'',
        source: 'project' as const,
        sourcePath: '/repo/.codex/hooks.json',
        timeoutSeconds: 5
      },
      {
        command:
          'sh -c \'CLAUDE_PROJECT_DIR="$PWD"; $CLAUDE_PROJECT_DIR/.claude/hooks/scry-recorder.sh\'',
        source: 'project' as const,
        sourcePath: '/repo/.codex/hooks.json',
        timeoutSeconds: 15
      }
    ]
    const configuredTurn: Turn = {
      ...turn,
      items: ['user-1', 'project-1', 'project-2'].flatMap((hookId, index) => {
        const source = index === 0 ? 'user' : 'project'
        const sourcePath = source === 'user' ? '/Users/example/.codex/hooks.json' : '/repo/.codex/hooks.json'
        return [
          ev({
            id: `${hookId}-start`,
            kind: 'hook',
            stage: 'hook_started',
            hookId,
            hookEvent: 'UserPromptSubmit',
            hookName: 'UserPromptSubmit:command',
            hookConfiguredCommands: configuredCommands,
            input: { source, sourcePath }
          }),
          ev({
            id: `${hookId}-response`,
            kind: 'hook',
            stage: 'hook_response',
            hookId,
            hookEvent: 'UserPromptSubmit',
            hookName: 'UserPromptSubmit:command',
            hookOutcome: 'success',
            hookConfiguredCommands: configuredCommands,
            durationMs: 100 + index,
            input: { source, sourcePath }
          })
        ]
      })
    }
    const configuredHtml = renderToStaticMarkup(
      <OverviewPanel turns={[configuredTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(configuredHtml).toContain('UserPromptSubmit:command')
    expect(configuredHtml).toContain('处理器实例 · 3 个 · 合并为 1 组')
    expect(configuredHtml).toContain('hook-instance-index">3×')
    expect(configuredHtml).toContain('均 0.1s')
    expect(configuredHtml.match(/class="hook-instance"/g)).toHaveLength(1)
    expect(configuredHtml).toContain('逻辑 Hook · 2 个')
    expect(configuredHtml).toContain('当前配置 · 4 条投递路径')
    expect(configuredHtml).toContain('命令未逐实例上报')
    expect(configuredHtml).toContain('trace_prompt.py')
    expect(configuredHtml).toContain('scry-recorder.sh')
    expect(configuredHtml).toContain('2 条投递 · 用户 桥接 / 项目 直连')
    expect(configuredHtml).toContain('hooks.json')
    expect(configuredHtml).not.toContain('/Users/example/.local/share')
    expect(configuredHtml).not.toContain('/Users/example/.codex/hooks.json')
    expect(configuredHtml).not.toContain('/repo/.codex/hooks.json')
    expect(configuredHtml).not.toContain('global-hook-bridge.py')
  })
it('HOOKS 段：处理器实例仅按名称和状态分组，耗时取已上报实例的平均值', () => {
    const configuredCommands = [
      {
        command: 'python3 /repo/.claude/hooks/event_router.py',
        source: 'project' as const,
        sourcePath: '/repo/.codex/project-hooks.json'
      },
      {
        command: 'python3 /repo/.claude/hooks/audit.py',
        source: 'local' as const,
        sourcePath: '/repo/.codex/local-hooks.json'
      }
    ]
    const groupedTurn: Turn = {
      ...turn,
      items: [
        ['router-success-1', 'project', '/repo/.codex/project-hooks.json', 'success', 100],
        ['router-success-2', 'project', '/repo/.codex/project-hooks.json', 'success', 300],
        ['router-success-3', 'project', '/repo/.codex/project-hooks.json', 'success', undefined],
        ['router-failure', 'project', '/repo/.codex/project-hooks.json', 'error', 900],
        ['audit-success', 'local', '/repo/.codex/local-hooks.json', 'success', undefined]
      ].map(([id, source, sourcePath, outcome, durationMs]) =>
        ev({
          id: String(id),
          kind: 'hook',
          stage: 'hook_response',
          hookId: String(id),
          hookEvent: 'PostToolUse',
          hookName: 'PostToolUse:command',
          hookOutcome: String(outcome),
          hookConfiguredCommands: configuredCommands,
          durationMs: typeof durationMs === 'number' ? durationMs : undefined,
          isError: outcome === 'error',
          input: { source, sourcePath }
        })
      )
    }
    const groupedHtml = renderToStaticMarkup(
      <OverviewPanel turns={[groupedTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(groupedHtml).toContain('处理器实例 · 5 个 · 合并为 3 组')
    expect(groupedHtml.match(/class="hook-instance"/g)).toHaveLength(3)
    expect(groupedHtml).toContain('hook-instance-index">3×')
    expect(groupedHtml).toContain('event_router.py')
    expect(groupedHtml).toContain('audit.py')
    expect(groupedHtml).toContain('均 0.2s')
    expect(groupedHtml).toContain('均 0.9s')
    expect(groupedHtml).toContain('3 个实例中 2 个上报耗时')
    expect(groupedHtml.match(/hook-run-status ok">成功/g)).toHaveLength(2)
    expect(groupedHtml.match(/hook-run-status bad">失败/g)).toHaveLength(1)
    const auditStart = groupedHtml.indexOf('<strong>audit.py')
    const auditRow = groupedHtml.slice(auditStart, groupedHtml.indexOf('</button>', auditStart))
    expect(auditRow).not.toContain('hook-instance-duration')
    expect(auditRow).not.toContain('均 0.0s')
  })


})