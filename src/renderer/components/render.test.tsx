// 渲染侧运行证据 + D1 拆分回归：用真实 TraceEvent 数据渲染拆出来的组件，
// 断言核心流程的三样 UI 都出来——trace 树（工具节点）/ footer（token）/ 文件足迹。
// renderToStaticMarkup 不需 DOM，纯 node 跑，确定性、零成本，可常驻套件。
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef, type ComponentProps } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest } from '@shared/runtime'
import type { Turn } from '../format'
import type { ParsedTurn } from '../env'
import {
  App,
  activeRunForSession,
  attachmentsAfterSuccessfulSubmit,
  appendWorkspaceReference,
  applyNewConversationEffects,
  applySessionCapturedEffects,
  applyTurnDoneEffects,
  chatBottomDistance,
  commitDraftAfterStart,
  dequeueStartedPrompt,
  enqueuePrompt,
  inputAfterSuccessfulSubmit,
  isChatNearBottom,
  restoreActiveSessionSelection,
  scrollChatToBottomIfNeeded,
  scrollChatTargetIntoView,
  shouldQueuePrompt,
  takeNextQueuedPrompt
} from '../App'
import { getMcpGuardReportForCwd, setMcpGuardReportForCwd } from '../mcp-trust-state'
import { resolveRunControlSelection, shouldResetRunControlCatalog } from '../hooks/useIntegrations'
import { AssistantTurn, UserMessage } from './ChatTurn'
import { ChatView, filterSlashCommands, imageFilesFromClipboardData } from './ChatView'
import { logicalCallEventsForTurn, OverviewPanel, turnCallRowsFromMap } from './OverviewPanel'
import { McpTrustPanel, type McpGuardReport } from './McpTrustPanel'
import { Sidebar } from './Sidebar'
import { ViewChrome } from './ViewChrome'
import { pathContains, WorkspacePanel, workspaceReferenceToken } from './WorkspacePanel'
import { parseUnifiedDiff, TurnDiffReviewPanel } from './TurnDiffReviewPanel'

const ev = (e: Partial<TraceEvent> & { id: string; kind: TraceEvent['kind']; stage: string }): TraceEvent => ({
  ts: '',
  runId: 'r1',
  ...e
})

const turn: Turn = {
  runId: 'r1',
  userText: '创建并读回文件',
  done: true,
  items: [
    ev({ id: 'e1', kind: 'model', stage: 'thinking', thinking: '先写文件再读回' }),
    ev({ id: 'e2', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'cat /tmp/bash-only.txt' } }),
    ev({ id: 'e3', kind: 'tool', stage: 'tool:Write', tool: 'Write', fileOp: 'write', filePath: '/tmp/probe.txt', input: { content: 'hi\nthere' } }),
    ev({ id: 'e4', kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/tmp/probe.txt' }),
    ev({ id: 'e5', kind: 'model', stage: 'text', text: '完成' }),
    ev({
      id: 'e-hook',
      kind: 'hook',
      stage: 'hook_response',
      tool: 'PreToolUse:Edit',
      name: 'PreToolUse',
      hookName: 'PreToolUse:Edit',
      hookEvent: 'PreToolUse',
      hookCommand: '$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh',
      hookOutcome: 'success',
      hookExitCode: 0,
      input: { stdout: 'branch ok' },
      text: 'branch ok',
      output: 'branch ok'
    }),
    ev({
      id: 'e6',
      kind: 'harness',
      stage: 'result',
      costUsd: 0.1234,
      tokensIn: 1500,
      tokensOut: 200,
      cacheReadTokens: 1000,
      cacheCreationTokens: 300,
      durationMs: 192400,
      durationApiMs: 5000,
      contextTokens: 87000,
      costSource: 'sdk_estimate',
      costConfidence: 'estimated',
      costUnit: 'usd',
      modelUsage: [
        {
          model: 'claude-opus-4-8',
          costUsd: 0.1234,
          costSource: 'sdk_estimate',
          costConfidence: 'estimated',
          costUnit: 'usd',
          contextWindow: 200000
        }
      ]
    })
  ]
}

const RUN_CONTROL_PROPS = {
  runControls: { permissionMode: 'default' as const },
  runControlCatalog: {
    models: [{
      model: { id: 'test-model' },
      label: 'Test Model',
      efforts: [{ id: 'high', label: '高' }]
    }, {
      model: { id: 'test-model-alias' },
      label: 'Test Model',
      efforts: []
    }],
    permissions: [
      { id: 'default' as const, label: '默认审批', description: '危险操作需要确认' },
      { id: 'full_access' as const, label: '完全访问', description: '跳过审批' }
    ]
  },
  onRunModel: () => {},
  onRunEffort: () => {},
  onPermissionMode: () => {}
}

describe('App shell 集成 smoke：拆分后的 shell / hooks / panes 首屏仍可组合渲染', () => {
  const html = renderToStaticMarkup(<App />)

  it('未选 cwd 首屏直接渲染不绑定项目的 composer，不挂空白纵览面板', () => {
    expect(html).toContain('app app-shell')
    expect(html).not.toContain('has-right-panel')
    expect(html).toContain('id="sidebar-pane"')
    expect(html).toContain('id="main-pane"')
    expect(html).not.toContain('id="overview-pane"')
    expect(html).toContain('不绑定项目')
    expect(html).toContain('可直接发起任务')
    expect(html).toContain('aria-label="运行配置"')
    expect(html).toContain('aria-label="模型"')
    expect(html).toContain('aria-label="权限"')
    expect(html).not.toContain('纵览面板')
    expect(html).not.toContain('class="logo"')
  })

  it('不绑定项目时只保留左侧 splitter 的 aria contract', () => {
    expect(html.match(/role="separator"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="调整左侧栏宽度"')
    expect(html).toContain('aria-controls="sidebar-pane"')
    expect(html).not.toContain('aria-label="调整右侧面板宽度"')
  })
})

describe('ViewChrome 顶栏', () => {
  it('完整探测尚未结束时显示检测中，而不是过早宣告未安装', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd={null}
        view="chat"
        agent={undefined}
        agentScanning
        showPanel
        onView={() => {}}
        onTogglePanel={() => {}}
      />
    )
    expect(html).toContain('正在检测 agent…')
    expect(html).not.toContain('未检测到 agent')
  })

  it('聊天页只保留视图切换和面板入口，不混入集成入口', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd="/tmp/sample-workspace"
        view="chat"
        agent={undefined}
        showPanel
        onView={() => {}}
        onTogglePanel={() => {}}
        onToggleWorkspace={() => {}}
      />
    )
    expect(html).toContain('对话')
    expect(html).toContain('拓扑')
    expect(html).toContain('分段')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('title="工作区文件"')
    expect(html).toContain('文件')
    expect(html).not.toContain('title="Skills"')
    expect(html).not.toContain('title="MCP"')
    expect(html).not.toContain('sample-workspace')
    expect(html).not.toContain('cwd-pill')
    expect(html).not.toContain('tb-filter')
    expect(html).not.toContain('&gt;all&lt;')
    expect(html).not.toContain('&gt;tool&lt;')
    expect(html).not.toContain('&gt;mcp&lt;')
  })

  it('不绑定项目的活动会话可打开纵览，但不伪造工作区文件入口', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd={null}
        view="chat"
        agent={undefined}
        showPanel
        canTogglePanel
        onView={() => {}}
        onTogglePanel={() => {}}
        onToggleWorkspace={() => {}}
      />
    )

    expect(html).toContain('title="纵览面板"')
    expect(html).not.toContain('title="工作区文件"')
  })
})

describe('运行控制选择', () => {
  it('重复选择同一 Agent 时不清空已有模型目录，切换 Provider 时才重置', () => {
    expect(shouldResetRunControlCatalog('qoder', 'qoder')).toBe(false)
    expect(shouldResetRunControlCatalog('codex', 'qoder')).toBe(true)
  })

  it('Provider 目录变化时丢弃失效模型和 effort，并保留仍受支持的权限', () => {
    expect(resolveRunControlSelection({
      models: [{ model: { id: 'new-model' }, label: 'New', efforts: [] }],
      permissions: [
        { id: 'default', label: '默认审批', description: 'ask' },
        { id: 'full_access', label: '完全访问', description: 'allow' }
      ]
    }, {
      model: { id: 'removed-model' },
      effort: 'high',
      permissionMode: 'full_access'
    })).toEqual({ model: undefined, effort: undefined, permissionMode: 'full_access' })
  })
})

describe('App turnDone 集成契约：session 完成后刷新派生状态', () => {
  it('捕获新 sessionId 后立即刷新左侧项目树', () => {
    const calls: string[] = []

    applySessionCapturedEffects(
      { runId: 'run-1', sessionId: 'session-1', previousSessionId: 'run-1' },
      {
        activeSessionId: 'run-1',
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['session:session-1', 'loadProjects'])
  })

  it('只把匹配 cwd/provider/session 的未完成 run 恢复到所选会话', () => {
    const run = {
      runId: 'run-1',
      providerId: 'claude' as const,
      cwd: '/repo/a',
      externalSessionId: 'session-1',
      userText: 'work',
      items: [],
      done: false
    }

    expect(activeRunForSession(run, '/repo/a', 'session-1', 'claude')).toBe(run)
    expect(activeRunForSession([{ ...run, runId: 'other', externalSessionId: 'other' }, run], '/repo/a', 'session-1', 'claude')).toBe(run)
    expect(activeRunForSession({ ...run, externalSessionId: undefined }, '/repo/a', 'run-1', 'claude')).toEqual({
      ...run,
      externalSessionId: undefined
    })
    expect(activeRunForSession(run, '/repo/b', 'session-1', 'claude')).toBeNull()
    expect(activeRunForSession({ ...run, done: true }, '/repo/a', 'session-1', 'claude')).toBeNull()
    expect(activeRunForSession({ ...run, cwd: undefined }, '', 'session-1', 'claude')).toMatchObject({ runId: 'run-1' })
  })

  it('恢复 live run 时先加载同一 session 的已停止历史轮次', async () => {
    const calls: string[] = []
    const archived: ParsedTurn[] = [{ userText: '第一轮（已停止）', items: [] }]
    const activeRun: ActiveRun = {
      runId: 'run-2',
      providerId: 'claude' as const,
      cwd: '/repo/a',
      externalSessionId: 'session-1',
      userText: '第二轮（运行中）',
      items: [],
      done: false
    }
    let replacement: { sessionId: string; parsed: ParsedTurn[]; activeRun: ActiveRun } | undefined

    const restored = await restoreActiveSessionSelection(
      {
        runId: activeRun.runId,
        sessionId: 'session-1',
        externalSessionId: 'session-1',
        cwd: '/repo/a',
        providerId: 'claude'
      },
      {
        prepareRunFocus: (runId) => calls.push(`prepare:${runId}`),
        adoptActiveRun: async (runId) => {
          calls.push(`adopt:${runId}`)
          return activeRun
        },
        loadSession: async (context) => {
          calls.push(`load:${context.externalSessionId}`)
          return archived
        },
        replaceWithParsedSession: (sessionId, parsed, options) => {
          replacement = { sessionId, parsed, activeRun: options.activeRun }
        }
      }
    )

    expect(restored).toBe(true)
    expect(calls).toEqual(['prepare:run-2', 'adopt:run-2', 'load:session-1'])
    expect(replacement).toEqual({ sessionId: 'session-1', parsed: archived, activeRun })
  })

  it('后台会话捕获或完成时只刷新列表，不抢走当前会话高亮', () => {
    const calls: string[] = []
    const effects = {
      activeSessionId: 'visible-session',
      setActiveSessionId: (sessionId: string) => calls.push(`session:${sessionId}`),
      loadProjects: () => calls.push('loadProjects')
    }

    applySessionCapturedEffects({ sessionId: 'background-session' }, effects)
    applyTurnDoneEffects(
      { sessionId: 'background-session' },
      { ...effects, refreshAfterTurn: () => calls.push('refreshAfterTurn') }
    )

    expect(calls).toEqual(['loadProjects', 'refreshAfterTurn', 'loadProjects'])
  })

  it('新建会话脱离后台 run 后，session 捕获和完成都不抢走空白草稿', () => {
    const calls: string[] = []
    const effects = {
      activeSessionId: null,
      setActiveSessionId: (sessionId: string) => calls.push(`session:${sessionId}`),
      loadProjects: () => calls.push('loadProjects')
    }

    applySessionCapturedEffects(
      { runId: 'background-run', sessionId: 'session-1', previousSessionId: 'background-run' },
      effects
    )
    applyTurnDoneEffects(
      { runId: 'background-run', sessionId: 'session-1' },
      { ...effects, refreshAfterTurn: () => calls.push('refreshAfterTurn') }
    )

    expect(calls).toEqual(['loadProjects', 'refreshAfterTurn', 'loadProjects'])
  })

  it('原生 sessionId 到达后把当前 provisional runId 原位升级', () => {
    const calls: string[] = []

    applySessionCapturedEffects(
      { runId: 'run-1', sessionId: 'session-1', previousSessionId: 'run-1' },
      {
        activeSessionId: 'run-1',
        setActiveSessionId: (sessionId) => calls.push(sessionId),
        loadProjects: () => {}
      }
    )

    expect(calls).toEqual(['session-1'])
  })

  it('SDK 返回 sessionId 时先记录 active session，再刷新 integrations 和项目列表', () => {
    const calls: string[] = []

    applyTurnDoneEffects(
      { sessionId: 'session-1' },
      {
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        refreshAfterTurn: () => calls.push('refreshAfterTurn'),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['session:session-1', 'refreshAfterTurn', 'loadProjects'])
  })

  it('SDK 未返回 sessionId 时仍刷新 usage/stats/billing/git/diag/MCP 和 projects', () => {
    const calls: string[] = []

    applyTurnDoneEffects(
      {},
      {
        setActiveSessionId: (sessionId) => calls.push(`session:${sessionId}`),
        refreshAfterTurn: () => calls.push('refreshAfterTurn'),
        loadProjects: () => calls.push('loadProjects')
      }
    )

    expect(calls).toEqual(['refreshAfterTurn', 'loadProjects'])
  })
})

describe('Sidebar 项目分组', () => {
  it('Skill 和 MCP 与分析、诊断同组展示，并保留 MCP 真实连接状态', () => {
    const renderIntegrations = (
      mcps: ComponentProps<typeof Sidebar>['mcps'],
      mcpLive: ComponentProps<typeof Sidebar>['mcpLive']
    ) => renderToStaticMarkup(
      <Sidebar
        projects={[]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onDelete={() => {}}
        onAnalytics={() => {}}
        onDiagnostics={() => {}}
        onSkills={() => {}}
        skillCount={3}
        onMcp={() => {}}
        mcps={mcps}
        mcpLive={mcpLive}
        onSettings={() => {}}
        themeLabel="浅色"
      />
    )

    const disabledHtml = renderIntegrations([
      { name: 'connected', scope: 'user', transport: 'stdio', detail: 'connected', enabled: true },
      { name: 'disabled', scope: 'user', transport: 'stdio', detail: 'disabled', enabled: false }
    ], [
      { name: 'connected', status: 'connected' },
      { name: 'disabled', status: 'disabled' }
    ])
    expect(disabledHtml).toContain('<nav class="sb-nav" aria-label="主要视图">')
    expect(disabledHtml).toContain('title="Skills"')
    expect(disabledHtml).toContain('title="MCP"')
    expect(disabledHtml).toContain('<span class="sb-navmeta">3</span>')
    expect(disabledHtml).toContain('aria-label="MCP · 1/1 已连接"')
    expect(disabledHtml).toContain('class="sb-navdot online"')
    expect(disabledHtml).toContain('class="sb-navitem sb-settings"')
    expect(disabledHtml).toContain('<span class="sb-navmeta">浅色</span>')
    expect(disabledHtml.indexOf('诊断')).toBeLessThan(disabledHtml.indexOf('title="Skills"'))

    const partialHtml = renderIntegrations([
      { name: 'connected', scope: 'user', transport: 'stdio', detail: 'connected', enabled: true },
      { name: 'failed', scope: 'user', transport: 'stdio', detail: 'failed', enabled: true }
    ], [
      { name: 'connected', status: 'connected' },
      { name: 'failed', status: 'failed' }
    ])
    expect(partialHtml).toContain('aria-label="MCP · 1/2 已连接"')
    expect(partialHtml).toContain('class="sb-navdot partial"')

    const runtimeOnlyHtml = renderIntegrations([], [{ name: 'runtime-only', status: 'connected' }])
    expect(runtimeOnlyHtml).toContain('aria-label="MCP · 1/1 已连接"')
    expect(runtimeOnlyHtml).toContain('class="sb-navdot online"')
  })

  it('同名项目标题带完整路径提示，hover 时能区分 cwd', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/IdeaProjects/sample-workspace',
            name: 'sample-workspace',
            mtime: 2,
            sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 2, preview: '当前目录路径是什么', count: 1 }]
          },
          {
            cwd: '/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace',
            name: 'sample-workspace',
            mtime: 1,
            sessions: [{ sessionId: 's2', externalSessionId: 's2', providerId: 'codex', mtime: 1, preview: '当前处于哪个目录', count: 1 }]
          }
        ]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onDelete={() => {}}
        onAnalytics={() => {}}
        analyticsActive
        onDiagnostics={() => {}}
      />
    )

    expect(html).toContain('<nav class="sb-nav" aria-label="主要视图">')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('<button type="button" class="sb-proj-head')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-project-path="/Users/example/IdeaProjects/sample-workspace"')
    expect(html).toContain('data-project-path="/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace"')
    expect(html).toContain('/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace')
  })

  it('不绑定项目会话以独立活动分组出现在左侧', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '',
          name: '不绑定项目',
          mtime: 2,
          sessions: [{ sessionId: 's-unbound', externalSessionId: 's-unbound', providerId: 'qoder', mtime: 2, preview: '无工作目录任务', count: 1 }]
        }]}
        activeCwd={null}
        activeSessionId="s-unbound"
        activeProviderId="qoder"
        onNewChat={() => {}}
        onPick={() => {}}
        onDelete={() => {}}
      />
    )

    expect(html).toContain('class="sb-proj-head on"')
    expect(html).toContain('aria-label="不绑定项目 · 未关联工作目录"')
    expect(html).toContain('class="sb-sess active"')
    expect(html).toContain('无工作目录任务')
  })

  it('仅给真实 active run 对应的会话展示运行中标识', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/project',
            name: 'project',
            mtime: 2,
            sessions: [
              { sessionId: 's1', runId: 'run-active', providerId: 'claude', mtime: 2, preview: '运行中', count: 1 },
              { sessionId: 's2', runId: 'run-done', providerId: 'claude', mtime: 1, preview: '已结束', count: 1 }
            ]
          }
        ]}
        activeCwd="/Users/example/project"
        activeSessionId="s1"
        activeProviderId="claude"
        runningRunIds={new Set(['run-active'])}
        onNewChat={() => {}}
        onPick={() => {}}
        onDelete={() => {}}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('class="sb-sess active running"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在运行"')
    expect(html.match(/class="sb-running"/g)).toHaveLength(1)
  })
})

describe('工作区文件面板', () => {
  it('提供文件树入口、筛选与可恢复删除语义', () => {
    const html = renderToStaticMarkup(
      <WorkspacePanel cwd="/tmp/project" onClose={() => {}} onAddReference={() => {}} />
    )

    expect(html).toContain('aria-label="工作区文件"')
    expect(html).toContain('筛选已展开的文件')
    expect(html).toContain('新建文件')
    expect(html).toContain('刷新文件树')
  })

  it('文件与目录引用转成可见 token，并避免重复插入', () => {
    expect(workspaceReferenceToken({ kind: 'file', path: 'src/App.tsx' })).toBe('@src/App.tsx')
    expect(workspaceReferenceToken({ kind: 'directory', path: 'docs/design notes' })).toBe('@"docs/design notes/"')
    expect(appendWorkspaceReference('检查', '@src/App.tsx')).toBe('检查 @src/App.tsx ')
    expect(appendWorkspaceReference('检查 @src/App.tsx ', '@src/App.tsx')).toBe('检查 @src/App.tsx ')
    expect(appendWorkspaceReference('检查 @"docs/design notes/" ', '@"docs/design notes/"')).toBe(
      '检查 @"docs/design notes/" '
    )
    expect(pathContains('src', 'src/App.tsx')).toBe(true)
    expect(pathContains('src', 'src-old/App.tsx')).toBe(false)
  })
})

describe('AssistantTurn 渲染：trace 树 / footer / 文件足迹', () => {
  const html = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)

  it('trace 树渲染出工具节点', () => {
    expect(html).toContain('Write')
    expect(html).toContain('Read')
    expect(html).toContain('Bash')
    expect(html).toContain('data-trace-event-id="e2"')
  })

  it('footer 渲染出 token（蓝本 turn-footer stat 条）', () => {
    expect(html).not.toContain('$0.1234')
    expect(html).toContain('1.5k') // in = fmtTok(tokensIn 1500)
    expect(html).toContain('turn-footer')
  })

  it('Codex turn 头部总 Token 不重复加上已包含在 input 内的 cache read', () => {
    const codexUsageTurn: Turn = {
      runId: 'codex-cache-accounting',
      userText: 'inspect',
      done: true,
      items: [
        ev({
          id: 'codex-result',
          kind: 'harness',
          stage: 'result',
          providerId: 'codex',
          runtimeProvider: 'codex_cli',
          tokensIn: 139_269,
          tokensOut: 767,
          cacheReadTokens: 110_336
        })
      ]
    }
    const codexUsageHtml = renderToStaticMarkup(
      <AssistantTurn turn={codexUsageTurn} selectedId={null} onSelect={() => {}} />
    )

    expect(codexUsageHtml).toContain('tok <b>140.0k</b>')
    expect(codexUsageHtml).not.toContain('tok <b>250.4k</b>')
  })

  it('footer 不把继承 tool/file 字段的 tool_result 重复计数', () => {
    const footerTurn: Turn = {
      runId: 'footer-dedupe',
      userText: 'read once',
      done: true,
      items: [
        ev({ id: 'read-use', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'read-result', kind: 'tool', stage: 'tool_result', tool: 'Read', toolUseId: 'read-1', fileOp: 'read', filePath: '/a.ts' }),
        ev({ id: 'result', kind: 'harness', stage: 'result', tokensIn: 1, tokensOut: 1 })
      ]
    }
    const footerHtml = renderToStaticMarkup(<AssistantTurn turn={footerTurn} selectedId={null} onSelect={() => {}} />)
    const footer = footerHtml.match(/<div class="turn-footer">[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(footer).toContain('<span class="lbl">tools</span> <b>1</b>')
    expect(footer).toContain('<span class="lbl">files</span> <b>1 R · 0 W</b>')
    expect(footer).not.toContain('<span class="lbl">tools</span> <b>2</b>')
  })

  it('Header 错误数只统计失败 tool_result，不把结果复制到同 ID Hook', () => {
    const sharedHooks = Array.from({ length: 10 }, (_, index) =>
      ev({
        id: `hook-${index}`,
        kind: 'hook',
        stage: 'hook_response',
        toolUseId: 'grep-failed',
        hookName: 'PostToolUse:Grep',
        hookEvent: 'PostToolUse',
        isError: index === 0
      })
    )
    const failedTools = ['grep-failed', 'bash-1', 'bash-2', 'bash-3', 'bash-4', 'bash-5'].flatMap((toolUseId) => [
      ev({ id: `${toolUseId}-start`, kind: 'tool', stage: `tool:${toolUseId === 'grep-failed' ? 'Grep' : 'Bash'}`, tool: toolUseId === 'grep-failed' ? 'Grep' : 'Bash', toolUseId }),
      ev({ id: `${toolUseId}-result`, kind: 'tool', stage: 'tool_result', tool: toolUseId === 'grep-failed' ? 'Grep' : 'Bash', toolUseId, isError: true })
    ])
    const errorTurn: Turn = {
      runId: 'qoder-errors',
      userText: 'work',
      done: true,
      items: [
        ...failedTools,
        ...sharedHooks,
        ev({ id: 'hook-no-id', kind: 'hook', stage: 'hook_response', hookName: 'SessionStart', hookEvent: 'SessionStart', isError: true })
      ]
    }

    const errorHtml = renderToStaticMarkup(<AssistantTurn turn={errorTurn} selectedId={null} onSelect={() => {}} />)
    const header = errorHtml.match(/<div class="who">[\s\S]*?<\/div>/)?.[0] ?? ''

    expect(header).toContain('err <b>6</b>')
    expect(header).not.toContain('err <b>13</b>')
    expect(errorHtml).toContain('失败 1')
    expect(errorHtml).not.toContain('失败 10')
  })

  it('turn 顶部与 footer 共用逻辑调用口径，不把 Skill 内部路径证据重复计数', () => {
    const ordinaryTools = Array.from({ length: 40 }, (_, index) =>
      ev({
        id: `tool-${index}`,
        kind: 'tool',
        stage: 'tool:Bash',
        tool: 'Bash',
        toolUseId: `tool-${index}`
      })
    )
    const logicalCountTurn: Turn = {
      runId: 'logical-call-count',
      userText: '/rate-workflow 84441907',
      done: true,
      items: [
        ...ordinaryTools,
        ev({
          id: 'root-skill',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          tool: 'Skill',
          name: 'rate-workflow',
          toolUseId: 'skill-root',
          input: { source: 'tool_use' }
        }),
        ev({
          id: 'root-skill-path',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          tool: 'Skill',
          name: 'rate-workflow',
          toolUseId: 'read-root-skill',
          input: { source: 'skill_path_in_command' }
        }),
        ...['intake', 'status', 'archive'].map((name) =>
          ev({
            id: `skill-${name}`,
            kind: 'skill',
            stage: `skill:${name}`,
            tool: 'Skill',
            name,
            toolUseId: `skill-${name}`,
            input: { source: 'tool_use' }
          })
        ),
        ev({ id: 'logical-result', kind: 'harness', stage: 'result', tokensIn: 1, tokensOut: 1 })
      ]
    }

    const logicalHtml = renderToStaticMarkup(
      <AssistantTurn turn={logicalCountTurn} selectedId={null} onSelect={() => {}} />
    )
    const header = logicalHtml.match(/<div class="who">[\s\S]*?<\/div>/)?.[0] ?? ''
    const footer = logicalHtml.match(/<div class="turn-footer">[\s\S]*?<\/div>/)?.[0] ?? ''

    expect(header).toContain('tools <b>44</b>')
    expect(header).not.toContain('tools <b>45</b>')
    expect(footer).toContain('<span class="lbl">tools</span> <b>44</b>')
  })

  it('who 头渲染头像 + runid', () => {
    expect(html).toContain('Agent')
    expect(html).toContain('run · r1') // turn.runId
  })

  it('who 头根据 runtimeProvider 展示 CLI agent 名称', () => {
    const qoderTurn: Turn = {
      runId: 'run-qoder',
      userText: '当前处于哪个目录',
      done: true,
      items: [
        ev({
          id: 'q1',
          kind: 'model',
          stage: 'text',
          text: '在 /repo',
          runtimeProvider: 'qoder_cli'
        })
      ]
    }
    const qoderHtml = renderToStaticMarkup(<AssistantTurn turn={qoderTurn} selectedId={null} onSelect={() => {}} />)
    expect(qoderHtml).toContain('Qoder')
    expect(qoderHtml).toContain('run · run-qoder')
  })

  it('文件工具证据同时渲染结构化操作与 Bash 推断读取', () => {
    expect(html).toContain('本轮文件（工具证据）')
    expect(html).toContain('probe.txt')
    const filesHtml = html.match(/<details class="files-summary"[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(filesHtml).not.toContain('Bash 触及')
    expect(filesHtml).toContain('bash-only.txt')
    expect(filesHtml).toContain('~R1')
    expect(filesHtml).toContain('<span class="fh-total">2</span>')
  })

  it('有 turn_diff 时增强同一张卡，展示逐文件与汇总 +/- 行数', () => {
    const diffTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({
          id: 'turn-diff',
          kind: 'harness',
          stage: 'turn_diff',
          turnDiff: {
            version: 1,
            status: 'captured',
            files: [
              { path: '/repo/src/a.ts', added: 5, deleted: 3 },
              { path: '/repo/test/image.png', added: 0, deleted: 0, binary: true },
              { path: '/repo/test/b.ts', added: 2, deleted: 0 }
            ],
            repoRoot: '/repo',
            scope: '.',
            beforeAt: '2026-07-14T00:00:00.000Z',
            afterAt: '2026-07-14T00:00:01.000Z',
            captureMs: 8,
            cleanup: 'ok'
          }
        })
      ]
    }
    const diffHtml = renderToStaticMarkup(<AssistantTurn turn={diffTurn} selectedId={null} onSelect={() => {}} />)

    expect(diffHtml).toContain('本轮改动')
    expect(diffHtml).toContain('3 files')
    expect(diffHtml).toContain('>+7<')
    expect(diffHtml).toContain('>−3<')
    expect(diffHtml).toContain('src/a.ts')
    expect(diffHtml).toContain('test/b.ts')
    expect(diffHtml).toContain('binary')
    expect(diffHtml.match(/class="files-summary/g)).toHaveLength(1)
    const filesHtml = diffHtml.match(/<details class="files-summary diff"[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(filesHtml).not.toContain('R ·')
  })

  it('本轮 patch 可渲染右侧 Review，并正确计算 unified diff 行号', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -2,2 +2,3 @@',
      ' keep',
      '-old',
      '+new',
      '+more'
    ].join('\n')
    const lines = parseUnifiedDiff(patch)
    expect(lines.find((line) => line.text === ' keep')).toMatchObject({ oldLine: 2, newLine: 2 })
    expect(lines.find((line) => line.text === '-old')).toMatchObject({ oldLine: 3 })
    expect(lines.find((line) => line.text === '-old')?.newLine).toBeUndefined()
    expect(lines.find((line) => line.text === '+new')).toMatchObject({ newLine: 3 })
    expect(lines.find((line) => line.text === '+new')?.oldLine).toBeUndefined()

    const reviewHtml = renderToStaticMarkup(
      <TurnDiffReviewPanel
        onClose={() => {}}
        review={{
          runId: 'run-review',
          userText: '修改 a.ts',
          turnDiff: {
            version: 1,
            status: 'captured',
            files: [{ path: '/repo/src/a.ts', added: 2, deleted: 1, patch, patchStatus: 'captured' }],
            repoRoot: '/repo',
            scope: '.',
            beforeAt: 'a',
            afterAt: 'b',
            captureMs: 8,
            cleanup: 'ok'
          }
        }}
      />
    )
    expect(reviewHtml).toContain('Review')
    expect(reviewHtml).toContain('src/a.ts')
    expect(reviewHtml).toContain('unified-diff')
    expect(reviewHtml).toContain('+new')
  })

  it('新轮 capture timeout 时保留旧文件足迹并诚实标记行数不可用', () => {
    const timeoutTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({
          id: 'turn-diff-timeout',
          kind: 'harness',
          stage: 'turn_diff',
          turnDiff: {
            version: 1,
            status: 'timeout',
            reason: 'deadline',
            files: [],
            beforeAt: '2026-07-14T00:00:00.000Z',
            afterAt: '2026-07-14T00:00:03.000Z',
            captureMs: 3000,
            cleanup: 'ok'
          }
        })
      ]
    }
    const timeoutHtml = renderToStaticMarkup(<AssistantTurn turn={timeoutTurn} selectedId={null} onSelect={() => {}} />)

    expect(timeoutHtml).toContain('本轮文件（工具证据）')
    expect(timeoutHtml).toContain('Git 差异采集超时')
    expect(timeoutHtml).not.toContain('± —')
    expect(timeoutHtml).toContain('精确行数不可用：deadline')
    expect(timeoutHtml).toContain('probe.txt')
  })

  it('本轮 Hook 复用逻辑调用聚合，不平铺 lifecycle 事件', () => {
    expect(html).toContain('本轮 Hook')
    expect(html).toContain('1 个处理器实例')
    expect(html).toContain('branch-check-hook.sh')
    expect(html).toContain('PreToolUse')
    expect(html).toContain('成功 1')
    expect(html.match(/class="turn-hook-row"/g)).toHaveLength(1)
    expect(html).not.toContain('Hook 执行')
    expect(html).not.toContain('执行命令')
    expect(html).not.toContain('$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh')
    expect(html.match(/branch ok/g)).toHaveLength(1)
    expect(html).not.toContain('hook_response')
  })

  it('cancelled Hook 使用黄色诚实态，并展示疑似超时依据而不冒充工具取消', () => {
    const command = 'python3 $CLAUDE_PROJECT_DIR/.claude/hooks/trace_pre.py'
    const cancelledTurn: Turn = {
      runId: 'run-hook-cancelled',
      userText: '继续',
      done: true,
      items: [
        ev({
          id: 'hook-cancelled',
          runId: 'run-hook-cancelled',
          kind: 'hook',
          stage: 'hook_response',
          hookId: 'cancel-1',
          hookEvent: 'PreToolUse',
          hookName: 'PreToolUse:Read',
          hookCommand: command,
          hookConfiguredCommands: [{
            command,
            source: 'project',
            sourcePath: '/repo/.claude/settings.json',
            timeoutSeconds: 5
          }],
          hookOutcome: 'cancelled',
          hookExitCode: 0,
          durationMs: 5531,
          input: { durationMs: 5531 },
          isError: false
        })
      ]
    }

    const turnHtml = renderToStaticMarkup(<AssistantTurn turn={cancelledTurn} selectedId={null} onSelect={() => {}} />)
    const overviewHtml = renderToStaticMarkup(
      <OverviewPanel turns={[cancelledTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(turnHtml).toContain('hook-run-status warn')
    expect(turnHtml).toContain('疑似超时')
    expect(turnHtml).toContain('5.5s / 当前配置上限 5.0s')
    expect(turnHtml).toContain('不代表对应工具调用也被取消')
    expect(turnHtml).toContain('未成功的 Hook · 1')
    expect(turnHtml).toContain('trace_pre.py')
    expect(turnHtml).not.toContain('hook-run-status ok">cancelled')
    expect(overviewHtml).toContain('hook-status warn">疑似超时 1')
    expect(overviewHtml).toContain('取消 1')
    expect(overviewHtml).toContain('疑似超时：5.5s / 当前配置上限 5.0s')
    expect(overviewHtml).not.toContain('疑似超时 · 0')
  })

  it('流式 Markdown 遇到工具边界时分段，并保持文本—工具—文本顺序', () => {
    const streamingTurn: Turn = {
      runId: 'run-streaming-boundary',
      userText: '修复问题',
      done: false,
      items: [
        ev({ id: 'delta-1', kind: 'model', stage: 'text_delta', text: '先**检查**' }),
        ev({ id: 'delta-2', kind: 'model', stage: 'text_delta', text: '项目' }),
        ev({ id: 'tool-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'npm test' } }),
        ev({ id: 'delta-3', kind: 'model', stage: 'text_delta', text: '临时草稿' }),
        ev({ id: 'text-1', kind: 'model', stage: 'text', text: '然后`修复`完成' })
      ]
    }

    const streamingHtml = renderToStaticMarkup(<AssistantTurn turn={streamingTurn} selectedId={null} onSelect={() => {}} />)
    const firstText = streamingHtml.indexOf('先<strong>检查</strong>项目')
    const tool = streamingHtml.indexOf('npm test')
    const secondText = streamingHtml.indexOf('然后<code>修复</code>完成')

    expect(streamingHtml.match(/class="model-text md/g)).toHaveLength(2)
    expect(firstText).toBeGreaterThan(-1)
    expect(tool).toBeGreaterThan(firstText)
    expect(secondText).toBeGreaterThan(tool)
    expect(streamingHtml).not.toContain('临时草稿')
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

  it('用户气泡保留长链接的完整 href', () => {
    const url = 'https://alidocs.dingtalk.com/i/nodes/93NwLYZXWvxXroNzCNEKwjB58kyEqBQm?cid=7886930%3A4041342848&utm_source=im&utm_scene=team_space&iframeQuery=utm_medium%3D'
    const userHtml = renderToStaticMarkup(<UserMessage text={`技术方案：\n${url}`} />)
    expect(userHtml).toContain('class="md user-md"')
    expect(userHtml).toContain(`href="${url.replaceAll('&', '&amp;')}"`)
    expect(userHtml).toContain('技术方案')
  })

  it('ChatView 能把待跳转轮次标记成滚动目标', () => {
    const chatHtml = renderToStaticMarkup(
      <ChatView
        turns={[turn]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/tmp/project"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        {...RUN_CONTROL_PROPS}
        runControls={{ model: { id: 'test-model' }, effort: 'high', permissionMode: 'default' }}
        input=""
        busy={false}
        draftAttachments={[]}
        queuedPrompts={[]}
        slashOpen={false}
        slashLoading={false}
        slashCmds={[]}
        slashSel={0}
        focusedTurnRunId="r1"
        onTurnRef={() => {}}
        onSelect={() => {}}
        onInput={() => {}}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onPasteImages={() => {}}
        onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={() => {}}
        onRescan={() => {}}
      />
    )
    expect(chatHtml).toContain('data-run-id="r1"')
    expect(chatHtml).toContain('turn-jump-target')
    expect(chatHtml).toContain('aria-label="模型"')
    expect(chatHtml).toContain('Test Model · test-model')
    expect(chatHtml).toContain('Test Model · test-model-alias')
    expect(chatHtml).toContain('aria-label="Effort"')
    expect(chatHtml).toContain('aria-label="权限"')
    const controls = chatHtml.match(/<div class="composer-controls"[\s\S]*?<div class="spacer"/u)?.[0] ?? ''
    expect(controls).toContain('aria-label="运行配置"')
    expect(controls).toContain('class="run-control-scroll"')
    expect(controls.indexOf('Agent')).toBeLessThan(controls.indexOf('aria-label="模型"'))
    expect(controls.indexOf('class="clipick"')).toBeLessThan(controls.indexOf('class="run-control-scroll"'))
    expect(controls.indexOf('aria-label="模型"')).toBeLessThan(controls.indexOf('aria-label="Effort"'))
    expect(controls.indexOf('aria-label="Effort"')).toBeLessThan(controls.indexOf('aria-label="权限"'))
  })

  it('斜杠菜单只展示当前输入匹配项，且标题不展示数量', () => {
    const commands = [
      { name: 'browser-use', description: 'Browser automation' },
      { name: 'code-fix', description: 'Fix code' },
      { name: 'nextcr-code-review', description: 'Review code' }
    ]
    expect(filterSlashCommands('/code', commands).map((command) => command.name)).toEqual([
      'code-fix',
      'nextcr-code-review'
    ])

    const chatHtml = renderToStaticMarkup(
      <ChatView
        turns={[]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/tmp/project"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        {...RUN_CONTROL_PROPS}
        input="/code"
        busy={false}
        draftAttachments={[]}
        queuedPrompts={[]}
        slashOpen
        slashLoading={false}
        slashCmds={commands}
        slashSel={0}
        onSelect={() => {}}
        onInput={() => {}}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onPasteImages={() => {}}
        onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={() => {}}
        onRescan={() => {}}
      />
    )
    expect(chatHtml).toContain('<span>Commands</span>')
    expect(chatHtml).not.toContain('Commands ·')
    expect(chatHtml).not.toContain('browser-use')
    expect(chatHtml).toContain('code-fix')
    expect(chatHtml).toContain('nextcr-code-review')
  })

  it('ChatView 渲染运行中输入队列和图片附件', () => {
    const chatHtml = renderToStaticMarkup(
      <ChatView
        turns={[{ ...turn, attachments: [{ kind: 'image', name: 'sent.png', mimeType: 'image/png', dataBase64: 'aQ==' }] }]}
        selectedId={null}
        scrollRef={createRef<HTMLDivElement>()}
        textareaRef={createRef<HTMLTextAreaElement>()}
        cwd="/tmp/project"
        recent={[]}
        agents={[]}
        selectedAgentId="claude"
        {...RUN_CONTROL_PROPS}
        input=""
        busy
        draftAttachments={[
          { id: 'draft-1', kind: 'image', name: 'draft.png', mimeType: 'image/png', dataBase64: 'aQ==', previewUrl: 'data:image/png;base64,aQ==' }
        ]}
        queuedPrompts={[{
          text: '继续检查',
          attachments: [{ kind: 'image', name: 'queued.png', mimeType: 'image/png', dataBase64: 'aQ==' }],
          request: { providerId: 'claude', permissionMode: 'default' }
        }]}
        slashOpen={false}
        slashLoading={false}
        slashCmds={[]}
        slashSel={0}
        onSelect={() => {}}
        onInput={() => {}}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => {}}
        onPickSlash={() => {}}
        onSlashSel={() => {}}
        onHideSlash={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onPasteImages={() => {}}
        onPasteClipboardImage={() => {}}
        onRemoveDraftAttachment={() => {}}
        onRemoveQueuedPrompt={() => {}}
        onSelectAgent={() => {}}
        onRescan={() => {}}
      />
    )
    expect(chatHtml).toContain('等待运行')
    expect(chatHtml).toContain('当前任务结束后依次发送')
    expect(chatHtml).toContain('queue-count">1')
    expect(chatHtml).toContain('aria-label="移除队列第 1 条消息"')
    expect(chatHtml).toContain('继续检查')
    expect(chatHtml).toContain('draft.png')
    expect(chatHtml).toContain('sent.png')
    expect(chatHtml).toContain('排队')
  })

  it('运行中发送队列按 FIFO 取出，空消息不入队', () => {
    const image = { kind: 'image' as const, name: 'queued.png', mimeType: 'image/png' as const, dataBase64: 'aQ==' }
    const queue = enqueuePrompt(
      enqueuePrompt([], '  先做 A  ', [], {
        providerId: 'codex',
        model: { id: 'gpt-5.3-codex' },
        effort: 'high',
        permissionMode: 'default'
      }),
      '',
      [image],
      { providerId: 'claude', permissionMode: 'full_access' }
    )
    expect(enqueuePrompt(queue, '   ')).toHaveLength(2)
    expect(queue[0]).toMatchObject({
      text: '先做 A',
      attachments: [],
      request: {
        providerId: 'codex',
        model: { id: 'gpt-5.3-codex' },
        effort: 'high',
        permissionMode: 'default'
      }
    })
    const first = takeNextQueuedPrompt(queue)
    expect(first.next?.text).toBe('先做 A')
    expect(first.rest[0].attachments[0].name).toBe('queued.png')
    expect(dequeueStartedPrompt(queue, first.next!)).toEqual(first.rest)
    expect(dequeueStartedPrompt(queue, { ...first.next! })).toBe(queue)
    expect(shouldQueuePrompt(false, queue.length, true)).toBe(true)
    expect(shouldQueuePrompt(false, queue.length, false)).toBe(true)
    expect(shouldQueuePrompt(false, 0, false)).toBe(false)
  })

  it('启动成功才提交原草稿，失败时不清空，且保留等待期间新增内容', async () => {
    let commits = 0
    await expect(
      commitDraftAfterStart(
        () => Promise.reject(new Error('start rejected')),
        () => { commits += 1 }
      )
    ).rejects.toThrow('start rejected')
    expect(commits).toBe(0)

    await commitDraftAfterStart(
      () => Promise.resolve(),
      () => { commits += 1 }
    )
    expect(commits).toBe(1)
    expect(inputAfterSuccessfulSubmit('原始草稿', '原始草稿')).toBe('')
    expect(inputAfterSuccessfulSubmit('原始草稿\n等待期间新增', '原始草稿')).toBe('等待期间新增')
    expect(inputAfterSuccessfulSubmit('完全改写', '原始草稿')).toBe('完全改写')

    const submitted = { id: 'sent', kind: 'image' as const, name: 'sent.png', mimeType: 'image/png' as const, dataBase64: 'aQ==', previewUrl: 'blob:sent' }
    const newer = { ...submitted, id: 'new', name: 'new.png', previewUrl: 'blob:new' }
    expect(attachmentsAfterSuccessfulSubmit([submitted, newer], new Set(['sent']))).toEqual([newer])
  })

  it('滚动只在接近底部时自动粘底', () => {
    expect(chatBottomDistance({ scrollHeight: 1000, scrollTop: 760, clientHeight: 220 })).toBe(20)
    expect(isChatNearBottom({ scrollHeight: 1000, scrollTop: 760, clientHeight: 220 })).toBe(true)
    expect(isChatNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 220 })).toBe(false)
    let top = 0
    const scrolled = scrollChatToBottomIfNeeded(
      { scrollHeight: 1000, scrollTop: 600, clientHeight: 220, scrollTo: (options) => (top = options.top) },
      true
    )
    expect(scrolled).toBe(true)
    expect(top).toBe(1000)
  })

  it('精确跳转按对话容器坐标定位到事件卡片', () => {
    const calls: Array<{ top: number; behavior?: ScrollBehavior }> = []
    const chat = {
      scrollTop: 320,
      getBoundingClientRect: () => ({ top: 100 }),
      scrollTo: (options: { top: number; behavior?: ScrollBehavior }) => calls.push(options)
    }
    const target = { getBoundingClientRect: () => ({ top: 460 }) }

    scrollChatTargetIntoView(chat, target)

    expect(calls).toEqual([{ top: 664, behavior: 'auto' }])
  })

  it('新建会话只脱离正在运行的会话，不调用 stop', async () => {
    const calls: string[] = []

    await applyNewConversationEffects({
      clearTurns: (options) => calls.push(`clear:${String(options?.preserveRunning)}`),
      newSession: async () => {
        calls.push('newSession')
        return true
      },
      setActiveSessionId: (sessionId) => calls.push(`active:${String(sessionId)}`),
      setView: (view) => calls.push(`view:${view}`),
      focusComposer: () => calls.push('focus')
    })

    expect(calls).toEqual(['clear:undefined', 'newSession', 'active:null', 'view:chat', 'focus'])
  })

  it('剪贴板图片提取会去重 files/items 里的同一张图', () => {
    const png = { name: 'a.png', size: 1, type: 'image/png' } as File
    const text = { name: 'a.txt', size: 1, type: 'text/plain' } as File
    const files = imageFilesFromClipboardData({
      files: [png, text],
      items: [
        { kind: 'file', type: 'image/png', getAsFile: () => png },
        { kind: 'string', type: 'text/plain', getAsFile: () => text }
      ]
    })
    expect(files).toEqual([png])
  })
})

describe('AssistantTurn AskUserQuestion 内联问答', () => {
  const askInput = {
    questions: [
      {
        question: '请选择验证方式',
        header: '验证',
        multiSelect: false,
        options: [
          { label: '自动验证', description: 'A' },
          { label: '手动验证', description: 'B' }
        ]
      },
      {
        question: '请选择需要验证的能力',
        header: '能力',
        multiSelect: true,
        options: [
          { label: 'MCP', description: '验证 MCP' },
          { label: 'Skill', description: '验证 Skill' }
        ]
      }
    ]
  }
  const pendingRequest: AgentQuestionRequest = {
    runId: 'ask-run',
    questionId: 'ask-tool',
    questions: askInput.questions
  }
  const askTurn: Turn = {
    runId: 'ask-run',
    userText: '请提问',
    done: false,
    items: [
      ev({
        id: 'ask-use',
        runId: 'ask-run',
        kind: 'tool',
        stage: 'tool:AskUserQuestion',
        tool: 'AskUserQuestion',
        toolUseId: 'ask-tool',
        input: askInput
      })
    ]
  }

  it('等待态默认展开选择框，不再渲染 dialog 或绿色完成态', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={askTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[pendingRequest]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html).toContain('等待回答')
    expect(html).toContain('type="radio"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('提交并继续')
    expect(html).not.toContain('<dialog')
  })

  it('完成态默认展开并直接显示返回内容，普通工具仍默认收起', () => {
    const completed: Turn = {
      ...askTurn,
      done: true,
      items: [
        ...askTurn.items,
        ev({
          id: 'ask-result',
          runId: 'ask-run',
          kind: 'tool',
          stage: 'tool_result',
          tool: 'AskUserQuestion',
          toolUseId: 'ask-tool',
          text: 'Your questions have been answered: 自动验证; MCP, Skill'
        })
      ]
    }
    const completedHtml = renderToStaticMarkup(
      <AssistantTurn turn={completed} selectedId={null} onSelect={() => {}} />
    )
    const ordinaryHtml = renderToStaticMarkup(<AssistantTurn turn={turn} selectedId={null} onSelect={() => {}} />)

    expect(completedHtml).toContain('已回答')
    expect(completedHtml).toContain('Your questions have been answered: 自动验证; MCP, Skill')
    expect(ordinaryHtml).not.toContain('class="tool-detail"')
  })

  it('只匹配相同 runId 与 toolUseId，避免并行会话串答', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={askTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[{ ...pendingRequest, runId: 'another-run' }]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html).not.toContain('等待回答')
    expect(html).not.toContain('提交并继续')
    expect(html).toContain('等待状态同步')
    expect(html).not.toContain('已回答')
  })

  it('二级 subagent 的 pending Ask 无直接渲染位置时回退为可回答表单', () => {
    const nestedTurn: Turn = {
      runId: 'nested-run',
      userText: '嵌套提问',
      done: false,
      items: [
        ev({
          id: 'parent-task',
          runId: 'nested-run',
          kind: 'agent',
          stage: 'tool:Task',
          tool: 'Task',
          toolUseId: 'parent-task-use'
        }),
        ev({
          id: 'child-task',
          runId: 'nested-run',
          kind: 'agent',
          stage: 'tool:Task',
          tool: 'Task',
          toolUseId: 'child-task-use',
          parentToolUseId: 'parent-task-use'
        }),
        ev({
          id: 'nested-ask',
          runId: 'nested-run',
          kind: 'tool',
          stage: 'tool:AskUserQuestion',
          tool: 'AskUserQuestion',
          toolUseId: 'nested-ask-use',
          parentToolUseId: 'child-task-use',
          input: askInput
        })
      ]
    }
    const html = renderToStaticMarkup(
      <AssistantTurn
        turn={nestedTurn}
        selectedId={null}
        onSelect={() => {}}
        pendingQuestions={[{ ...pendingRequest, runId: 'nested-run', questionId: 'nested-ask-use' }]}
        onAnswerQuestion={async () => {}}
      />
    )

    expect(html.match(/question-inline-form/g)).toHaveLength(1)
    expect(html).toContain('等待回答')
    expect(html).toContain('提交并继续')
  })

  it('已结束但缺失 tool_result 时标记未获得返回，不伪报仍在同步或成功', () => {
    const html = renderToStaticMarkup(
      <AssistantTurn turn={{ ...askTurn, done: true }} selectedId={null} onSelect={() => {}} />
    )

    expect(html).toContain('未获得返回')
    expect(html).not.toContain('等待状态同步')
    expect(html).not.toContain('已回答')
  })
})

describe('OverviewPanel 渲染：verdict 卡 + context + top tools + 文件足迹 + git diff + 累计 + sqlite 分析', () => {
  const billingState = {
    adminConnections: [
      { provider: 'anthropic', envVar: 'ANTHROPIC_ADMIN_API_KEY', configured: false, status: 'missing_key' },
      { provider: 'openai', envVar: 'OPENAI_ADMIN_API_KEY', configured: false, status: 'missing_key' }
    ],
    gatewayConnections: [
      {
        provider: 'anthropic',
        label: 'https://gateway.example.com',
        baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
        tokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
        configured: true,
        status: 'ready',
        sourceKind: 'gateway_reported',
        note: '三方网关已配置；SDK usage 可观测，官方账单仍为 unavailable'
      }
    ],
    rawUsageRows: 2,
    ledgerRows: 3,
    sourceSummaries: [
      {
        source: 'anthropic_gateway_response',
        sourceKind: 'gateway_reported',
        costSource: 'gateway_reported',
        confidence: 'provider_reported',
        rows: 2,
        cost: 0.1275,
        tokens: 2520
      }
    ],
    reconciliation: [
      {
        provider: 'anthropic',
        label: 'anthropic',
        costUnit: 'usd',
        sdkEstimate: 0.5,
        providerReported: 0.1275,
        officialBill: 0,
        officialTelemetry: 0,
        deltaOfficialVsSdk: null,
        confidence: 'provider_reported',
        note: '三方 gateway/provider reported 已导入；official bill unavailable'
      },
      {
        provider: 'codex',
        label: 'codex',
        costUnit: 'usd',
        sdkEstimate: 0,
        providerReported: 0,
        officialBill: 0,
        officialTelemetry: 0,
        deltaOfficialVsSdk: null,
        confidence: 'provider_reported',
        note: 'Codex CLI result rows are tracked under the codex billing provider'
      },
      {
        provider: 'qoder',
        label: 'qoder',
        costUnit: 'usd',
        sdkEstimate: 0,
        providerReported: 0,
        officialBill: 0,
        officialTelemetry: 0,
        deltaOfficialVsSdk: null,
        confidence: 'provider_reported',
        note: 'Qoder CLI result rows are tracked under the qoder billing provider'
      }
    ],
    rollups: [
      {
        granularity: 'day',
        projectKey: '/fixture/sample-workspace',
        model: 'claude-opus-4-8',
        costSource: 'gateway_reported',
        confidence: 'provider_reported',
        rows: 2,
        cost: 0.1275,
        tokens: 2520
      }
    ],
    priceVersions: [
      {
        id: 'price:anthropic:claude-opus-4-8:2026-07',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        currency: 'USD',
        source: 'fixture-contract',
        effectiveFrom: 1782864000000,
        frozenLedgerRows: 2
      }
    ],
    preflight: {
      status: 'refused',
      confidence: 'inferred',
      evidence: 'usage_ledger priced rows=2; history too sparse for PR estimate'
    },
    advice: [
      {
        title: '按项目查看高 Token 窗口',
        detail: '先从最高 day/week rollup 对应项目回看 token-heavy sessions。',
        confidence: 'inferred',
        evidence: 'usage_rollup:day:/fixture/sample-workspace'
      }
    ],
    teamCosts: [
      {
        team: 'platform',
        project: '/fixture/sample-workspace',
        owner: 'billing',
        workflow: 'workflow-orchestrator',
        cost: 0.1275,
        confidence: 'provider_reported'
      }
    ],
    gatewayPolicies: [
      {
        provider: 'anthropic-compatible',
        label: 'fixture gateway policy',
        source: 'gateway-config-import',
        budgetUsd: 25,
        rpm: 120,
        tpm: 200000,
        keysHosted: false
      }
    ],
    sharedReportExport: {
      availableFormats: ['markdown', 'json'],
      plannedFormats: ['csv', 'bi'],
      includesTranscript: false,
      evidence:
        'available markdown report + normalized JSON state; teamCosts=1; usage_ledger rows=3; transcript excluded by default'
    },
    audit: {
      auditRows: 2,
      retentionMode: 'aggregate-only',
      redactionMode: 'secrets-and-prompts',
      contractPriceRows: 1,
      chargebackRows: 1,
      showbackCost: 0.1275
    }
  } satisfies NonNullable<ComponentProps<typeof OverviewPanel>['billingState']>
  const mcpGuardReport: McpGuardReport = {
    schemaVersion: '0.1',
    scan: {
      id: 'scan_fixture',
      tool: 'mcpguard',
      toolVersion: '0.1.0',
      ruleVersion: '2026.07.03',
      startedAt: '2026-07-04T00:00:00.000Z',
      mcpSpecVersion: '2025-11-25',
      mode: 'static',
      offline: true,
      redactionPolicy: 'hash_secret_values_keep_key_names',
      analyzers: [{ name: 'config-static', version: '0.1.0' }]
    },
    targets: [
      {
        targetId: 'target-danger',
        serverName: 'rate-danger',
        client: 'claude',
        scope: 'project',
        transport: 'stdio',
        sourceType: 'local_config',
        sourcePath: '/fixture/sample-workspace/.mcp.json',
        command: 'npx',
        args: ['-y', 'remote-mcp'],
        envKeys: ['ANTHROPIC_AUTH_TOKEN'],
        roots: ['/Users/example'],
        serverDigest: 'sha256:danger',
        toolFingerprints: [
          { name: 'read_all', kind: 'tool', canonicalHash: 'sha256:read', changed: false },
          { name: 'write_all', kind: 'tool', canonicalHash: 'sha256:write', changed: false }
        ],
        enabled: true,
        introspection: { status: 'not_observed', reason: 'static_only' }
      },
      {
        targetId: 'target-safe',
        serverName: 'rate-safe',
        client: 'claude',
        scope: 'user',
        transport: 'stdio',
        sourceType: 'local_config',
        sourcePath: '/Users/example/.claude.json',
        command: '/usr/local/bin/rate-safe',
        args: [],
        envKeys: [],
        roots: [],
        serverDigest: 'sha256:safe',
        toolFingerprints: [{ name: 'search', kind: 'tool', canonicalHash: 'sha256:search', changed: false }],
        enabled: true,
        introspection: { status: 'not_observed', reason: 'static_only' }
      }
    ],
    summary: { status: 'block', critical: 0, high: 1, medium: 1, low: 0, info: 0 },
    sessionAuthPosture: { status: 'not_analyzed', missingAuthCount: null, items: [] },
    findings: [
      {
        findingInstanceId: 'finding-1',
        dedupeKey: 'finding-1',
        fingerprint: 'sha256:finding-1',
        title: 'Runtime package manager in MCP launch path',
        severity: 'high',
        confidence: 'high',
        affectedTargets: [{ targetId: 'target-danger', role: 'subject' }],
        rule: { id: 'MCP-CMD-002', version: '2026.07.03', source: 'mcpguard-rules' },
        category: 'launch',
        firstSeen: null,
        baselineSeen: null,
        evidence: [],
        relationships: [],
        impact: 'Remote code could execute.',
        references: [],
        policy: { profile: 'enterprise-default', decision: 'block', exceptionId: null, allowException: true },
        recommendation: 'Pin the package before launch.'
      },
      {
        findingInstanceId: 'finding-2',
        dedupeKey: 'finding-2',
        fingerprint: 'sha256:finding-2',
        title: 'Sensitive environment key is passed to MCP server',
        severity: 'medium',
        confidence: 'high',
        affectedTargets: [{ targetId: 'target-danger', role: 'subject' }],
        rule: { id: 'MCP-ENV-001', version: '2026.07.03', source: 'mcpguard-rules' },
        category: 'secret',
        firstSeen: null,
        baselineSeen: null,
        evidence: [],
        relationships: [],
        impact: 'Credentials may be exposed.',
        references: [],
        policy: { profile: 'enterprise-default', decision: 'warn', exceptionId: null, allowException: true },
        recommendation: 'Move credentials to a scoped secret store.'
      }
    ],
    audit: {
      reportHash: 'sha256:0123456789abcdef',
      signedBundle: null,
      generatedFor: 'local-only'
    },
    errors: [],
    skipped: [{ targetId: 'target-danger', reason: 'dynamic_introspection_disabled' }]
  }

  const html = renderToStaticMarkup(
    <OverviewPanel
      turns={[turn]}
      sessionId="dea0c990-714d-4888-aed0-7a13952d84ad"
      selected={null}
      onSelect={() => {}}
      gitDiff={[
        { path: '/tmp/probe.txt', added: 5, deleted: 2 },
        { path: '/x/other.ts', added: 1, deleted: 0 }
      ]}
      usage={{ cost: 0.5, tin: 3000, tout: 400, turns: 2 }}
      billingState={billingState}
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
  const billingHtml = renderToStaticMarkup(
    <OverviewPanel
      turns={[turn]}
      initialPanelTab="billing"
      selected={null}
      onSelect={() => {}}
      usage={null}
      stats={null}
      billingState={billingState}
    />
  )
  const billingNoStateHtml = renderToStaticMarkup(
    <OverviewPanel turns={[turn]} initialPanelTab="billing" selected={null} onSelect={() => {}} usage={null} stats={null} />
  )
  const partialBillingState = { ...billingState } as Record<string, unknown>
  delete partialBillingState.audit
  delete partialBillingState.preflight
  delete partialBillingState.sharedReportExport
  delete partialBillingState.reconciliation
  delete partialBillingState.gatewayPolicies
  const billingPartialStateHtml = renderToStaticMarkup(
    <OverviewPanel
      turns={[turn]}
      initialPanelTab="billing"
      selected={null}
      onSelect={() => {}}
      usage={null}
      stats={null}
      billingState={partialBillingState as unknown as ComponentProps<typeof OverviewPanel>['billingState']}
    />
  )
  const mcpTrustEmptyHtml = renderToStaticMarkup(
    <OverviewPanel
      turns={[turn]}
      initialPanelTab="mcpTrust"
      selected={null}
      onSelect={() => {}}
      usage={null}
      stats={null}
      mcpLive={[
        { name: 'rate-danger', status: 'needs-auth' },
        { name: 'rate-broken', status: 'failed', tools: 0 }
      ]}
      mcps={[{ name: 'rate-danger', scope: 'project', transport: 'stdio', detail: 'npx remote-mcp', enabled: true }]}
    />
  )
  const mcpTrustReportHtml = renderToStaticMarkup(
    <McpTrustPanel
      report={mcpGuardReport}
      mcpLive={[{ name: 'rate-danger', status: 'needs-auth', tools: 2 }]}
      mcps={[{ name: 'rate-danger', scope: 'project', transport: 'stdio', detail: 'npx remote-mcp', enabled: true }]}
    />
  )
  const mcpTrustScanningHtml = renderToStaticMarkup(
    <McpTrustPanel
      scanning
      refreshing
      onScan={async () => mcpGuardReport}
      onRefreshLive={async () => {}}
      onReportChange={() => {}}
      mcpLive={[]}
      mcps={[]}
    />
  )
  const qoderMcpTrustEmptyHtml = renderToStaticMarkup(
    <McpTrustPanel
      runtimeProvider="qoder_cli"
      mcpLive={[]}
      mcps={[{ name: 'rate-danger', scope: 'project', transport: 'stdio', detail: 'npx remote-mcp', enabled: true }]}
    />
  )

  it('verdict 卡：聚合 token + 无报错无危险 → 判决"完成"（非假绿前提下的 ok 态）', () => {
    expect(html).toContain('3.0k tok') // 跨轮累计本会话 token（含 cache）
    expect(html).not.toContain('$0.1234')
    expect(html).toContain('本会话 · 1 轮') // 会话标签（不造假 sess_id）
    expect(html).toContain('judgement ok') // 无 error/danger → ok
    expect(html).toContain('完成')
    expect(html).toContain('verdict-foot') // cache·r/cache·w/api foot
  })

  it('历史会话合并 archive 与 transcript usage 时仍按用户 turn 展示轮数', () => {
    const mergedTurn: Turn = {
      runId: 'merged',
      userText: 'merged history',
      done: true,
      items: [
        ev({
          id: 'archive-result',
          runId: 'merged',
          kind: 'harness',
          stage: 'result',
          text: 'final answer',
          tokensIn: 10,
          tokensOut: 5,
          cacheReadTokens: 20,
          runtimeProvider: 'claude_sdk'
        }),
        ev({
          id: 'transcript-usage',
          runId: 'session',
          kind: 'harness',
          stage: 'result',
          text: 'transcript assistant usage',
          tokensIn: 3,
          tokensOut: 2,
          cacheCreationTokens: 7
        })
      ]
    }
    const mergedHtml = renderToStaticMarkup(
      <OverviewPanel turns={[mergedTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(mergedHtml).toContain('本会话 · 1 轮')
    expect(mergedHtml).toContain('1 轮完成')
    expect(mergedHtml).toContain('1/1 轮已捕获')
    expect(mergedHtml).toContain('35 tok')
    expect(mergedHtml).not.toContain('47 tok')
  })

  it('上下文段：最近一轮占用 ÷ 窗口（诚实单条，不伪造三色分段）', () => {
    expect(html).toContain('上下文')
    expect(html).toContain('claude-opus-4-8')
    expect(html).toContain('87.0k / 200.0k')
    expect(html).toContain('已占 44%')
  })

  it('上下文缺少占用或窗口任一字段时保持未知，不拼出假比例', () => {
    const missingWindow: Turn = {
      runId: 'missing-window',
      userText: 'x',
      done: true,
      items: [
        ev({
          id: 'missing-window-result',
          kind: 'harness',
          stage: 'result',
          contextTokens: 50_000,
          modelUsage: [{ model: 'unknown-window' }]
        })
      ]
    }
    const missingContext: Turn = {
      runId: 'missing-context',
      userText: 'x',
      done: true,
      items: [
        ev({
          id: 'missing-context-result',
          kind: 'harness',
          stage: 'result',
          modelUsage: [{ model: 'known-window', contextWindow: 200_000 }]
        })
      ]
    }
    const unknownHtml = renderToStaticMarkup(
      <OverviewPanel turns={[missingWindow, missingContext]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(unknownHtml).toContain('暂无上下文数据')
    expect(unknownHtml).not.toContain('50.0k / 200.0k')
    expect(unknownHtml).not.toContain('已占 25%')
  })

  it('TOP TOOLS 段：tool+mcp 合并排名 + mini-bar', () => {
    expect(html).toContain('TOP TOOLS')
    expect(html).toContain('工具 3 · MCP 0') // 普通工具与 MCP 分开，不混入 Skill/子Agent
    expect(html).toContain('mini-bar')
    expect(html).toContain('Read')
  })

  it('每轮调用段：按 turn 聚合工具并可跳回该轮用户消息', () => {
    expect(html).toContain('每轮调用')
    expect(html).toContain('1 turns')
    expect(html).toContain('aria-label="跳到第 1 轮，对话中共 3 次工具/Skill/MCP/子 Agent 调用，耗时 3m 12s"')
    expect(html).toContain('创建并读回文件')
    expect(html).toContain('3 次调用')
    expect(html).toContain('耗时 3m 12s')
    expect(html).toContain('title="整轮墙钟耗时 3m 12s；其中 API 耗时 5.0s"')
    expect(html.match(/aria-label="展开第 1 轮耗时明细"/g)).toHaveLength(2)
    expect(html.match(/aria-controls="turn-timing-1"/g)).toHaveLength(2)
    expect(html).toContain('点 Txx 跳回该轮，点耗时或右侧箭头展开/收起明细')
    expect(html).toContain('turn-call-group tool')
    expect(html).toContain('Bash')
    expect(html).toContain('Write')
    expect(html).toContain('Read')
  })

  it('纵览按轮次与会话拆成二级 tab，并把会话汇总放入会话数据', () => {
    const tabHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[{
          ...turn,
          items: [
            ev({ id: 'tab-skill', kind: 'skill', stage: 'skill:workflow', name: 'workflow' }),
            ...turn.items
          ]
        }]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )
    const turnsPanel = tabHtml.slice(tabHtml.indexOf('id="overview-turns-panel"'), tabHtml.indexOf('id="overview-session-panel"'))
    const sessionPanel = tabHtml.slice(tabHtml.indexOf('id="overview-session-panel"'))

    expect(tabHtml).toContain('aria-label="纵览数据维度"')
    expect(tabHtml).toMatch(/id="overview-turns-tab"[^>]*aria-selected="true"/)
    expect(tabHtml).toMatch(/id="overview-session-tab"[^>]*aria-selected="false"/)
    expect(turnsPanel).toContain('每轮调用')
    expect(turnsPanel).not.toContain('TOP TOOLS')
    expect(turnsPanel).not.toContain('HOOKS')
    expect(turnsPanel).not.toContain('段落（按 skill）')
    expect(turnsPanel).not.toContain('调用明细（本会话）')
    expect(turnsPanel).not.toContain('文件足迹（全会话 · 工具证据）')
    expect(sessionPanel).toContain('hidden=""')
    expect(sessionPanel).toContain('TOP TOOLS')
    expect(sessionPanel).toContain('HOOKS')
    expect(sessionPanel).toContain('段落（按 skill）')
    expect(sessionPanel).toContain('调用明细（本会话）')
    expect(sessionPanel).toContain('文件足迹（全会话 · 工具证据）')
  })

  it('每轮调用段把一条 shell 中的多个 MCP 调用分别计数', () => {
    const multiMcpTurn: Turn = {
      runId: 'multi-mcp-turn',
      userText: '查询工单详情',
      done: true,
      items: [
        ev({
          id: 'multi-mcp-shell',
          runId: 'multi-mcp-turn',
          kind: 'tool',
          stage: 'tool:Bash',
          tool: 'Bash',
          isMcp: true,
          mcpCalls: [
            { server: 'coop', action: 'query_workitem_detail', tool: 'mcporter:coop.query_workitem_detail' },
            { server: 'coop', action: 'get_workitem_comments', tool: 'mcporter:coop.get_workitem_comments' }
          ]
        }),
        ev({ id: 'multi-mcp-result', runId: 'multi-mcp-turn', kind: 'harness', stage: 'result' })
      ]
    }
    const multiMcpHtml = renderToStaticMarkup(
      <OverviewPanel turns={[multiMcpTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    const turnCalls = multiMcpHtml.slice(multiMcpHtml.indexOf('turn-call-list'), multiMcpHtml.indexOf('按每轮逻辑调用聚合'))

    expect(turnCalls).toContain('2 次调用')
    expect(turnCalls).toContain('turn-call-count">2</span>')
  })

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
    const turnCalls = skillHtml.slice(skillHtml.indexOf('turn-call-list'), skillHtml.indexOf('按每轮逻辑调用聚合'))
    expect(turnCalls).toContain('2 次调用')
    expect(turnCalls).toContain('turn-call-group turn-call-toggle skill')
    expect(turnCalls).toContain('turn-call-count">2</span>')
  })

  it('每轮 Skill 明细按首次调用顺序展示，不按次数或名称重排', () => {
    const rows = turnCallRowsFromMap(new Map([
      ['rate-native-rate-workflow', 1],
      ['rate-workflow', 1],
      ['browser-harness', 2],
      ['rate-native-rate-doc', 1],
      ['rate-doc', 1],
      ['ali-config', 1]
    ]), true)

    expect(rows.map((row) => row.name)).toEqual([
      'rate-native-rate-workflow',
      'rate-workflow',
      'browser-harness',
      'rate-native-rate-doc',
      'rate-doc',
      'ali-config'
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
    expect(rowsHtml).toContain('0 次调用')
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

  it('HOOKS 段：失败 hook 行内展示最近失败原因', () => {
    const failedTurn: Turn = {
      ...turn,
      items: [
        ev({
          id: 'e-hook-fail',
          kind: 'hook',
          stage: 'hook_response',
          tool: 'PreToolUse:Bash',
          name: 'PreToolUse',
          hookName: 'PreToolUse:Bash',
          hookEvent: 'PreToolUse',
          hookCommand: '$CLAUDE_PROJECT_DIR/.claude/scripts/branch-check-hook.sh',
          hookOutcome: 'error',
          hookExitCode: 2,
          input: { stderr: 'branch mismatch: expected feature/x', exitCode: 2 },
          isError: true
        })
      ]
    }
    const failedHtml = renderToStaticMarkup(
      <OverviewPanel turns={[failedTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    expect(failedHtml).toContain('最近失败')
    expect(failedHtml).toContain('exit 2: branch mismatch: expected feature/x')
    expect(failedHtml).toContain('失败 1 · 2')
  })

  it('HOOKS 段：部分取消时分开展示成功和取消数量，不把总执行数冒充取消数', () => {
    const items: TraceEvent[] = []
    for (let i = 0; i < 447; i++) {
      items.push(ev({
        id: `hook-start-${i}`,
        kind: 'hook',
        stage: 'hook_started',
        hookId: `hook-${i}`,
        hookName: 'PostToolUse:Bash',
        hookEvent: 'PostToolUse'
      }))
      items.push(ev({
        id: `hook-response-${i}`,
        kind: 'hook',
        stage: 'hook_response',
        hookId: `hook-${i}`,
        hookName: 'PostToolUse:Bash',
        hookEvent: 'PostToolUse',
        hookOutcome: i < 21 ? 'cancelled' : 'success',
        hookExitCode: 0
      }))
    }
    const partialHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[{ runId: 'hook-partial', userText: '执行 Bash', done: true, items }]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )

    expect(partialHtml).toContain('447 次执行')
    expect(partialHtml).toContain('894 条事件')
    expect(partialHtml).toContain('成功 426 · 取消 21')
    expect(partialHtml).toContain('hook-status warn">取消 21')
    expect(partialHtml).not.toContain('部分取消 · 447×')
    expect(partialHtml).not.toContain('成功 426 · 0')
  })

  it('GIT DIFF 段：独立成段 + 工具足迹对照（check 碰过 / alert 未碰）', () => {
    expect(html).toContain('GIT DIFF')
    expect(html).toContain('2 files · +6 −2')
    expect(html).toContain('gd-add') // probe.txt 在工具足迹内
    expect(html).toContain('gd-del') // other.ts 被改但工具没碰过
  })

  it('总览不展示 sqlite 跨会话分析，避免和当前会话总览混杂', () => {
    expect(html).not.toContain('跨会话分析')
    expect(html).not.toContain('最常用工具')
    expect(html).not.toContain('按目录估算成本')
    expect(html).not.toContain('按模型 token / 估算成本')
    expect(html).not.toContain('工具耗时 / 失败')
    expect(html).not.toContain('危险操作（跨会话审计）')
    expect(html).not.toContain('claude-opus-4-8[1m]')
  })

  it('调用明细：drill-down 保留 + 空态如实标注（反假数据：区分零与缺失）', () => {
    expect(html).toContain('调用明细')
    // 本例无 skill / mcp：必须显式标「无」而不是静默隐藏
    expect(html).toContain('本会话无 Skill 调用')
    expect(html).toContain('本会话无 MCP 调用')
  })

  it('累计用量来自持久化', () => {
    expect(html).toContain('累计 Token 用量')
    expect(html).toContain('3.4k tok')
    expect(html).not.toContain('$0.5000')
  })

  it('总览不展示事件详情；选中工具只影响对话区高亮', () => {
    const selectedHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[turn]}
        sessionId="dea0c990-714d-4888-aed0-7a13952d84ad"
        selected={turn.items[2]}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )
    expect(html).not.toContain('EVENT · 选中')
    expect(html).not.toContain('事件详情')
    expect(html).not.toContain('点对话里的工具 / 思考节点看详情')
    expect(selectedHtml).not.toContain('事件详情')
    expect(selectedHtml).not.toContain('tool · Write')
    expect(selectedHtml).not.toContain('input（工具入参）')
  })

  it('会话段展示当前会话 sessionId', () => {
    expect(html).toContain('会话')
    expect(html).toContain('dea0c990-714d-4888-aed0-7a13952d84ad')
  })

  it('面板 tab：默认展示纵览，账单卫士内容收进独立 tab', () => {
    expect(html).toContain('面板视图')
    expect(html).toContain('纵览')
    expect(html).toContain('账单卫士')
    expect(html).toContain('MCP 信任')
    expect(html).not.toContain('BILLING GUARDIAN')
    expect(html).not.toContain('Source reconciliation')
    expect(html).not.toContain('尚未导入扫描报告')
    expect(html).not.toContain('class="ov-title"')
    expect(html).not.toContain('session dea0c990')
  })

  it('账单卫士 tab：标题、口径和默认异常空态尽量中文展示', () => {
    expect(billingHtml).toContain('账单卫士')
    expect(billingHtml).toContain('本会话可验证 token')
    expect(billingHtml).toContain('仅看 token，不算金额')
    expect(billingHtml).toContain('总 Token')
    expect(billingHtml).toContain('缓存读/写')
    expect(billingHtml).toContain('轮次覆盖')
    expect(billingHtml).toContain('模型明细')
    expect(billingHtml).toContain('工具拆分')
    expect(billingHtml).toContain('暂无独立 token')
    expect(billingHtml).not.toContain('工具级精确分摊')
    expect(billingHtml).not.toContain('未分摊 token')
    expect(billingHtml).not.toContain('工作流未精确归因')
    expect(billingHtml).toContain('暂无符合规则的 token/上下文提示')
    expect(billingHtml).not.toContain('BILLING GUARDIAN')
    expect(billingHtml).not.toContain('known est.')
  })

  it('账单卫士 tab：token 口径下移除来源对账和网关/Admin 操作入口', () => {
    expect(billingHtml).not.toContain('来源对账')
    expect(billingHtml).not.toContain('3 条账本记录')
    expect(billingHtml).not.toContain('金额对账字段已隐藏')
    expect(billingHtml).not.toContain('token 口径观察本地 usage')
    expect(billingHtml).not.toContain('Anthropic 网关')
    expect(billingHtml).not.toContain('anthropic_gateway_response')
    expect(billingHtml).not.toContain('同步 Admin 数据')
    expect(billingHtml).not.toContain('导入网关示例数据')
    expect(billingHtml).not.toContain('Source reconciliation')
    expect(billingHtml).not.toContain('Load gateway fixture')
  })

  it('账单卫士 tab：billingState 尚未加载时保留本地估算视图，不伪造对账数据', () => {
    expect(billingNoStateHtml).toContain('账单卫士')
    expect(billingNoStateHtml).toContain('本会话可验证 token')
    expect(billingNoStateHtml).toContain('高 Token 轮次')
    expect(billingNoStateHtml).not.toContain('来源对账')
  })

  it('账单卫士 tab：partial billingState 不影响右栏会话视图，不补假治理状态', () => {
    expect(billingPartialStateHtml).not.toContain('状态未知 · 缺少 preflight 字段')
    expect(billingPartialStateHtml).not.toContain('状态未知 · 缺少 sharedReportExport 字段')
    expect(billingPartialStateHtml).not.toContain('审计/合约价/分摊状态未知；账单卫士状态缺少 audit 字段。')
    expect(billingPartialStateHtml).not.toContain('网关策略状态未知；账单卫士状态缺少 gatewayPolicies 字段。')
    expect(billingPartialStateHtml).not.toContain('审计日志</span><span class="dim">0 行')
    expect(billingPartialStateHtml).not.toContain('合约价导入</span><span class="dim">0 行')
    expect(billingPartialStateHtml).not.toContain('分摊 / 展示账单</span><span class="dim">0 行 · $0.0000')
    expect(billingPartialStateHtml).not.toContain('已支持  · 计划  · 对话 不含')
    expect(billingPartialStateHtml).not.toContain('暂无网关/供应商上报或官方 Admin 数据；当前只有本地 SDK 估算。')
    expect(billingPartialStateHtml).not.toContain('暂无网关策略/配置导入；Scry 不托管网关密钥。')
  })

  it('账单卫士 tab：只展示本会话高 Token 轮次，不展示 Token 关联线索', () => {
    expect(billingHtml).toContain('高 Token 轮次')
    expect(billingHtml).toContain('role="button"')
    expect(billingHtml).toContain('tabindex="0"')
    expect(billingHtml).toContain('点跳到这轮对话')
    expect(billingHtml).toContain('aria-label="跳到第 1 轮对话，总 Token 3.0k tok"')
    expect(billingHtml).toContain('class="billing-token-table"')
    expect(billingHtml).toContain('缓存命中率')
    expect(billingHtml).toContain('输入/输出')
    expect(billingHtml).toContain('缓存读写')
    expect(billingHtml).toContain('T01')
    expect(billingHtml).toContain('35.7%')
    expect(billingHtml).toContain('1.7k')
    expect(billingHtml).toContain('1.3k')
    expect(billingHtml).toContain('44%')
    expect(billingHtml).not.toContain('Token 关联线索')
    expect(billingHtml).not.toContain('缓存占大头')
    expect(billingHtml).not.toContain('输入/输出 1.7k')
    expect(billingHtml).not.toContain('缓存读写 1.3k')
    expect(billingHtml).not.toContain('工具 3 次')
    expect(billingHtml).not.toContain('in/out 1.7k')
    expect(billingHtml).not.toContain('cache 1.3k')
    expect(billingHtml).not.toContain('不能相加，不是工具自身用量')
    expect(billingHtml).not.toContain('同轮关联')
    expect(billingHtml).not.toContain('所在轮次 token')
    expect(billingHtml).not.toContain('归因方法=按轮次关联')
    expect(billingHtml).not.toContain('Top cost turns')
    expect(billingHtml).not.toContain('Related evidence')
  })

  it('账单卫士 tab：移除个人分析、模型和企业治理噪音', () => {
    expect(billingHtml).not.toContain('个人分析')
    expect(billingHtml).not.toContain('价格冻结')
    expect(billingHtml).not.toContain('PR 预估')
    expect(billingHtml).not.toContain('数据不足 · 推断')
    expect(billingHtml).not.toContain('模型用量')
    expect(billingHtml).not.toContain('团队与网关')
    expect(billingHtml).not.toContain('fixture gateway policy')
    expect(billingHtml).not.toContain('密钥托管 否')
    expect(billingHtml).not.toContain('共享报告导出')
    expect(billingHtml).not.toContain('已支持 markdown/json')
    expect(billingHtml).not.toContain('计划 csv/bi')
    expect(billingHtml).not.toContain('对话 不含')
    expect(billingHtml).not.toContain('审计与分摊')
    expect(billingHtml).not.toContain('留存 / 脱敏')
    expect(billingHtml).not.toContain('仅聚合 · 密钥和 prompt 脱敏')
    expect(billingHtml).not.toContain('分摊 / 展示账单')
    expect(billingHtml).not.toContain('Team &amp; gateway')
    expect(billingHtml).not.toContain('Audit &amp; showback')
  })

  it('MCP 信任 tab：会话授权缺口独立展示，不伪造扫描报告', () => {
    expect(mcpTrustEmptyHtml).toContain('MCP 信任')
    expect(mcpTrustEmptyHtml).toContain('运行时 MCP')
    expect(mcpTrustEmptyHtml).toContain('1 个 MCP server 需要授权')
    expect(mcpTrustEmptyHtml).toContain('rate-danger')
    expect(mcpTrustEmptyHtml).toContain('需授权')
    expect(mcpTrustEmptyHtml).toContain('rate-broken')
    expect(mcpTrustEmptyHtml).toContain('失败')
    expect(mcpTrustEmptyHtml).toContain('刷新 MCP 状态')
    expect(mcpTrustEmptyHtml).toContain('扫描当前 MCP')
    expect(mcpTrustEmptyHtml).not.toContain('尚未导入扫描报告')
    expect(mcpTrustEmptyHtml).not.toContain('导入 mcpguard JSON')
    expect(mcpTrustEmptyHtml).not.toContain('第三方证据标签 · 非官方认证')
    expect(mcpTrustEmptyHtml).not.toContain('Fleet inventory')
  })

  it('MCP 信任 tab：Qoder 空 live 不展示 Claude 配置静默差异', () => {
    expect(qoderMcpTrustEmptyHtml).toContain('Qoder 暂无逐项 MCP live 状态')
    expect(qoderMcpTrustEmptyHtml).not.toContain('配置中启用但未被当前运行时 live 捕获')
    expect(qoderMcpTrustEmptyHtml).not.toContain('rate-danger')
  })

  it('MCP 信任 tab：一键扫描有独立加载态，不再展示手动导入入口', () => {
    expect(mcpTrustScanningHtml).toContain('刷新中…')
    expect(mcpTrustScanningHtml).toContain('扫描中…')
    expect(mcpTrustScanningHtml).not.toContain('导入 mcpguard JSON')
    expect(mcpTrustScanningHtml).not.toContain('尚未导入扫描报告')
  })

  it('MCP 信任 tab：有 mcpguard 报告后展示 P3 风险治理和 P4 证据标签', () => {
    expect(mcpTrustReportHtml).toContain('策略状态')
    expect(mcpTrustReportHtml).toContain('阻断')
    expect(mcpTrustReportHtml).toContain('高危发现')
    expect(mcpTrustReportHtml).toContain('MCP-CMD-002')
    expect(mcpTrustReportHtml).toContain('rate-danger')
    expect(mcpTrustReportHtml).toContain('Fleet inventory')
    expect(mcpTrustReportHtml).toContain('scanned')
    expect(mcpTrustReportHtml).toContain('policy-pass')
    expect(mcpTrustReportHtml).toContain('sandbox-ready')
    expect(mcpTrustReportHtml).toContain('supply-chain-reviewed')
    expect(mcpTrustReportHtml).toContain('标签只代表报告证据，不是官方认证')
    expect(mcpTrustReportHtml).toContain('会话授权姿态')
    expect(mcpTrustReportHtml).toContain('not_analyzed')
    expect(mcpTrustReportHtml).not.toContain('官方认证通过')
  })

  it('MCP 信任 tab：报告状态由 App 层按 cwd 归属，切 tab 不丢、切 cwd 不串', () => {
    let reportsByCwd: Record<string, McpGuardReport> = {}
    const scryCwd = '/a/scry'
    const sampleWorkspaceCwd = '/b/sample-workspace'
    const sampleWorkspaceReport: McpGuardReport = {
      ...mcpGuardReport,
      scan: { ...mcpGuardReport.scan, id: 'scan_sample_workspace' },
      targets: [{ ...mcpGuardReport.targets[1], targetId: 'target-sample-workspace', serverName: 'sample-workspace-safe' }],
      summary: { status: 'pass', critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: []
    }

    reportsByCwd = setMcpGuardReportForCwd(reportsByCwd, scryCwd, mcpGuardReport)
    const afterTabSwitch = reportsByCwd

    expect(getMcpGuardReportForCwd(afterTabSwitch, scryCwd)).toBe(mcpGuardReport)
    expect(getMcpGuardReportForCwd(afterTabSwitch, sampleWorkspaceCwd)).toBeNull()

    reportsByCwd = setMcpGuardReportForCwd(reportsByCwd, sampleWorkspaceCwd, sampleWorkspaceReport)
    expect(getMcpGuardReportForCwd(reportsByCwd, sampleWorkspaceCwd)).toBe(sampleWorkspaceReport)
    expect(getMcpGuardReportForCwd(reportsByCwd, scryCwd)).toBe(mcpGuardReport)

    const overviewReportHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[turn]}
        initialPanelTab="mcpTrust"
        mcpGuardReport={getMcpGuardReportForCwd(reportsByCwd, scryCwd)}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        mcpLive={[{ name: 'rate-danger', status: 'needs-auth', tools: 2 }]}
        mcps={[{ name: 'rate-danger', scope: 'project', transport: 'stdio', detail: 'npx remote-mcp', enabled: true }]}
      />
    )
    expect(overviewReportHtml).toContain('Fleet inventory')
    expect(overviewReportHtml).toContain('MCP-CMD-002')

    const overviewOtherCwdHtml = renderToStaticMarkup(
      <OverviewPanel
        turns={[turn]}
        initialPanelTab="mcpTrust"
        mcpGuardReport={getMcpGuardReportForCwd(reportsByCwd, '/empty-project')}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        mcpLive={[{ name: 'sample-workspace-safe', status: 'connected', tools: 1 }]}
        mcps={[{ name: 'sample-workspace-safe', scope: 'project', transport: 'stdio', detail: 'sample-workspace-safe', enabled: true }]}
      />
    )
    expect(overviewOtherCwdHtml).not.toContain('尚未导入扫描报告')
    expect(overviewOtherCwdHtml).not.toContain('MCP-CMD-002')
    expect(overviewOtherCwdHtml).not.toContain('Fleet inventory')

    const controlledEmptyHtml = renderToStaticMarkup(
      <McpTrustPanel
        report={null}
        mcpLive={[{ name: 'rate-safe', status: 'connected', tools: 1 }]}
        mcps={[{ name: 'rate-safe', scope: 'project', transport: 'stdio', detail: 'rate-safe', enabled: true }]}
      />
    )
    expect(controlledEmptyHtml).not.toContain('尚未导入扫描报告')
    expect(controlledEmptyHtml).not.toContain('MCP-CMD-002')
    expect(controlledEmptyHtml).not.toContain('Fleet inventory')
  })

  it('全会话文件足迹列出文件', () => {
    expect(html).toContain('文件足迹')
    expect(html).toContain('probe.txt')
    expect(html).not.toContain('Bash 触及')
    expect(html).toContain('bash-only.txt')
    expect(html).toContain('~R1')
  })

  it('总览不渲染 sqlite 跨会话工具和目录排行', () => {
    expect(html).not.toContain('proj-x')
    expect(html).not.toContain('sqlite')
  })
})

describe('OverviewPanel verdict 诚实态：error 不显绿 / danger→bad / busy→运行中 / 不冒充"blocked"', () => {
  const panel = (t: Turn, busy = false): string =>
    renderToStaticMarkup(
      <OverviewPanel turns={[t]} selected={null} onSelect={() => {}} usage={null} stats={null} busy={busy} />
    )
  const dangerTurn = (): { t: Turn; dangerEv: TraceEvent } => {
    const dangerEv = ev({
      id: 'td1',
      kind: 'tool',
      stage: 'tool:Bash',
      tool: 'Bash',
      toolUseId: 'td1',
      danger: { level: 'danger', reason: 'rm -rf 强删' }
    })
    return {
      dangerEv,
      t: {
        runId: 'dg',
        userText: 'x',
        done: true,
        items: [dangerEv, ev({ id: 'td2', kind: 'harness', stage: 'result', costUsd: 0.01, tokensIn: 10, tokensOut: 5 })]
      }
    }
  }

  it('有工具报错 → 判决 warn，绝不显示绿色 ok', () => {
    const t: Turn = {
      runId: 'er',
      userText: 'x',
      done: true,
      items: [
        ev({ id: 'te1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu1' }),
        ev({ id: 'te2', kind: 'tool', stage: 'tool_result', toolUseId: 'tu1', isError: true, output: 'boom' }),
        ev({ id: 'te3', kind: 'harness', stage: 'result', costUsd: 0.01, tokensIn: 10, tokensOut: 5 })
      ]
    }
    const html = panel(t)
    expect(html).toContain('judgement warn')
    expect(html).toContain('处工具报错')
    expect(html).not.toContain('judgement ok') // 失败会话顶绿色健康判决 = 假状态
  })

  it('高危操作 → 卡 bad + 判决 bad + 危险 pillar 标"审计·未拦截"（非 blocked）', () => {
    const { t } = dangerTurn()
    const html = panel(t)
    expect(html).toContain('verdict-card bad')
    expect(html).toContain('judgement bad')
    expect(html).toContain('1 处高危操作')
    expect(html).toContain('rm -rf 强删')
    expect(html).toContain('审计·未拦截') // P3 是观测不拦截，诚实标注
    expect(html).toContain('class="verdict-pillar verdict-pillar-action bad"')
    expect(html).toContain('aria-label="查看本会话 1 处危险操作"')
    expect(html).toContain('class="panel-section danger-audit-section"')
    expect(html).toContain('class="callrow danger-audit-row"')
    expect(html).toContain('aria-label="跳到左侧对话中的这次 Bash 调用：rm -rf 强删"')
    expect(html).not.toContain('blocked') // 不冒充蓝本 demo 的"已阻断"语义
  })

  it('移除冗余 topbar 状态行后，判决卡仍使用真实会话 verdict', () => {
    const { t, dangerEv } = dangerTurn()
    const html = renderToStaticMarkup(
      <OverviewPanel turns={[t]} selected={dangerEv} onSelect={() => {}} usage={null} stats={null} />
    )
    expect(html).toContain('<div class="judgement bad"><span class="sdot bad"></span>1 处高危操作</div>')
    expect(html).not.toContain('title="会话状态')
  })

  it('busy → 静态运行中状态（仅在真 busy 时）', () => {
    const t: Turn = {
      runId: 'rn',
      userText: 'x',
      done: false,
      items: [ev({ id: 'rn1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'r1' })]
    }
    const html = panel(t, true)
    expect(html).toContain('运行中')
    expect(html).toContain('运行中')
    expect(html).toContain('judgement warn')
  })
})

describe('OverviewPanel 保留段：段落保留，用量报告和诊断不进总览', () => {
  // 独立 fixture（带 skill 事件 + diag）——别加进主 fixture，否则破坏"本会话无 Skill 调用"断言
  const skillTurn: Turn = {
    runId: 'sk',
    userText: 'x',
    done: true,
    items: [
      ev({ id: 's1', kind: 'skill', stage: 'skill:humanizer', name: 'humanizer' }),
      ev({ id: 's2', kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/a/b.ts' }),
      ev({
        id: 's-mcp',
        kind: 'tool',
        stage: 'tool:mcp__tracker__call',
        tool: 'mcp__tracker__call',
        isMcp: true,
        mcpServer: 'tracker',
        mcpAction: 'call',
        mcpTool: 'mcp__tracker__call'
      }),
      ev({ id: 's-agent', kind: 'agent', stage: 'agent:general-purpose', name: 'general-purpose' }),
      ev({ id: 's3', kind: 'harness', stage: 'result', costUsd: 0.02, tokensIn: 50, tokensOut: 10 })
    ]
  }
  const html = renderToStaticMarkup(
    <OverviewPanel
      turns={[skillTurn]}
      selected={null}
      onSelect={() => {}}
      usage={null}
      stats={null}
      diag={{ sdkVersion: '^0.3.186', settingSources: 'none', claudeVersion: '2.1.170' }}
    />
  )

  it('段落（按 skill）保留', () => {
    expect(html).toContain('段落（按 skill）')
    expect(html).toContain('humanizer')
  })

  it('段落指标区分普通工具和子 agent', () => {
    const segmentHtml = html.slice(html.indexOf('segment-list'), html.indexOf('按实际 skill 调用切段'))
    expect(html).toContain('segment-list')
    expect(html).toContain('seg-chip tool')
    expect(html).toContain('seg-chip agent')
    expect(html).toContain('<span>工具</span>')
    expect(html).toContain('<span>子Agent</span>')
    expect(html).toContain('<span>读</span>')
    expect(html).toContain('子 agent / Task 调用数')
    expect(html).toContain('结构化读文件次数')
    expect(segmentHtml).not.toContain('R1')
  })

  it('每轮调用区分工具、MCP、Skill 和子 Agent；MCP/Skill 默认只显示数量', () => {
    const turnCallHtml = html.slice(html.indexOf('turn-call-list'), html.indexOf('按每轮逻辑调用聚合'))
    expect(html).toContain('每轮调用')
    expect(html).toContain('4 次调用')
    expect(turnCallHtml).toContain('turn-call-group tool')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle mcp')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle skill')
    expect(turnCallHtml).toContain('turn-call-group agent')
    expect(turnCallHtml).toContain('aria-expanded="false"')
    expect(turnCallHtml).toContain('turn-call-count">1</span>')
    expect(turnCallHtml).toContain('Read')
    expect(turnCallHtml).toContain('general-purpose')
    expect(turnCallHtml).not.toContain('humanizer')
    expect(turnCallHtml).not.toContain('tracker.call')
  })

  it('会话总调用拆分为工具、MCP、Skill、子 Agent，四项之和等于总数', () => {
    expect(html).toContain('4 次调用')
    expect(html).toContain('调用</div><div class="v">4</div>')
    expect(html).toContain('工具 1 · MCP 1 · Skill 1 · 子Agent 1')
    expect(html).toContain('TOP TOOLS<span class="more">工具 1 · MCP 1</span>')
  })

  it('诊断不在总览展示', () => {
    expect(html).not.toContain('诊断')
    expect(html).not.toContain('SDK 版本')
    expect(html).not.toContain('2.1.170')
  })

  it('用量报告不在总览展示', () => {
    expect(html).not.toContain('用量报告')
    expect(html).not.toContain('复制 Markdown')
    expect(html).not.toContain('本会话 token 用量解释')
  })
})

import { ExecutionGraph } from './ExecutionGraph'

describe('ExecutionGraph 渲染：调用拓扑树', () => {
  it('按 Turn / llm_request 分组渲染工具节点，subagent 嵌套', () => {
    const t: Turn = {
      runId: 'run-x',
      userText: 'x',
      done: true,
      items: [
        ev({ id: 'm1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu-bash', messageId: 'msg_1' }),
        ev({ id: 'm2', kind: 'agent', stage: 'agent:general-purpose', name: 'general-purpose', tool: 'Agent', toolUseId: 'tu-agent', messageId: 'msg_1' }),
        // subagent 子步骤：parentToolUseId 指向 Agent 的 toolUseId
        ev({ id: 'm3', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'tu-sub', parentToolUseId: 'tu-agent', messageId: 'msg_2' }),
        ev({ id: 'r', kind: 'harness', stage: 'result', costUsd: 0.5, tokensIn: 100, tokensOut: 20 })
      ]
    }
    const html = renderToStaticMarkup(<ExecutionGraph turns={[t]} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain('TURN 01') // turn-head
    expect(html).toContain('LLM') // llm_request 节点 gtype 徽章
    expect(html).toContain('Bash')
    expect(html).toContain('general-purpose') // 子 agent 节点
    expect(html).toContain('SUBAGENT') // subagent gtype 徽章
    expect(html).toContain('120 tok') // turn-head token
    expect(html).not.toContain('$0.500')
    expect(html).toContain('verdict-card full') // 顶部 full verdict 卡
    expect(html).toContain('调整拓扑详情面板宽度') // 右侧详情面板可拖拽
    expect(html).toContain('aria-hidden="true"') // TURN 箭头只做方向提示，不再点击折叠
  })

  it('Turn 与会话汇总共用 Provider-aware Token 和逻辑调用口径', () => {
    const t: Turn = {
      runId: 'run-codex',
      userText: '/rate-workflow 1',
      done: true,
      items: [
        ev({
          id: 'skill',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          name: 'rate-workflow',
          toolUseId: 'skill-1',
          input: { source: 'tool_use' }
        }),
        ev({
          id: 'skill-path',
          kind: 'skill',
          stage: 'skill:rate-workflow',
          name: 'rate-workflow',
          toolUseId: 'read-skill',
          input: { source: 'skill_path_in_command' }
        }),
        ev({
          id: 'multi-mcp',
          kind: 'tool',
          stage: 'tool:Bash',
          tool: 'Bash',
          toolUseId: 'mcp-1',
          isMcp: true,
          mcpCalls: [
            { server: 'coop', action: 'query', tool: 'mcporter:coop.query' },
            { server: 'group-env', action: 'list', tool: 'mcporter:group-env.list' }
          ]
        }),
        ev({
          id: 'codex-result',
          kind: 'harness',
          stage: 'result',
          providerId: 'codex',
          tokensIn: 100,
          tokensOut: 20,
          cacheReadTokens: 80
        })
      ]
    }
    const html = renderToStaticMarkup(<ExecutionGraph turns={[t]} selectedId={null} onSelect={() => {}} />)

    expect(html).toContain('120 tok')
    expect(html).not.toContain('200 tok')
    expect(html).toContain('3 calls')
    expect(html).not.toContain('4 calls')
    expect(html).toContain('3 个调用')
    expect(html).toContain('coop · group-env')
    expect(html).toContain('query · list · 2 次调用')
  })

  it('空会话出占位', () => {
    const html = renderToStaticMarkup(<ExecutionGraph turns={[]} selectedId={null} onSelect={() => {}} />)
    expect(html).toContain('调用拓扑树')
  })
})

import { SegmentsView } from './SegmentsView'

describe('SegmentsView 渲染：主体内容对齐容器', () => {
  it('渲染统一对齐的 seg-shell', () => {
    const t: Turn = {
      runId: 'seg',
      userText: 'x',
      done: true,
      items: [
        ev({ id: 'sg1', kind: 'skill', stage: 'skill:workflow-orchestrator', name: 'workflow-orchestrator' }),
        ev({ id: 'sg2', kind: 'tool', stage: 'tool:Read', tool: 'Read', fileOp: 'read', filePath: '/a/SKILL.md' }),
        ev({ id: 'sg3', kind: 'harness', stage: 'result', costUsd: 0.01, durationApiMs: 1200 })
      ]
    }
    const html = renderToStaticMarkup(<SegmentsView turns={[t]} />)
    expect(html).toContain('seg-shell')
    expect(html).toContain('会话切成')
  })
})

import { DiagnosticsView } from './DiagnosticsView'
import { McpModal, SettingsModal, SkillsModal } from './Modals'

describe('DiagnosticsView 渲染：诚实观测态（非拦截语义）', () => {
  const html = renderToStaticMarkup(
    <DiagnosticsView
      agents={[
        { id: 'claude', name: 'claude', bin: 'claude', path: '/usr/local/bin/claude', version: '2.1.170' },
        { id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/Users/example/.nvm/versions/node/v22.22.1/bin/qodercli', version: '1.0.2' }
      ]}
      diag={{ sdkVersion: '^0.3.186', settingSources: 'none', claudeVersion: '2.1.170' }}
      mcpLive={[
        { name: 'weread', status: 'failed' },
        { name: 'tracker', status: 'connected' }
      ]}
      mcps={[]}
      stats={{
        totals: { cost: 0.5, tin: 100, tout: 20, turns: 3 },
        topTools: [{ tool: 'Bash', n: 5, mcp: 0 }],
        byCwd: [],
        byModel: [],
        toolStats: [],
        dangerTrend: [{ reason: 'rm 递归强删', level: 'danger', n: 3 }]
      }}
      turns={[
        {
          runId: 'r',
          userText: 'x',
          done: true,
          items: [
            ev({ id: 'd1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', input: { command: 'rm -rf x' }, danger: { level: 'danger', reason: 'rm 递归强删' } }),
            ev({ id: 'r1', kind: 'harness', stage: 'result', costUsd: 0.5 })
          ]
        }
      ]}
      projects={[]}
      usage={{ status: 'ready', cost: 0.5, tin: 100, tout: 20, turns: 3, invalidLines: 0 }}
      onReprobe={() => {}}
    />
  )

  it('渲染 hero + 系统判决 + 环境（真实 claude 路径/版本）', () => {
    expect(html).toContain('诊断')
    expect(html).toContain('系统状态')
    expect(html).toContain('/usr/local/bin/claude')
    expect(html).toContain('2.1.170')
    expect(html).toContain('Qoder')
    expect(html).toContain('/Users/example/.nvm/versions/node/v22.22.1/bin/qodercli')
    expect(html).toContain('1.0.2')
  })

  it('诊断页不展示 SDK、runtime capability、settingSources 和 node/electron 项', () => {
    expect(html).not.toContain('<span class="k">sdk</span>')
    expect(html).not.toContain('<span class="k">runtime capability</span>')
    expect(html).not.toContain('<span class="k">settingSources</span>')
    expect(html).not.toContain('<span class="k">node / electron</span>')
    expect(html).not.toContain('runtime caps')
    expect(html).not.toContain('settingSources')
    expect(html).not.toContain('^0.3.186')
  })

  it('MCP 有 failed → 判决 warn + 需重连', () => {
    expect(html).toContain('judgement warn')
    expect(html).toContain('weread')
  })

  it('危险审计用观测语义（审计放行/未拦截），绝不用 blocked/allowed', () => {
    expect(html).toContain('观测放行')
    expect(html).toContain('审计放行')
    expect(html).toContain('rm 递归强删')
    expect(html).not.toContain('blocked')
    expect(html).not.toContain('allowed')
  })

  it('claude 未检测时判决 bad，SQLite native 健康未知时不伪报加载正常', () => {
    const missing = renderToStaticMarkup(
      <DiagnosticsView
        agents={[]}
        diag={null}
        mcpLive={[]}
        mcps={[]}
        stats={null}
        turns={[]}
        projects={[]}
        usage={null}
        onReprobe={() => {}}
      />
    )
    expect(missing).toContain('judgement bad')
    expect(missing).toContain('未检测到 Provider')
    expect(missing).toContain('native 健康')
    expect(missing).not.toContain('运行正常')
    expect(missing).not.toContain('加载正常')
  })

  it('Provider 与 MCP 可用但诊断、DB、usage 缺证据时保持 warn，不显示绿色正常', () => {
    const incomplete = renderToStaticMarkup(
      <DiagnosticsView
        agents={[{ id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/bin/qodercli' }]}
        diag={null}
        mcpLive={[]}
        mcps={[]}
        mcpCapability={{
          providerId: 'qoder',
          mode: 'none',
          state: 'unsupported',
          data: null,
          reason: '隔离模式不暴露 MCP'
        }}
        stats={null}
        turns={[]}
        projects={[]}
        usage={null}
        onReprobe={() => {}}
      />
    )
    expect(incomplete).toContain('verdict-card full warn')
    expect(incomplete).toContain('诊断 IPC 尚未返回')
    expect(incomplete).not.toContain('verdict-card full ok')
    expect(incomplete).not.toContain('运行正常')
  })

  it('MCP 有配置但 live 状态未探测时不显示全部连通', () => {
    const unknown = renderToStaticMarkup(
      <DiagnosticsView
        agents={[{ id: 'claude', name: 'claude', bin: 'claude', path: '/usr/local/bin/claude' }]}
        diag={{ sdkVersion: '^0.3.186', settingSources: 'none' }}
        mcpLive={[]}
        mcps={[{ name: 'github', scope: 'user', transport: 'stdio', detail: 'github mcp', enabled: true }]}
        mcpCapability={{
          providerId: 'claude',
          mode: 'manage',
          state: 'unknown',
          data: null,
          reason: 'MCP capability 尚未返回完整证据'
        }}
        stats={null}
        turns={[]}
        projects={[]}
        usage={null}
        onReprobe={() => {}}
      />
    )
    expect(unknown).toContain('judgement warn')
    expect(unknown).toContain('能力状态未知')
    expect(unknown).toContain('MCP capability 尚未返回完整证据')
    expect(unknown).not.toContain('全部连通')
  })

  it('runtime capability warning 仍参与系统判决，但不再单独展示诊断项', () => {
    const warningHtml = renderToStaticMarkup(
      <DiagnosticsView
        agents={[
          { id: 'claude', name: 'claude', bin: 'claude', path: '/usr/local/bin/claude', version: '2.1.170' },
          { id: 'qoder', name: 'Qoder', bin: 'qodercli', path: '/Users/example/.nvm/versions/node/v22.22.1/bin/qodercli', version: '1.0.2' }
        ]}
        diag={{ sdkVersion: '^0.3.186', settingSources: 'none', claudeVersion: '2.1.170' }}
        mcpLive={[]}
        mcps={[]}
        mcpCapability={{
          providerId: 'qoder',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        stats={null}
        turns={[
          {
            runId: 'qoder-runtime-warning',
            userText: 'x',
            done: true,
            items: [
              ev({
                id: 'qoder-result',
                kind: 'harness',
                stage: 'result',
                runtimeProvider: 'qoder_cli',
                runtimeMetadata: {
                  capabilityWarnings: [
                    {
                      kind: 'mcp',
                      runtimeProvider: 'qoder_cli',
                      name: 'dry_alpha',
                      reason: 'runtime reported MCP server disconnected',
                      expected: 'connected',
                      observed: 'disconnected',
                      evidence: 'runtime:init.mcp_servers'
                    }
                  ]
                }
              })
            ]
          }
        ]}
        projects={[]}
        usage={null}
        onReprobe={() => {}}
      />
    )
    expect(warningHtml).toContain('judgement warn')
    expect(warningHtml).toContain('qoder_cli')
    expect(warningHtml).toContain('dry_alpha')
    expect(warningHtml).toContain('disconnected')
    expect(warningHtml).not.toContain('runtime caps')
    expect(warningHtml).not.toContain('runtime capability warning')
    expect(warningHtml).not.toContain('运行正常')
  })
})

describe('McpModal 渲染：pending 不伪装 connected', () => {
  it('设置弹窗把当前主题呈现为可访问的单选项', () => {
    const html = renderToStaticMarkup(
      <SettingsModal theme="light" onThemeChange={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('class="modal settings-modal"')
    expect(html).toContain('role="radiogroup" aria-label="界面主题"')
    expect(html).toContain('class="theme-option active" role="radio" aria-checked="true"')
    expect(html).toContain('浅色')
    expect(html).toContain('立即应用到全部视图')
  })

  it('Skill 与 MCP 首次后台读取时立即展示诚实加载态', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[]}
        capability={null}
        refreshing
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(skillHtml).toContain('读取中…')
    expect(skillHtml).toContain('正在读取 Skill…')
    expect(skillHtml).toContain('class="modal-refresh" disabled=""')

    const mcpHtml = renderToStaticMarkup(
      <McpModal
        mcps={[]}
        status={{}}
        live={[]}
        configRefreshing
        refreshing={false}
        capability={null}
        onTest={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(mcpHtml).toContain('读取配置中…')
    expect(mcpHtml).toContain('正在读取 MCP 配置…')
    expect(mcpHtml).toContain('class="modal-refresh" disabled=""')
  })

  it('live pending 直接显示 pending', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'stdio', detail: 'github mcp', enabled: true }]}
        status={{}}
        live={[{ name: 'github', status: 'pending' }]}
        refreshing={false}
        onTest={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('pending')
    expect(html).not.toContain('connected')
  })

  it('Provider 返回未知运行态时诚实降级展示，不让整个 renderer 崩溃', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'legacy', scope: 'user', transport: 'stdio', detail: 'legacy mcp', enabled: true }]}
        status={{}}
        live={[{ name: 'legacy', status: 'disconnected' } as unknown as ComponentProps<typeof McpModal>['live'][number]]}
        refreshing={false}
        onTest={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('class="mcp-neutral"')
    expect(html).toContain('disconnected')
  })
})

describe('Skill/MCP 操作能力渲染', () => {
  it('只读 Provider 禁用 Skill 开关并保留原生状态', () => {
    const html = renderToStaticMarkup(
      <SkillsModal
        skills={[{ name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: true }]}
        capability={{ providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [] }}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""[^>]*checked=""/)
    expect(html).toContain('Skill 目录仅供读取')
  })

  it('可管理 Provider 允许 Skill 开关，MCP 只读 Provider 保持 disabled/connected 真值', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[{ name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: false }]}
        capability={{ providerId: 'claude', cwd: '/repo', mode: 'manage', state: 'ready', data: [] }}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(skillHtml).toContain('当前 Provider 支持由 Scry 管理 Skill 开关')
    expect(skillHtml).not.toContain('type="checkbox" disabled=""')

    const mcpHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'scry-e2e', scope: 'project', transport: 'stdio', detail: 'fixture', enabled: true }]}
        status={{}}
        live={[{ name: 'scry-e2e', status: 'connected', tools: 3 }]}
        refreshing={false}
        capability={{
          providerId: 'opencode',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onToggle={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(mcpHtml).toMatch(/type="checkbox"[^>]*disabled=""[^>]*checked=""/)
    expect(mcpHtml).toContain('connected')
    expect(mcpHtml).toContain('只暴露原生 MCP 配置/运行状态')
  })
})

import { AnalyticsView } from './AnalyticsView'

describe('AnalyticsView 渲染：时间序列 + 四 Provider 覆盖', () => {
  const html = renderToStaticMarkup(
    <AnalyticsView
      projects={[{ cwd: '/a/scry', name: 'scry', mtime: 0, sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 0, preview: 'x', count: 1 }] }]}
      stats={{
        status: 'ready',
        totals: { cost: 12.47, tin: 3000000, tout: 420000, turns: 847 },
        topTools: [{ tool: 'Bash', n: 624, mcp: 0 }],
        byCwd: [{ cwd: '/a/scry', cost: 5.42, turns: 300 }],
        byModel: [
          { model: 'claude-sonnet-4-6', tin: 2000000, tout: 300000, cost: 8.0 },
          { model: 'claude-haiku-4-5', tin: 800000, tout: 100000, cost: 3.0 }
        ],
        toolStats: [
          { tool: 'Bash', n: 624, avgMs: 680, errors: 19 },
          { tool: 'mcp__obsidian__search', n: 84, avgMs: 1200, errors: 2 }
        ],
        dangerTrend: [{ reason: 'git push', level: 'danger', n: 3 }],
        tokenDaily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-07-${String(i + 1).padStart(2, '0')}`, input: i * 100, output: i * 10, cacheRead: 0, cacheWrite: 0, turns: 1, inputKnownTurns: 1, outputKnownTurns: 1, cacheReadKnownTurns: 1, cacheWriteKnownTurns: 1 })),
        dangerDaily: Array.from({ length: 90 }, (_, i) => ({ day: `day-${i}`, danger: i === 89 ? 1 : 0, warn: 0 })),
        comparison: {
          current: { tokens: 120000, tokenKnownTurns: 4, turns: 5, toolCalls: 42, danger: 1 },
          previous: { tokens: 100000, tokenKnownTurns: 4, turns: 4, toolCalls: 40, danger: 0 },
          change: { tokensPct: 20, turnsPct: 25, toolCallsPct: 5, dangerPct: null }
        },
        cacheReuse: [
          { providerId: 'claude', turns: 2, inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 20, inputKnownTurns: 2, cacheReadKnownTurns: 2, cacheWriteKnownTurns: 2, comparableTurns: 2, reuseRate: 0.4, denominator: 'separate_input' },
          { providerId: 'codex', turns: 1, inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: null, inputKnownTurns: 1, cacheReadKnownTurns: 1, cacheWriteKnownTurns: 0, comparableTurns: 1, reuseRate: 0.3, denominator: 'input_includes_cache' },
          { providerId: 'qoder', turns: 1, inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, inputKnownTurns: 0, cacheReadKnownTurns: 0, cacheWriteKnownTurns: 0, comparableTurns: 0, reuseRate: null, denominator: 'unknown' },
          { providerId: 'opencode', turns: 1, inputTokens: 80, cacheReadTokens: 20, cacheWriteTokens: 4, inputKnownTurns: 1, cacheReadKnownTurns: 1, cacheWriteKnownTurns: 1, comparableTurns: 0, reuseRate: null, denominator: 'upstream_dependent' }
        ],
        mcpLatency: [{ server: 'obsidian', calls: 84, p50Ms: 900, p95Ms: 2200, errors: 2 }],
        providerCoverage: (['claude', 'codex', 'qoder', 'opencode'] as const).map((providerId) => ({ providerId, turns: 1, inputKnownTurns: providerId === 'qoder' ? 0 : 1, outputKnownTurns: providerId === 'qoder' ? 0 : 1, cacheReadKnownTurns: providerId === 'qoder' ? 0 : 1, cacheWriteKnownTurns: providerId === 'claude' || providerId === 'opencode' ? 1 : 0, dangerCoverage: providerId === 'claude' || providerId === 'qoder' ? 'classified' as const : 'unsupported' as const }))
      }}
    />
  )

  it('5 KPI 用真实 totals（token/turns/tools/danger）', () => {
    expect(html).toContain('3.42M')
    expect(html).not.toContain('$12.47')
    expect(html).toContain('847')
    expect(html).toContain('3.42M') // tin+tout = 3.42M
    expect(html).toContain('危险操作')
  })

  it('模型分布 + 项目轮次 + 常用工具 + MCP 用真实聚合', () => {
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).toContain('scry')
    expect(html).toContain('项目会话轮次')
    expect(html).toContain('300')
    expect(html).not.toContain('$5.42')
    expect(html).toContain('常用工具')
    expect(html).toContain('mcp:obsidian')
  })

  it('渲染 30/90 天、环比、P50/P95 与四 Provider coverage', () => {
    expect(html).toContain('最近 30 天')
    expect(html).toContain('最近 90 天')
    expect(html).toContain('+20.0%')
    expect(html).toContain('900ms')
    expect(html).toContain('2.2s')
    expect(html).toContain('Claude')
    expect(html).toContain('OpenCode')
    expect(html).toContain('unsupported')
  })

  it('cache 只展示可证明比例，不伪造 per-tool token share 或 Markdown 星号', () => {
    expect(html).toContain('40.0%')
    expect(html).toContain('30.0%')
    expect(html).toContain('上游分母不可证明')
    expect(html).toContain('不估算 per-tool Token share')
    expect(html).not.toContain('**')
  })
})
