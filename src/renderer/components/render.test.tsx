// 渲染侧运行证据 + D1 拆分回归：用真实 TraceEvent 数据渲染拆出来的组件，
// 断言核心流程的三样 UI 都出来——trace 树（工具节点）/ footer（token）/ 文件足迹。
// renderToStaticMarkup 不需 DOM，纯 node 跑，确定性、零成本，可常驻套件。
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRef, type ComponentProps } from 'react'
import type { ActiveRun, TraceEvent } from '@shared/trace'
import type { AgentQuestionRequest } from '@shared/runtime'
import type { Turn } from '../format'
import type { ParsedTurn, SessionHistoryPage } from '../env'
import {
  App,
  EmptySessionOverview,
  activeRunForSession,
  adoptLocalStartSessionId,
  attachmentsAfterSuccessfulSubmit,
  appendWorkspaceReference,
  buildForkSessionRequest,
  applyNewConversationEffects,
  applyProviderCatalogRefresh,
  applySessionArchiveEffects,
  sessionEvidenceGapAfterLoad,
  applySessionCapturedEffects,
  applyTurnDoneEffects,
  chatBottomDistance,
  commitDraftAfterStart,
  dequeueStartedPrompt,
  enqueuePrompt,
  failedSlashCatalog,
  focusedRunNeedsLoading,
  hasSessionOverviewContext,
  inputAfterSuccessfulSubmit,
  isChatNearBottom,
  providerContextCacheKey,
  resetQueuedPromptControl,
  restoreActiveSessionSelection,
  restoreFocusedRunSelection,
  scrollChatToBottomIfNeeded,
  scrollChatTargetIntoView,
  shouldQueuePrompt,
  takeNextQueuedPrompt
} from '../App'
import { resolveRunControlSelection, shouldResetRunControlCatalog } from '../hooks/useIntegrations'
import { AssistantTurn, RecorderContentPager, UserMessage, attachmentSrc, coalesceAdjacentThinking } from './ChatTurn'
import { ChatView, filterSlashCommands, formatElapsedMs, imageFilesFromClipboardData } from './ChatView'
import { logicalCallEventsForTurn, OverviewPanel, TurnFileFootprint, turnCallRowsFromMap } from './OverviewPanel'
import { Sidebar } from './Sidebar'
import { ViewChrome } from './ViewChrome'
import { CliPicker, ModelEffortPicker } from './Pickers'
import { pathContains, WorkspacePanel, workspaceReferenceToken } from './WorkspacePanel'
import { parseUnifiedDiff, TurnDiffReviewPanel } from './TurnDiffReviewPanel'

const ev = (e: Partial<TraceEvent> & { id: string; kind: TraceEvent['kind']; stage: string }): TraceEvent => ({
  ts: '',
  runId: 'r1',
  ...e
})

describe('Pi Profile renderer identity', () => {
  it('renders the selected and selectable agent ids into stable DOM attributes', () => {
    const html = renderToStaticMarkup(
      <CliPicker
        agents={[
          { id: 'pi:default', name: 'Pi', bin: 'pi', path: '/usr/local/bin/pi', version: '1.0.0' },
          { id: 'pi:0123456789abcdef', name: 'Pi · custom', bin: 'custom', path: '/opt/custom', version: '2.0.0' }
        ]}
        selectedId="pi:default"
        onSelect={() => undefined}
        onAddPi={() => undefined}
        onRemovePi={() => undefined}
        onRescan={() => undefined}
      />
    )

    expect(html).toContain('class="clibtn" data-agent-id="pi:default"')
  })

  it('isolates slash command caches by Pi profile as well as provider and cwd', () => {
    const native = providerContextCacheKey({ providerId: 'pi', agentProfileId: 'pi:default', cwd: '/repo' })
    const custom = providerContextCacheKey({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', cwd: '/repo' })
    expect(native).not.toBe(custom)
    expect(native).toBe('pi\0pi:default\0/repo')
  })

  it('新建空会话不会继续渲染上一会话的 Overview 聚合证据', () => {
    expect(hasSessionOverviewContext(null, 0, false)).toBe(false)
    expect(hasSessionOverviewContext('session-1', 0, false)).toBe(true)
    expect(hasSessionOverviewContext(null, 1, false)).toBe(true)
    expect(hasSessionOverviewContext(null, 0, true)).toBe(true)

    const html = renderToStaticMarkup(<EmptySessionOverview />)
    expect(html).toContain('新会话暂无证据')
    expect(html).toContain('发送第一条消息后')
    expect(html).not.toContain('累计 Token 用量')
    expect(html).not.toContain('工作区未提交改动')
  })

  it('本地发送触发 focusedRun 时不闪现历史会话加载态', () => {
    expect(focusedRunNeedsLoading('run-1', true, new Set())).toBe(false)
    expect(focusedRunNeedsLoading('run-1', false, new Set(['run-1']))).toBe(false)
    expect(focusedRunNeedsLoading('run-1', false, new Set())).toBe(true)
  })

  it('removes rejected slash catalogs instead of leaving stale commands selectable', () => {
    const cache = new Map([['qoder\0\0/repo', { commands: [{ name: 'old' }], reason: null }]])

    expect(failedSlashCatalog<{ name: string }, { commands: Array<{ name: string }>; reason: null }>(
      cache,
      'qoder\0\0/repo',
      new Error('catalog unavailable')
    )).toEqual({ commands: [], reason: 'catalog unavailable' })
    expect(cache.size).toBe(0)
  })
})

const turn: Turn = {
  runId: 'r1',
  userText: '创建并读回文件',
  done: true,
  items: [
    ev({ id: 'e0', kind: 'model', stage: 'thinking', thinking: '\n\n' }),
    ev({ id: 'e1', kind: 'model', stage: 'thinking', thinking: '**先写文件再读回**\n\n' }),
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

const renderWelcome = (overrides: Partial<ComponentProps<typeof ChatView>> = {}): string => {
  const props: ComponentProps<typeof ChatView> = {
    turns: [],
    selectedId: null,
    scrollRef: createRef<HTMLDivElement>(),
    textareaRef: createRef<HTMLTextAreaElement>(),
    cwd: null,
    recent: [],
    agents: [],
    selectedAgentId: 'claude',
    ...RUN_CONTROL_PROPS,
    input: '',
    busy: false,
    draftAttachments: [],
    queuedPrompts: [],
    slashOpen: false,
    slashLoading: false,
    slashCmds: [],
    slashSel: 0,
    onSelect: () => {},
    onInput: () => {},
    onChooseFolder: () => {},
    onPickRecent: () => {},
    onRemoveRecent: () => {},
    onRetrySlash: () => {},
    onPickSlash: () => {},
    onSlashSel: () => {},
    onHideSlash: () => {},
    onSend: () => {},
    onStop: () => {},
    onPasteImages: () => {},
    onPasteClipboardImage: () => {},
    onRemoveDraftAttachment: () => {},
    onRemoveQueuedPrompt: () => {},
    onSelectAgent: () => {},
    onRescan: () => {}
  }
  return renderToStaticMarkup(<ChatView {...props} {...overrides} />)
}

describe('ChatView 项目选择条', () => {
  const hasPicker = (overrides: Partial<ComponentProps<typeof ChatView>> = {}) =>
    renderWelcome({ cwd: '/repo/rate-native', ...overrides }).includes('class="composer-context"')

  it('新建草稿即使已选项目仍可选择；未绑定项目保留入口', () => {
    expect(hasPicker()).toBe(true)
    expect(hasPicker({ cwd: null, agentLocked: true })).toBe(true)
  })

  it.each([
    { submitting: true },
    { busy: true },
    { agentLocked: true },
    { sessionLoading: true },
    { sessionEvidenceGap: { status: 'unavailable' as const, detail: '历史不可用' } },
    { turns: [{ runId: 'started', userText: '你好', done: false, items: [] }] },
    { turns: [{ runId: 'finished', userText: '你好', done: true, items: [] }] }
  ])('已绑定会话的启动/运行/恢复/完成状态不重复显示项目：%j', (state) => {
    expect(hasPicker(state)).toBe(false)
  })
})

describe('ChatView 改动摘要', () => {
  const sessionTurn: Turn = {
    runId: 'run-1',
    userText: '改两个文件',
    done: true,
    items: [
      {
        id: 'sd-1',
        ts: '2026-08-10T00:00:02.000Z',
        runId: 'run-1',
        kind: 'harness',
        stage: 'session_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files: [{ path: '/repo/src/a.ts', added: 4, deleted: 1 }],
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:02.000Z',
          captureMs: 9,
          cleanup: 'ok'
        }
      },
      {
        id: 'td-1',
        ts: '2026-08-10T00:00:03.000Z',
        runId: 'run-1',
        kind: 'harness',
        stage: 'turn_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files: [{ path: '/repo/src/b.ts', added: 7, deleted: 0 }],
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:03.000Z',
          captureMs: 9,
          cleanup: 'ok'
        }
      }
    ]
  }

  it('对话流不再展示重复的本会话改动卡', () => {
    const html = renderWelcome({ turns: [sessionTurn], busy: false, cwd: '/repo' })

    expect(html).not.toContain('本会话改动')
    expect(html).not.toContain('session-summary')
    expect(html).toContain('本轮改动')
  })
})

describe('ChatView 运行状态条（busy 时显式状态，不藏 placeholder 里）', () => {
  const runningTurn: Turn = {
    runId: 'run-running-abc',
    userText: '修复登录超时',
    done: false,
    items: [
      {
        id: 'ev-1',
        ts: '2026-08-10T00:00:00.000Z',
        runId: 'run-running-abc',
        kind: 'harness',
        stage: 'run_start'
      }
    ]
  }

  it('busy 且有未完成 turn 时渲染状态条：运行中 + 时长 + 停止', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('run-status')
    expect(html).toContain('运行中')
    expect(html).toContain('可继续输入，新消息将加入队列')
    expect(html).toMatch(/\d{2,3}:\d{2}:\d{2}/) // 已用时长（小时级长任务）
    expect(html).not.toContain('run-status-runid') // runId 短码已下线
    expect(html).toContain('停止')
  })

  it('停止阶段照实描述请求进度，不宣布这一轮已终止', () => {
    const stopping = renderWelcome({
      turns: [runningTurn],
      busy: true,
      stopStates: {
        'run-running-abc': {
          runId: 'run-running-abc',
          providerId: 'claude',
          runtimeProvider: 'claude_sdk',
          phase: 'interrupt_requested',
          requestedAt: '2026-08-10T00:00:10.000Z',
          updatedAt: '2026-08-10T00:00:10.000Z',
          providerSettled: false,
          window: { gracefulMs: 6000, forceKillMs: 4000 }
        }
      }
    })
    expect(stopping).toContain('data-stop-tone="stopping"')
    expect(stopping).toContain('<b>停止中</b>')
    expect(stopping).not.toContain('<b>运行中</b>')
  })

  it('Provider 未确认终止时仍算 busy：状态条如实标注，新消息进队列而不是立刻发送', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      // main 的 admission 在 providerSettled=false 时仍会拒绝新一轮，所以这里必须仍是 busy。
      busy: true,
      stopStates: {
        'run-running-abc': {
          runId: 'run-running-abc',
          providerId: 'claude',
          runtimeProvider: 'claude_sdk',
          phase: 'provider_unsettled',
          requestedAt: '2026-08-10T00:00:10.000Z',
          updatedAt: '2026-08-10T00:00:20.000Z',
          providerSettled: false,
          window: { gracefulMs: 6000, forceKillMs: 4000 }
        }
      }
    })
    expect(html).toContain('data-stop-tone="unsettled"')
    expect(html).toContain('Provider 未确认终止')
    expect(html).toContain('可能还在后台运行')
    expect(html).toContain('先进队列')
    // 发送键仍然是「加入队列」，输入框保持可编辑。
    expect(html).toContain('加入队列')
    expect(html).toContain('class="input"')
  })

  it('实时视图降级时如实标注缺口，并说明归档仍是权威证据', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      busy: true,
      traceHealth: { degraded: true, skippedEvents: 42 }
    })
    expect(html).toContain('run-status-trace-degraded')
    expect(html).toContain('实时视图已降级 · 缺 42 条')
    expect(html).toContain('本机归档')
  })

  it('实时视图健康时不显示降级标注', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      busy: true,
      traceHealth: { degraded: false, skippedEvents: 0 }
    })
    expect(html).not.toContain('run-status-trace-degraded')
  })

  it('busy 时 placeholder 不再承担状态文案', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).not.toContain('运行中，可继续输入并加入队列')
  })

  it('空闲态不渲染状态条，停止按钮也不在 composer 底部常驻', () => {
    const html = renderWelcome({ turns: [], busy: false })
    expect(html).not.toContain('run-status')
    expect(html).not.toContain('停止')
  })

  // 分页只收窄 IPC 载荷与 renderer 挂载量；main 侧仍全量解析并缓存整个会话，
  // 所以文案只能声称「挂载」范围，不能声称降低了 main 的加载/内存。
  it('分页历史显式说明只挂载最近轮次，并提供取回更早轮次的入口', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      busy: false,
      historyWindow: { sessionId: 's1', offset: 460, totalTurns: 500, hasOlder: true, completeness: 'partial' },
      onLoadOlderTurns: () => {}
    })
    expect(html).toContain('history-window-note')
    expect(html).toContain('仅挂载最近')
    expect(html).toContain('<b>40</b> / 500 轮')
    expect(html).toContain('更早轮次仍在本机归档中，未丢弃')
    expect(html).toContain('加载更早轮次')
  })

  it('完整历史不显示分页提示', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      busy: false,
      historyWindow: { sessionId: 's1', offset: 0, totalTurns: 1, hasOlder: false, completeness: 'complete' }
    })
    expect(html).not.toContain('history-window-note')
  })

  it('busy 时发送键文案为「加入队列」', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('加入队列')
  })

  it('Composer 按 C4 分层：目录顶置、权限左下、Agent 与 Model/Effort 右下', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('class="composer-context" role="group" aria-label="会话上下文"')
    expect(html).toContain('class="composer-controls" role="group" aria-label="权限配置"')
    expect(html).toContain('class="composer-action-controls" role="group" aria-label="Agent、Model 与 Effort"')
    expect(html).not.toContain('run-group-sep')
    expect(html).not.toContain('rc-prefix" aria-hidden="true">模型')
    expect(html).toContain('rc-prefix" aria-hidden="true">权限')
  })

  it('Model 与 Effort 组合入口显示当前值，权限继续使用原生选择合同', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('class="model-effort-model">自动模型')
    expect(html).toContain('class="model-effort-effort">默认')
    expect(html).toContain('rc-value" aria-hidden="true">默认审批')
  })

  it('Model/Effort 浮层显示 Effort/Model 与紧凑滑杆，不渲染两侧图标', () => {
    const html = renderToStaticMarkup(
      <ModelEffortPicker
        modelValue="ultimate"
        modelOptions={[{ value: 'ultimate', label: 'Ultimate' }]}
        effortValue="high"
        effortOptions={[{ value: 'default', label: '默认' }, { value: 'high', label: '高' }]}
        onModelChange={() => {}}
        onEffortChange={() => {}}
        open
      />
    )

    const effortIndex = html.indexOf('class="model-effort-current-effort"')
    const modelIndex = html.indexOf('class="model-effort-current-model"')
    expect(effortIndex).toBeGreaterThan(-1)
    expect(modelIndex).toBeGreaterThan(effortIndex)
    expect(html).toContain('<span>高</span><svg class="ico chev"')
    expect(html).toContain('>Ultimate<')
    expect(html).toContain('type="range"')
    expect(html).toContain('aria-valuetext="高"')
    expect(html).not.toContain('model-effort-summary-bolt')
    expect(html).not.toContain('aria-label="重置 Effort"')
  })

  it('发送键保持图标按钮：文字只走 aria-label，不塞进圆形按钮里折行', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('aria-label="加入队列"')
    expect(html).toContain('send-label')
  })
})

describe('选中的历史会话读不到证据时不假装成新会话', () => {
  it('page 为 null 与归档空轮次分开定义，有轮次时不报缺失', () => {
    expect(sessionEvidenceGapAfterLoad('s1', null)).toEqual({
      sessionId: 's1',
      status: 'unavailable',
      detail: '本机没有命中这条会话的可读证据：Provider transcript 与 Scry 归档都没有记录。'
    })
    expect(sessionEvidenceGapAfterLoad('s1', { turns: [] })).toMatchObject({ status: 'empty' })
    expect(sessionEvidenceGapAfterLoad('s1', {
      turns: [{ runId: 'run-1', userText: 'hi', done: true, items: [] } as unknown as ParsedTurn]
    })).toBeNull()
  })

  it('证据缺失时渲染说实话的空态，而不是“开始一次可追溯执行” hero', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      sessionEvidenceGap: {
        status: 'unavailable',
        detail: '本机没有命中这条会话的可读证据：Provider transcript 与 Scry 归档都没有记录。'
      }
    })

    expect(html).toContain('chat-session-evidence-gap')
    expect(html).toContain('data-status="unavailable"')
    expect(html).toContain('这条会话没有可读的本机证据')
    expect(html).toContain('Provider transcript 与 Scry 归档都没有记录')
    expect(html).not.toContain('开始一次可追溯执行')
    expect(html).not.toContain('新会话 · 本机证据')
  })

  it('归档命中但没有轮次时用另一句文案，仍不渲染 hero', () => {
    const html = renderWelcome({
      cwd: '/tmp/project',
      sessionEvidenceGap: { status: 'empty', detail: '归档已命中，但里面没有任何已收口的轮次。' }
    })

    expect(html).toContain('data-status="empty"')
    expect(html).toContain('这条会话的归档里没有轮次')
    expect(html).not.toContain('开始一次可追溯执行')
  })

  it('真正的新会话（无证据缺失）仍然渲染 hero', () => {
    const html = renderWelcome({ cwd: '/tmp/project' })

    expect(html).toContain('开始一次可追溯执行')
    expect(html).not.toContain('chat-session-evidence-gap')
  })
})

describe('formatElapsedMs', () => {
  it('分钟级：MM:SS 补零', () => {
    expect(formatElapsedMs(12 * 60 * 1000 + 34 * 1000)).toBe('12:34')
    expect(formatElapsedMs(0)).toBe('00:00')
  })

  it('小时级：H:MM:SS', () => {
    expect(formatElapsedMs((3 * 3600 + 5 * 60 + 9) * 1000)).toBe('3:05:09')
  })
})

describe('App shell 集成 smoke：拆分后的 shell / hooks / panes 首屏仍可组合渲染', () => {
  const html = renderToStaticMarkup(<App />)

  it('未选 cwd 首屏渲染不绑定项目的 composer 与看板入口，不自动展开面板', () => {
    expect(html).toContain('app app-shell')
    expect(html).not.toContain('has-right-panel')
    expect(html).toContain('id="sidebar-pane"')
    expect(html).toContain('id="main-pane"')
    expect(html).not.toContain('id="right-surface-pane"')
    expect(html).toContain('title="右侧工作区"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('不绑定项目')
    expect(html).toContain('可直接发起任务')
    expect(html).toContain('aria-label="会话上下文"')
    expect(html).toContain('aria-label="权限配置"')
    expect(html).toContain('aria-label="Agent、Model 与 Effort"')
    expect(html).toContain('aria-label="选择 Model 与 Effort"')
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
  it('显示 Agent 状态和面板入口', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd={null}
        agent={undefined}
        agentScanning
        showSummary
        showPanel
        onToggleSummary={() => {}}
        onTogglePanel={() => {}}
      />
    )
    expect(html).toContain('正在检测 agent…')
    expect(html).not.toContain('未检测到 agent')
    expect(html).toContain('class="tb-thread"')
    expect(html).toContain('不绑定项目')
    expect(html).toContain('aria-label="切换固定摘要"')
    expect(html).toContain('title="收起摘要"')
    expect(html).toContain('title="右侧工作区"')
    expect(html).not.toContain('title="工作区文件"')
  })

  it('绑定项目时只显示面板入口，不混入文件快捷入口或集成入口', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd="/tmp/sample-workspace"
        agent={undefined}
        showSummary
        showPanel
        onToggleSummary={() => {}}
        onTogglePanel={() => {}}
      />
    )
    expect(html).not.toContain('title="工作区文件"')
    expect(html).toContain('sample-workspace')
    expect(html).toContain('title="收起摘要"')
    expect(html).toContain('title="右侧工作区"')
    expect(html).toContain('aria-label="右侧工作区"')
    expect(html).not.toContain('title="Skills"')
    expect(html).not.toContain('title="MCP"')
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

  it('只把匹配 cwd/provider/profile 与任一会话别名的未完成 run 恢复到所选会话', () => {
    const run = {
      runId: 'run-1',
      sessionId: 'catalog-session',
      externalSessionId: 'provider-session',
      providerId: 'pi' as const,
      agentProfileId: 'pi:default',
      cwd: '/repo/a',
      userText: 'work',
      items: [],
      done: false
    }

    for (const alias of ['run-1', 'catalog-session', 'provider-session']) {
      expect(activeRunForSession(run, '/repo/a', alias, 'pi', 'pi:default')).toBe(run)
    }
    expect(activeRunForSession([{ ...run, runId: 'other', sessionId: 'other', externalSessionId: 'other' }, run], '/repo/a', 'catalog-session', 'pi', 'pi:default')).toBe(run)
    expect(activeRunForSession(run, '/repo/b', 'catalog-session', 'pi', 'pi:default')).toBeNull()
    expect(activeRunForSession(run, '/repo/a', 'catalog-session', 'qoder')).toBeNull()
    expect(activeRunForSession(run, '/repo/a', 'catalog-session', 'pi', 'pi:other')).toBeNull()
    expect(activeRunForSession({ ...run, done: true }, '/repo/a', 'catalog-session', 'pi', 'pi:default')).toBeNull()
    expect(activeRunForSession({ ...run, cwd: undefined }, '', 'catalog-session', 'pi', 'pi:default')).toMatchObject({ runId: 'run-1' })
  })

  it('恢复 live run 时先加载同一 session 的已停止历史轮次', async () => {
    const calls: string[] = []
    const archived: ParsedTurn[] = [{ userText: '第一轮（已停止）', items: [] }]
    const archivedPage: SessionHistoryPage = {
      turns: archived,
      offset: 0,
      totalTurns: 1,
      hasOlder: false,
      completeness: 'complete'
    }
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
          return archivedPage
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

  it('preload 直接启动的新 focused run 会先绑定焦点，再恢复历史和待回答问题', async () => {
    const pendingQuestion: AgentQuestionRequest = {
      runId: 'run-claude',
      questionId: 'question-1',
      providerId: 'claude',
      questions: [{
        question: '继续执行？',
        header: '确认',
        multiSelect: false,
        options: [{ label: '继续', description: '继续当前任务' }]
      }]
    }
    const activeRun: ActiveRun = {
      runId: 'run-claude',
      providerId: 'claude',
      cwd: '/repo/claude',
      externalSessionId: 'session-claude',
      sessionId: 'session-claude',
      userText: '执行 Claude 任务',
      pendingQuestions: [pendingQuestion],
      items: [],
      done: false
    }
    const archived: ParsedTurn[] = [{ runId: 'older-run', userText: '上一轮', items: [], done: true }]
    const archivedPage: SessionHistoryPage = {
      turns: archived,
      offset: 0,
      totalTurns: 1,
      hasOlder: false,
      completeness: 'complete'
    }
    const calls: string[] = []
    let resolveHistory: ((page: SessionHistoryPage) => void) | undefined
    let replacement: { sessionId: string; parsed: ParsedTurn[]; activeRun: ActiveRun } | undefined

    const restoring = restoreFocusedRunSelection(activeRun, {
      prepareRunFocus: (runId) => calls.push(`prepare:${runId}`),
      selectContext: (context) => calls.push(`select:${context.providerId}:${context.cwd}:${context.sessionId}`),
      loadSession: async () => new Promise<SessionHistoryPage>((resolve) => {
        calls.push('load')
        resolveHistory = resolve
      }),
      replaceWithParsedSession: (sessionId, parsed, options) => {
        calls.push('replace')
        replacement = { sessionId, parsed, activeRun: options.activeRun }
      }
    })

    expect(calls).toEqual([
      'prepare:run-claude',
      'select:claude:/repo/claude:session-claude',
      'replace',
      'load'
    ])
    expect(replacement).toEqual({ sessionId: 'session-claude', parsed: [], activeRun })
    expect(replacement?.activeRun.pendingQuestions).toEqual([pendingQuestion])
    resolveHistory?.(archivedPage)
    await expect(restoring).resolves.toBe(true)
    expect(calls).toEqual([
      'prepare:run-claude',
      'select:claude:/repo/claude:session-claude',
      'replace',
      'load',
      'replace'
    ])
    expect(replacement).toEqual({ sessionId: 'session-claude', parsed: archived, activeRun })
  })

  it('focused run 恢复历史期间发生新的手工选择时，不用旧异步结果覆盖界面', async () => {
    const activeRun: ActiveRun = {
      runId: 'run-claude',
      providerId: 'claude',
      cwd: '/repo/claude',
      externalSessionId: 'session-claude',
      userText: '执行 Claude 任务',
      items: [],
      done: false
    }
    let current = true
    let resolveHistory: ((page: SessionHistoryPage | null) => void) | undefined
    const replacements: string[] = []
    const restoring = restoreFocusedRunSelection(activeRun, {
      prepareRunFocus: () => {},
      selectContext: () => {},
      loadSession: async () => new Promise<SessionHistoryPage | null>((resolve) => { resolveHistory = resolve }),
      replaceWithParsedSession: (sessionId) => replacements.push(sessionId),
      isCurrent: () => current
    })

    current = false
    resolveHistory?.(null)
    await expect(restoring).resolves.toBe(false)
    expect(replacements).toEqual(['session-claude'])
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
  it('Skill 和 MCP 与分析同组展示，并保留 MCP 真实连接状态', () => {
    const renderIntegrations = (
      mcps: ComponentProps<typeof Sidebar>['mcps'],
      mcpLive: ComponentProps<typeof Sidebar>['mcpLive']
    ) => renderToStaticMarkup(
      <Sidebar
        projects={[]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onAnalytics={() => {}}
        onSkills={() => {}}
        skillCount={3}
        onMcp={() => {}}
        mcps={mcps}
        mcpLive={mcpLive}
        onSettings={() => {}}
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
    expect(disabledHtml).not.toContain('class="kbd"')
    expect(disabledHtml).not.toContain('深色')
    expect(disabledHtml).not.toContain('浅色')
    expect(disabledHtml).not.toContain('诊断')
    expect(disabledHtml.indexOf('分析')).toBeLessThan(disabledHtml.indexOf('title="Skills"'))

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

  it('同名项目保留路径标识但 hover 不显示具体路径', () => {
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
        onTogglePin={() => {}}
        onArchive={() => {}}
        onAnalytics={() => {}}
        analyticsActive
      />
    )

    expect(html).toContain('<nav class="sb-nav" aria-label="主要视图">')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('<button type="button" class="sb-proj-head')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('class="ico sb-project-folder"')
    expect(html).toContain('aria-label="sample-workspace · /Users/example/IdeaProjects/sample-workspace"')
    expect(html).toContain('aria-label="sample-workspace · /Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace"')
    expect(html).toContain('data-project-path="/Users/example/IdeaProjects/sample-workspace"')
    expect(html).toContain('data-project-path="/Users/example/.treehouse/sample-workspace-3b0c3e/7/sample-workspace"')
    expect(html).not.toContain('class="ppath"')
    expect(html).not.toContain('title="sample-workspace')
  })

  it('没有会话的项目仍保留，并提供 Codex 风格的行内新建按钮', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/empty-project',
          name: 'empty-project',
          mtime: 2,
          sessions: [],
          pinnedAt: 10
        }]}
        activeCwd="/Users/example/empty-project"
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        onNewProjectChat={() => {}}
        onToggleProjectPin={() => {}}
        onRenameProject={() => {}}
        onRemoveProject={() => {}}
        onRevealProject={() => {}}
      />
    )

    expect(html).not.toContain('aria-label="添加项目"')
    expect(html).toContain('暂无会话')
    expect(html).not.toContain('class="cnt"')
    expect(html).not.toContain('class="pcnt"')
    expect(html).toContain('aria-label="在 empty-project 中新建会话 · /Users/example/empty-project"')
    expect(html).toContain('class="sb-proj-act sb-proj-new"')
    expect(html).toContain('class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"')
    expect(html).toContain('aria-label="管理项目 empty-project · /Users/example/empty-project"')
    expect(html).toContain('class="sb-proj-head on"')
    expect(html).toContain('class="ico sb-project-pin"')
  })

  it('不绑定项目会话以独立活动分组出现在左侧', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '',
          name: 'Chats',
          mtime: 2,
          sessions: [{ sessionId: 's-unbound', externalSessionId: 's-unbound', providerId: 'qoder', mtime: 2, preview: '无工作目录任务', count: 1 }]
        }]}
        activeCwd={null}
        activeSessionId="s-unbound"
        activeProviderId="qoder"
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).not.toContain('class="sb-proj-head on"')
    expect(html).not.toContain('class="sb-proj-row active"')
    expect(html).toContain('aria-label="Chats · 未关联工作目录"')
    expect(html).not.toContain('class="ppath"')
    expect(html).toContain('class="sb-sess active"')
    expect(html).toContain('class="sb-session-main"')
    expect(html).toContain('<span class="provider-glyph sb-provider" data-provider="qoder" role="img" aria-label="Qoder"')
    expect(html).toContain('<span class="sb-sesstext">无工作目录任务</span>')
    expect(html).toContain('class="sb-session-meta"')
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
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('class="sb-sess active running"')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-label="正在运行"')
    expect(html.match(/class="sb-running"/g)).toHaveLength(1)
  })

  it('置顶会话进入独立分组并带项目名，不在原项目分组里重复出现', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[
          {
            cwd: '/Users/example/rate-native',
            name: 'rate-native',
            mtime: 3,
            sessions: [
              { sessionId: 'pinned-1', externalSessionId: 'pinned-1', providerId: 'codex', mtime: 3, preview: '启动需求交付流程', count: 2, pinnedAt: 20 },
              { sessionId: 'plain-1', externalSessionId: 'plain-1', providerId: 'codex', mtime: 2, preview: '普通会话', count: 1 }
            ]
          },
          {
            cwd: '/Users/example/scry',
            name: 'scry',
            mtime: 1,
            sessions: [
              { sessionId: 'pinned-2', externalSessionId: 'pinned-2', providerId: 'claude', mtime: 1, preview: '侧边栏置顶方案', count: 1, pinnedAt: 30 }
            ]
          }
        ]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('<div class="sb-section">置顶</div>')
    expect(html).toContain('class="sb-pinned"')
    // 置顶按 pinnedAt 倒序，最近置顶的排最前。
    expect(html.indexOf('侧边栏置顶方案')).toBeLessThan(html.indexOf('启动需求交付流程'))
    expect(html).toContain('<span class="sb-sess-proj">rate-native</span>')
    expect(html).toContain('<span class="sb-sess-proj">scry</span>')
    // 项目目录独立于会话保留：scry 的会话被置顶后，项目仍显示为“会话已置顶”。
    expect(html).toContain('会话已置顶')
    expect(html).not.toContain('class="cnt"')
    expect(html).not.toContain('class="pcnt"')
    expect(html).not.toContain('class="sb-count"')
    expect(html.match(/class="sb-sess-proj"/g)).toHaveLength(2)
  })

  it('会话行提供置顶与存档按钮，且不再有右键删除菜单', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/project',
          name: 'project',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '会话一', count: 1 }]
        }]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-sess-row"')
    expect(html).toContain('aria-label="置顶会话：会话一"')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('aria-label="存档会话：会话一"')
    // 操作按钮必须是会话按钮的兄弟节点：button 里不能再嵌 button。
    expect(html).toContain('</button><span class="sb-sess-acts">')
    expect(html).not.toContain('ctxmenu')
    expect(html).not.toContain('删除会话')
    expect(html).not.toContain('aria-haspopup="menu"')
  })

  it('已置顶的会话按钮标注取消置顶', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[{
          cwd: '/Users/example/project',
          name: 'project',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '会话一', count: 1, pinnedAt: 5 }]
        }]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-act on"')
    expect(html).toContain('aria-label="取消置顶：会话一"')
    expect(html).toContain('aria-pressed="true"')
  })

  it('存档后给出可撤销提示', () => {
    const html = renderToStaticMarkup(
      <Sidebar
        projects={[]}
        activeCwd={null}
        onNewChat={() => {}}
        onPick={() => {}}
        onTogglePin={() => {}}
        onArchive={() => {}}
        archiveUndo={{ preview: '会话一' }}
        onUndoArchive={() => {}}
      />
    )

    expect(html).toContain('class="sb-undo"')
    expect(html).toContain('已存档「会话一」')
    expect(html).toContain('撤销')
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

  it('已完成且带原生轮次边界的 Provider 轮次提供分支入口', () => {
    const branchTurn: Turn = {
      runId: 'run-branch',
      userText: '保留到这里',
      done: true,
      providerTurnId: 'turn-selected',
      forkTurnId: 'turn-selected',
      items: [ev({
        id: 'branch-result',
        kind: 'harness',
        stage: 'result',
        providerId: 'codex',
        runtimeProvider: 'codex_cli'
      })]
    }
    const branchHtml = renderToStaticMarkup(
      <AssistantTurn turn={branchTurn} selectedId={null} onSelect={() => {}} onForkTurn={async () => {}} />
    )
    expect(branchHtml).toContain('aria-label="从此轮创建分支会话"')
    expect(branchHtml).toContain('在新会话中分支')
    expect(html).not.toContain('从此轮创建分支会话')
  })

  it('trace 树渲染出工具节点', () => {
    expect(html).toContain('Write')
    expect(html).toContain('Read')
    expect(html).toContain('Bash')
    expect(html).toContain('data-trace-event-id="e2"')
  })

  it('思考默认展开并以独立 disclosure 区别于最终回复', () => {
    expect(html).toContain('class="turn-flow"')
    expect(html).toContain('<details class="thinking" open="">')
    expect(html).toContain('class="think-head" aria-expanded="true"')
    expect(html).toContain('思考过程')
    expect(html).toContain('class="ico think-bulb"')
    expect(html).toContain('class="ico think-chevron"')
    expect(html).toContain('class="think-text md"><p><strong>先写文件再读回</strong></p>')
    expect(html).not.toContain('**先写文件再读回**')
    expect(html).not.toContain('class="think-mark"')
    expect(html).toContain('class="tool-group"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('class="tool-group-body" hidden=""')
    expect(html).toContain('class="tg-pill">3</span>')
    expect(html).toContain('Bash · Write · Read')
    expect(html).not.toContain('class="tg-dur">0ms</span>')
  })

  it('Pi 的连续思考增量只渲染成一个卡片，历史事件也能防御性合并', () => {
    const thinkingItems = [
      ev({ id: 'p1', kind: 'model', stage: 'thinking', thinking: 'need' }),
      ev({ id: 'p2', kind: 'model', stage: 'thinking', thinking: ' to' }),
      ev({ id: 'p3', kind: 'model', stage: 'thinking', thinking: ' apologize' })
    ]
    expect(coalesceAdjacentThinking(thinkingItems)).toEqual([
      expect.objectContaining({ id: 'p1', thinking: 'need to apologize' })
    ])

    const fragmentedHtml = renderToStaticMarkup(
      <AssistantTurn
        turn={{ runId: 'pi-fragments', userText: '继续', done: false, items: thinkingItems }}
        selectedId={null}
        onSelect={() => {}}
      />
    )
    expect(fragmentedHtml.match(/<details class="thinking"/g)).toHaveLength(1)
    expect(fragmentedHtml).toContain('<p>need to apologize</p>')
  })

  it('思考合并严格隔离 message 和父工具作用域', () => {
    const items = coalesceAdjacentThinking([
      ev({ id: 'a', kind: 'model', stage: 'thinking', thinking: 'root', messageId: 'm1' }),
      ev({ id: 'b', kind: 'model', stage: 'thinking', thinking: 'next', messageId: 'm2' }),
      ev({ id: 'c', kind: 'model', stage: 'thinking', thinking: 'child', messageId: 'm2', parentToolUseId: 'tool-1' })
    ])
    expect(items.map((item) => item.thinking)).toEqual(['root', 'next', 'child'])
  })

  it('工具脚注只在耗时数据完整时展示合计，并保留失败摘要', () => {
    const measuredTurn: Turn = {
      runId: 'measured-tools',
      userText: '执行检查',
      done: true,
      items: [
        ev({ id: 'bash-1', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', durationMs: 120 }),
        ev({ id: 'bash-2', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', durationMs: 380, isError: true }),
        ev({ id: 'read-1', kind: 'tool', stage: 'tool:Read', tool: 'Read', durationMs: 42 })
      ]
    }
    const measuredHtml = renderToStaticMarkup(
      <AssistantTurn turn={measuredTurn} selectedId={null} onSelect={() => {}} />
    )

    expect(measuredHtml).toContain('Bash×2 · Read')
    expect(measuredHtml).toContain('1 失败')
    expect(measuredHtml).toContain('title="工具调用耗时合计">542ms</span>')
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
    expect(filesHtml).not.toContain('open=""')
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
    expect(diffHtml.indexOf('class="turn-flow"')).toBeLessThan(diffHtml.indexOf('class="files-summary diff"'))
    expect(diffHtml.match(/class="files-summary/g)).toHaveLength(1)
    const filesHtml = diffHtml.match(/<details class="files-summary diff"[\s\S]*?<\/details>/)?.[0] ?? ''
    expect(filesHtml).not.toContain('R ·')
  })

  it('完整正文引用显示按需分页入口，不把 blob 内联进初始 DOM', () => {
    const html = renderToStaticMarkup(<RecorderContentPager label="output" contentRef={{
      storage: 'recorder-content-v1',
      sha256: 'a'.repeat(64),
      bytes: 900_000,
      encoding: 'utf8'
    }} />)
    expect(html).toContain('查看完整 output')
    expect(html).toContain('900,000 bytes')
    expect(html).not.toContain('完整 output · bytes')
  })

  it('Edit 卡展示本次工具输入的 action-level +/-，并明确不是 Git 净改动', () => {
    const editTurn: Turn = {
      ...turn,
      items: [
        ev({
          id: 'edit-1',
          kind: 'tool',
          stage: 'tool:Edit',
          tool: 'Edit',
          fileOp: 'edit',
          filePath: '/repo/src/a.ts',
          input: { file_path: '/repo/src/a.ts', old_string: 'one\ntwo\n', new_string: 'ONE\nTWO\nTHREE\n' }
        })
      ]
    }
    const editHtml = renderToStaticMarkup(<AssistantTurn turn={editTurn} selectedId={null} onSelect={() => {}} />)

    expect(editHtml).toContain('edit-lines')
    expect(editHtml).toContain('>+3<')
    expect(editHtml).toContain('>−2<')
    expect(editHtml).toContain('本次 Edit 工具输入：写入 new_string 3 行、替换掉 old_string 2 行')
    expect(editHtml).toContain('不是本轮 Git 净改动')
    // action-level 计数不得改写卡片语义：标题仍是工具名，不冒充「本轮改动」
    expect(editHtml).not.toContain('本轮改动')
  })

  it('Edit 卡只在轮次结束且该文件真的在本轮快照里时才接到 Diff 面板', () => {
    const editEvent = ev({
      id: 'edit-1',
      kind: 'tool',
      stage: 'tool:Edit',
      tool: 'Edit',
      fileOp: 'edit',
      filePath: '/repo/src/a.ts',
      input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' }
    })
    const diffEvent = ev({
      id: 'turn-diff',
      kind: 'harness',
      stage: 'turn_diff',
      turnDiff: {
        version: 1,
        status: 'captured',
        files: [{ path: '/repo/src/a.ts', added: 1, deleted: 1 }],
        repoRoot: '/repo',
        scope: '.',
        beforeAt: '2026-08-10T00:00:00.000Z',
        afterAt: '2026-08-10T00:00:01.000Z',
        captureMs: 9,
        cleanup: 'ok'
      }
    })
    const linkTitle = '点开工具输入，同时在右侧 Diff 中定位该文件的本轮改动'

    const linked = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, items: [editEvent, diffEvent] }}
        selectedId={null}
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(linked).toContain(linkTitle)

    // 运行中：本轮 Diff 还没定稿，不给假入口
    const running = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, done: false, items: [editEvent, diffEvent] }}
        selectedId={null}
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(running).not.toContain(linkTitle)

    // 该文件没有净改动：不联动，但 action-level 计数仍照实显示
    const otherFile = renderToStaticMarkup(
      <AssistantTurn
        turn={{ ...turn, items: [editEvent, { ...diffEvent, turnDiff: { ...diffEvent.turnDiff!, files: [{ path: '/repo/src/b.ts', added: 1, deleted: 0 }] } }] }}
        selectedId={null}
        onSelect={() => {}}
        onOpenDiff={() => {}}
      />
    )
    expect(otherFile).not.toContain(linkTitle)
    expect(otherFile).toContain('edit-lines')
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
    expect(reviewHtml).not.toContain('diff-file-head')
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

  it('本轮 Hook 位于输出之后、本轮文件之前，并复用逻辑调用聚合', () => {
    const outputIndex = html.indexOf('class="model-text md"')
    const hookIndex = html.indexOf('class="turn-hooks-summary"')
    const filesIndex = html.indexOf('class="files-summary"')

    expect(outputIndex).toBeGreaterThan(-1)
    expect(hookIndex).toBeGreaterThan(outputIndex)
    expect(filesIndex).toBeGreaterThan(hookIndex)
    expect(html).toContain('本轮 Hook')
    expect(html).not.toContain('<details class="turn-hooks-summary" open="">')
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

  it('本轮 Hook 按生命周期分组，并在周期内聚合同一处理器的调用次数', () => {
    const eventRouter = 'python3 /repo/.claude/hooks/event_router.py'
    const pair = (
      id: string,
      event: string,
      trigger: string,
      command: string,
      ts: string
    ): TraceEvent[] => [
      ev({ id: `${id}-start`, ts, kind: 'hook', stage: 'hook_started', hookId: id, hookEvent: event, hookName: trigger, hookCommand: command }),
      ev({ id: `${id}-response`, ts, kind: 'hook', stage: 'hook_response', hookId: id, hookEvent: event, hookName: trigger, hookCommand: command, hookOutcome: 'success' })
    ]
    const lifecycleTurn: Turn = {
      runId: 'run-hook-lifecycle',
      userText: '检查 Hook 周期',
      done: true,
      items: [
        ev({ id: 'bash', kind: 'tool', stage: 'tool:Bash', tool: 'Bash', toolUseId: 'bash' }),
        ev({ id: 'read', kind: 'tool', stage: 'tool:Read', tool: 'Read', toolUseId: 'read' }),
        ...pair('stop-router', 'Stop', 'Stop', eventRouter, '2026-08-05T11:43:14.621Z'),
        ...pair('stop-goal', 'Stop', 'Stop', 'goal-loop-stop', '2026-08-05T11:43:14.622Z'),
        ...pair('stop-entry', 'Stop', 'Stop', 'hook_entry', '2026-08-05T11:43:14.623Z'),
        ...pair('stop-pilot', 'Stop', 'Stop', 'qoder-loongsuite-pilot-hook.sh', '2026-08-05T11:43:14.624Z'),
        ...pair('post-read', 'PostToolUse', 'PostToolUse:Read', eventRouter, '2026-08-05T11:42:12.670Z'),
        ...pair('pre-bash', 'PreToolUse', 'PreToolUse:Bash', eventRouter, '2026-08-05T11:40:12.163Z'),
        ...pair('post-bash', 'PostToolUse', 'PostToolUse:Bash', eventRouter, '2026-08-05T11:40:12.830Z')
      ]
    }

    const hookHtml = renderToStaticMarkup(<AssistantTurn turn={lifecycleTurn} selectedId={null} onSelect={() => {}} />)
    const pre = hookHtml.indexOf('class="hook-phase-event">PreToolUse')
    const post = hookHtml.indexOf('class="hook-phase-event">PostToolUse')
    const stop = hookHtml.indexOf('class="hook-phase-event">Stop')
    const postPhaseHtml = hookHtml.slice(post, stop)

    expect(hookHtml).toContain('3 个周期 · 7 个处理器实例')
    expect(hookHtml).toContain('1 次触发 · 4 个处理器实例')
    expect(hookHtml.match(/class="turn-hook-phase"/g)).toHaveLength(3)
    expect(pre).toBeGreaterThan(-1)
    expect(post).toBeGreaterThan(pre)
    expect(stop).toBeGreaterThan(post)
    expect(postPhaseHtml.match(/event_router\.py/g)).toHaveLength(1)
    expect(postPhaseHtml).toContain('hook-run-count">2×')
    expect(postPhaseHtml).toContain('1 次 Bash')
    expect(postPhaseHtml).toContain('1 次 Read')
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
        selectedId={null}
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
    const url = 'https://alidocs.dingtalk.com/i/nodes/93NwLYZXWvxXroNzCNEKwjB58kyEqBQm?cid=7886930%3A4041342848&utm_source=im&utm_scene=team_space&iframeQuery=utm_medium%3D'
    const userHtml = renderToStaticMarkup(<UserMessage text={`技术方案：\n${url}`} />)
    expect(userHtml).toContain('class="md user-md"')
    expect(userHtml).toContain(`href="${url.replaceAll('&', '&amp;')}"`)
    expect(userHtml).toContain('技术方案')
  })

  it('最后一条已完成消息显示原生分支编辑入口', () => {
    const userHtml = renderToStaticMarkup(<UserMessage text="原消息" editable onEdit={async () => {}} />)

    expect(userHtml).toContain('aria-label="编辑最后一条消息"')
    expect(userHtml).toContain('title="编辑最后一条消息并从这里建立新分支"')
  })

  it('首轮停止且尚无 Provider 边界时仍显示重新开始编辑入口', () => {
    const stopped: Turn = { runId: 'run-stopped', userText: '好的', done: true, items: [] }
    const html = renderWelcome({ turns: [stopped], onEditLastTurn: async () => {} })

    expect(html).toContain('aria-label="编辑最后一条消息"')
    expect(html).toContain('title="编辑最后一条消息并重新开始"')
  })

  it('非首轮只有完整的当前与上一轮边界才显示分支编辑入口', () => {
    const previous: Turn = {
      runId: 'run-previous', userText: '第一条', done: true, items: [],
      providerTurnId: 'provider-previous', forkTurnId: 'fork-previous'
    }
    const current: Turn = {
      runId: 'run-current', userText: '第二条', done: true, items: [],
      providerTurnId: 'provider-current', forkTurnId: 'fork-current'
    }
    const branchHtml = renderWelcome({ turns: [previous, current], onEditLastTurn: async () => {} })
    const missingBoundaryHtml = renderWelcome({
      turns: [previous, { ...current, providerTurnId: undefined, forkTurnId: undefined }],
      onEditLastTurn: async () => {}
    })

    expect(branchHtml).toContain('title="编辑最后一条消息并从这里建立新分支"')
    expect(missingBoundaryHtml).not.toContain('aria-label="编辑最后一条消息"')
  })

  it('分页窗口中的第一条可见消息不能冒充会话首轮重新编辑', () => {
    const stopped: Turn = { runId: 'run-visible', userText: '可见尾部', done: true, items: [] }
    const html = renderWelcome({
      turns: [stopped],
      historyWindow: { sessionId: 'session', offset: 8, totalTurns: 9, hasOlder: true, completeness: 'partial' },
      onEditLastTurn: async () => {}
    })

    expect(html).not.toContain('aria-label="编辑最后一条消息"')
  })

  it('长用户消息用紧凑的折叠控件展示行数与展开状态', () => {
    const userHtml = renderToStaticMarkup(<UserMessage text={Array.from({ length: 13 }, (_, index) => `第 ${index + 1} 行`).join('\n')} />)

    expect(userHtml).toContain('class="expandbtn"')
    expect(userHtml).toContain('aria-expanded="false"')
    expect(userHtml).toContain('<span>展开全部</span>')
    expect(userHtml).toContain('<span class="expandmeta">13 行</span>')
    expect(userHtml).not.toContain('展开全部（')
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
    expect(chatHtml).toContain('aria-label="选择 Model 与 Effort"')
    expect(chatHtml).toContain('class="model-effort-model">Test Model · test-model')
    expect(chatHtml).toContain('class="model-effort-effort">高')
    expect(chatHtml).toContain('aria-label="权限"')
    const controls = chatHtml.match(/<div class="composer-controls"[\s\S]*?<div class="spacer"/u)?.[0] ?? ''
    const actions = chatHtml.match(/<div class="composer-action-controls"[\s\S]*?<button type="button" class="send"/u)?.[0] ?? ''
    expect(chatHtml).not.toContain('class="composer-top"')
    expect(chatHtml).not.toContain('class="composer-context"')
    expect(chatHtml).not.toContain('class="wdpick"')
    expect(controls).toContain('role="group"')
    expect(controls).toContain('aria-label="权限配置"')
    expect(controls).not.toContain('class="wdpick"')
    expect(controls).not.toContain('class="clipick"')
    expect(actions).toContain('class="clipick"')
    expect(actions).toContain('class="model-effort-picker"')
    expect(actions.indexOf('class="clipick"')).toBeLessThan(actions.indexOf('class="model-effort-picker"'))
    expect(chatHtml).toContain('aria-label="发送"')
    expect(chatHtml).toContain('M12 19V5m-7 7 7-7 7 7')
  })

  it('Pi 完全访问必须由用户明确选择，不把唯一权限静默当成当前值', () => {
    const reason = '当前 Provider 不支持所选模型、推理强度或权限，请重新选择'
    const chatHtml = renderWelcome({
      selectedAgentId: 'pi:default',
      runControls: { permissionMode: 'default' },
      runControlCatalog: {
        models: [{ model: { id: 'pi-model' }, label: 'Pi', efforts: [] }],
        permissions: [{ id: 'full_access', label: '本机完全访问', description: '继承本机用户权限' }]
      },
      sendBlockedReason: reason,
      input: '准备发送'
    })

    expect(chatHtml).toMatch(/<option value="default"[^>]*disabled=""[^>]*selected="">请选择权限<\/option>/)
    expect(chatHtml).toMatch(/<option value="full_access"[^>]*>本机完全访问<\/option>/)
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
  })

  it('Composer 直接说明阻塞发送的原因，并关联输入与发送按钮', () => {
    const reason = '当前 Provider 不可发送'
    const chatHtml = renderWelcome({ input: '保留这份草稿', sendBlockedReason: reason })
    const sendButton = chatHtml.match(/<button[^>]*class="send"[^>]*>/u)?.[0] ?? ''
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain('role="status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toMatch(/aria-label="描述任务"[^>]*aria-describedby="composer-status"/)
    expect(sendButton).toContain('aria-describedby="composer-status"')
    expect(sendButton).toContain(`title="${reason}"`)
    expect(sendButton).toContain('disabled=""')
  })

  it('发送失败后展示精确错误，不用静默吞掉点击结果', () => {
    const chatHtml = renderWelcome({
      input: '保留这份草稿',
      composerError: 'Provider 启动失败：认证已过期'
    })

    expect(chatHtml).toContain('class="composer-status is-error"')
    expect(chatHtml).toContain('role="alert"')
    expect(chatHtml).toContain('Provider 启动失败：认证已过期')
    expect(chatHtml).toMatch(/class="send"[^>]*aria-describedby="composer-status"/)
    expect(chatHtml).not.toMatch(/class="send"[^>]*disabled=""/)
  })

  it('可选模型后台读取时保持自动模型语义，不把 composer 伪装成阻塞态', () => {
    const chatHtml = renderWelcome({
      agents: [{
        id: 'claude', name: 'Claude Code', bin: 'claude', path: '/usr/local/bin/claude',
        health: { state: 'ready', transport: 'Agent SDK' }
      }],
      runControlsLoading: true,
      runControlCatalog: {
        models: [],
        permissions: RUN_CONTROL_PROPS.runControlCatalog.permissions
      }
    })

    expect(chatHtml).toMatch(/aria-label="选择 Model 与 Effort"[^>]*aria-busy="true"/)
    expect(chatHtml).toContain('自动模型')
    expect(chatHtml).toContain('正在后台读取可选模型；当前使用 Provider 默认模型')
    expect(chatHtml).not.toContain('读取模型…')
    expect(chatHtml).not.toContain('id="composer-status"')
    expect(chatHtml).not.toContain('当前 Provider 不可发送；草稿会保留')
    expect(chatHtml).toContain('aria-label="发送"')
  })

  it('缓存选择失效时说明原因并禁用发送', () => {
    const reason = '最后已知模型目录不包含当前模型、推理强度或权限，请重新选择'
    const chatHtml = renderWelcome({ input: '准备发送', sendBlockedReason: reason })

    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
  })

  it('Provider 确认不可用时在 Composer 展示探测错误', () => {
    const reason = '版本探测被信号 SIGKILL 终止'
    const chatHtml = renderWelcome({
      agents: [{
        id: 'claude', name: 'Claude Code', bin: 'claude', path: '/usr/local/bin/claude',
        health: { state: 'unavailable', transport: 'Agent SDK', lastError: 'CLI 不可用' }
      }],
      runControlsLoading: true,
      sendBlockedReason: reason,
      input: '准备发送'
    })
    expect(chatHtml).toContain('id="composer-status"')
    expect(chatHtml).toContain(reason)
    expect(chatHtml).not.toContain('当前 Provider 不可发送；草稿会保留')
  })

  it('切换会话时展示轻量加载态，不闪过新会话引导页或旧 transcript', () => {
    const chatHtml = renderWelcome({
      sessionLoading: true,
      turns: [{ ...turn, runId: 'old-run', userText: '旧会话内容' }],
      input: '切换期间保留的草稿'
    })

    expect(chatHtml).toContain('aria-busy="true"')
    expect(chatHtml).toContain('正在打开对话…')
    expect(chatHtml).toContain('正在打开对话，草稿已保留')
    expect(chatHtml).not.toContain('开始一次可追溯执行')
    expect(chatHtml).not.toContain('旧会话内容')
    expect(chatHtml).toContain('切换期间保留的草稿')
    expect(chatHtml).toMatch(/class="send"[^>]*disabled=""/)
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

    const chatHtml = renderWelcome({
      cwd: '/tmp/project',
      agents: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/usr/local/bin/claude',
        version: '2.1.170',
        transport: 'local-cli',
        health: { state: 'ready', transport: 'local-cli' }
      }],
      input: '/code',
      slashOpen: true,
      slashCmds: commands
    })
    expect(chatHtml).toContain('<span>Commands</span>')
    expect(chatHtml).toContain('开始一次可追溯执行')
    expect(chatHtml).toContain('新会话 · 本机证据')
    expect(chatHtml).not.toContain('NEW SESSION')
    expect(chatHtml).toContain('class="welcome-provider-field"')
    expect(chatHtml).toContain('class="welcome-provider-grid"')
    expect(chatHtml).toContain('class="welcome-provider is-selected"')
    expect(chatHtml).toContain('class="provider-glyph" data-provider="claude"')
    expect(chatHtml).toContain('data-tone="ok"')
    expect(chatHtml).not.toContain('welcome-section-head')
    expect(chatHtml).not.toContain('welcome-boundary')
    expect(chatHtml).not.toContain('welcome-provider-list')
    // Provider 行不再带右侧 chevron（chevronRight 的 path）
    expect(chatHtml).not.toContain('m9 6 6 6-6 6')
    expect(chatHtml).toContain('1/1 个 Provider 可用')
    expect(chatHtml).toContain('class="welcome-ready-meter"')
    expect(chatHtml).toContain('data-health="available"')
    expect(chatHtml).toContain('可用')
    expect(chatHtml).not.toContain('健康')
    expect(chatHtml).not.toContain('降级')
    expect(chatHtml).not.toContain('状态未知')
    expect(chatHtml).toContain('/usr/local/bin/claude')
    // 重新扫描是就绪表头右端的动作，不再只藏在 composer 的 Provider 选择器里
    expect(chatHtml).toContain('aria-label="重新扫描 PATH"')
    expect(chatHtml).toContain('重新扫描')
    expect(chatHtml).not.toContain('data-busy')
    // 项目选择只保留在 composer 上下文栏，不在 welcome 正文重复出现。
    expect(chatHtml).not.toContain('class="welcome-context"')
    expect(chatHtml).toContain('/tmp/project')
    expect(chatHtml).not.toContain('运行上下文')
    expect(chatHtml).not.toContain('最近工作目录')
    // 双标题已收敛：composer 不再顶一个「告诉 Agent 要完成什么」
    expect(chatHtml).not.toContain('告诉 Agent 要完成什么')
    expect(chatHtml).not.toContain('welcome-composer-heading')
    expect(chatHtml).toContain('aria-label="描述任务"')
    expect(chatHtml).not.toContain('Commands ·')
    expect(chatHtml).not.toContain('browser-use')
    expect(chatHtml).toContain('code-fix')
    expect(chatHtml).toContain('nextcr-code-review')
  })

  it('ChatView 在 0 agents 探测中与探测完成后使用不同的诚实状态', () => {
    const scanningHtml = renderWelcome({ agentScanning: true })
    expect(scanningHtml).toContain('data-tone="neutral"')
    expect(scanningHtml).toContain('正在检测本机 Provider')
    expect(scanningHtml).toContain('正在探测本机 agent CLI')
    expect(scanningHtml).not.toContain('Provider 就绪')
    expect(scanningHtml).not.toContain('未检测到可用 Provider')
    expect(scanningHtml).not.toContain('已发现')

    const detectedAgents = [{
      id: 'claude',
      name: 'Claude Code',
      bin: 'claude',
      path: '/usr/local/bin/claude'
    }, {
      id: 'pi:25f2d533d0a8b391',
      name: 'Pi · pi-agent',
      bin: 'pi-agent',
      path: '/Users/example/dev-agent/pi-agent/bin/pi-agent'
    }]
    const fastHtml = renderWelcome({
      agentScanning: true,
      agents: detectedAgents
    })
    // 快速 PATH 探测可能已经返回，但完整版本/descriptor 探测完成前不展示中间结果。
    expect(fastHtml).toContain('aria-busy="true"')
    expect(fastHtml).toContain('data-tone="neutral"')
    expect(fastHtml).toContain('正在检测本机 Provider')
    expect(fastHtml).toContain('正在探测本机 agent CLI')
    expect(fastHtml).toContain('data-busy="true"')
    expect(fastHtml).toContain('扫描中…')
    expect(fastHtml).not.toContain('2/2 个 Provider 可用')
    expect(fastHtml).not.toContain('data-health="available"')
    expect(fastHtml).not.toContain('/usr/local/bin/claude')
    expect(fastHtml).not.toContain('/Users/example/dev-agent/pi-agent/bin/pi-agent')

    const completeHtml = renderWelcome({ agentScanning: false })
    expect(completeHtml).toContain('data-tone="warn"')
    expect(completeHtml).toContain('未检测到可用 Provider')
    expect(completeHtml).toContain('完整探测未返回可用 agent CLI')
    expect(completeHtml).not.toContain('Provider 就绪')

    const detectedHtml = renderWelcome({
      agentScanning: false,
      agents: detectedAgents
    })
    expect(detectedHtml).toContain('2/2 个 Provider 可用')
    expect(detectedHtml).toContain('data-health="available"')
    expect(detectedHtml).toContain('/usr/local/bin/claude')
    expect(detectedHtml).toContain('/Users/example/dev-agent/pi-agent/bin/pi-agent')
    expect(detectedHtml).not.toContain('aria-busy="true"')
  })

  it('ChatView 将运行期细节收敛为可用 / 不可用两种 executable 状态', () => {
    const html = renderWelcome({
      agents: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/usr/local/bin/claude',
        health: { state: 'unknown', transport: 'Agent SDK' }
      }, {
        id: 'codex',
        name: 'Codex',
        bin: 'codex',
        path: '/usr/local/bin/codex',
        health: { state: 'unavailable', transport: 'app-server' }
      }]
    })
    expect(html).toContain('data-tone="warn"')
    expect(html).toContain('1/2 个 Provider 可用')
    expect(html).toContain('1 个 Provider 不可用；请检查 CLI 路径或重新扫描')
    expect(html).toContain('data-health="available"')
    expect(html).toContain('data-health="unavailable"')
    expect(html).toContain('可用')
    expect(html).toContain('不可用')
    expect(html).not.toContain('健康')
    expect(html).not.toContain('降级')
    expect(html).not.toContain('状态未知')
  })

  it('ChatView 将多个 Pi launcher 收进同一个 Provider 下的 Profile 列表', () => {
    const html = renderWelcome({
      selectedAgentId: 'pi:25f2d533d0a8b391',
      agents: [{
        id: 'claude',
        name: 'Claude Code',
        bin: 'claude',
        path: '/usr/local/bin/claude',
        health: { state: 'ready', transport: 'Agent SDK' }
      }, {
        id: 'pi:default',
        name: 'Pi',
        bin: 'pi',
        path: '/Users/example/.local/bin/pi',
        version: '0.84.2',
        health: { state: 'ready', transport: 'JSONL RPC subprocess' }
      }, {
        id: 'pi:25f2d533d0a8b391',
        name: 'Pi · pi-agent',
        bin: 'pi-agent',
        path: '/Users/example/dev-agent/pi-agent/bin/pi-agent',
        health: { state: 'ready', transport: 'JSONL RPC subprocess' }
      }]
    })

    expect(html).toContain('2/2 个 Provider 可用')
    expect(html).toContain('data-provider="pi"')
    expect(html).toContain('class="provider-glyph" data-provider="pi"')
    expect(html).toContain('aria-label="Pi，2 个 Profile"')
    expect(html).toContain('原生 Pi')
    expect(html).toContain('系统检测 · 0.84.2')
    expect(html).toContain('自定义 Profile · 版本未知')
    expect(html).toContain('aria-label="移除 Pi Profile：pi-agent"')
    expect(html).not.toContain('aria-label="移除 Pi Profile：原生 Pi"')
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
        agentLocked
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
    expect(chatHtml).toContain('title="同一会话不能切换 Agent；请新建会话后重新选择"')
    expect(chatHtml).toMatch(/class="clibtn"[^>]*disabled=""/)
    expect(chatHtml).toMatch(/aria-label="选择 Model 与 Effort"(?![^>]*disabled)/)
    expect(chatHtml).toMatch(/aria-label="权限"(?![^>]*disabled)/)
    expect(chatHtml).toContain('继续检查')
    expect(chatHtml).toContain('draft.png')
    expect(chatHtml).toContain('aria-label="放大查看图片 sent.png"')
    expect(chatHtml).not.toContain('<figcaption>sent.png</figcaption>')
    expect(chatHtml).toContain('class="user-attachment"')
    // 历史缩略图与草稿预览都按需解码：CSP 与远程图片阻断不变，只改解码时机。
    expect(chatHtml.match(/<img[^>]*loading="lazy"[^>]*decoding="async"/g)?.length).toBe(2)
    expect(chatHtml).toContain('排队')
  })

  it('切换会话会同时清除队列暂停和在途标记', () => {
    expect(resetQueuedPromptControl(7)).toEqual({ generation: 8, pending: false, inFlight: false })
  })

  it('Pi 分支请求保留当前 profile', () => {
    expect(buildForkSessionRequest({
      providerId: 'pi',
      sourceSessionId: 'session-1',
      sourceRunId: 'run-1',
      sourceProviderTurnId: 'turn-1',
      sourceForkTurnId: 'fork-1',
      permissionMode: 'default'
    }, 'pi:rotom')).toMatchObject({ providerId: 'pi', agentProfileId: 'pi:rotom' })
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

  it('手动刷新按 Provider 失效、Skill 回读、slash 重取的顺序执行', async () => {
    const calls: string[] = []

    await applyProviderCatalogRefresh({
      invalidateProviderContext: async () => { calls.push('invalidate') },
      refreshSkills: async () => { calls.push('skills') },
      retrySlash: () => calls.push('slash')
    })

    expect(calls).toEqual(['invalidate', 'skills', 'slash'])
  })

  it('Provider catalog 刷新失败也会清除旧 slash cache，且不会阻塞新会话', async () => {
    const calls: string[] = []

    await expect(applyProviderCatalogRefresh({
      invalidateProviderContext: async () => { throw new Error('main unavailable') },
      refreshSkills: async () => { calls.push('skills'); throw new Error('preload unavailable') },
      retrySlash: () => calls.push('slash')
    })).resolves.toBeUndefined()

    expect(calls).toEqual(['skills', 'slash'])
  })

  it('新建会话只脱离正在运行的会话，不调用 stop', async () => {
    const calls: string[] = []

    await applyNewConversationEffects({
      clearTurns: (options) => calls.push(`clear:${String(options?.preserveRunning)}`),
      newSession: async () => {
        calls.push('newSession')
        return true
      },
      refreshProviderCatalogs: async () => { calls.push('refreshCatalogs') },
      setActiveSessionId: (sessionId) => calls.push(`active:${String(sessionId)}`),
      setView: (view) => calls.push(`view:${view}`),
      focusComposer: () => calls.push('focus')
    })

    expect(calls).toEqual(['clear:undefined', 'newSession', 'active:null', 'view:chat', 'focus', 'refreshCatalogs'])
  })

  it('只采纳本视图发起那一轮新建的原生 session id', () => {
    const starts = new Map([['run-2', 'run-1']])
    // 本地壳 run-1 上重新发送：run-2 拿到原生 session 后必须把当前会话身份换过去。
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'native-1' }, 'run-1', starts)).toBe('native-1')
    // 发送后用户已经切到其他会话：不能劫持当前视图。
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'native-1' }, 'other', starts)).toBeNull()
    // 不是本视图发起的轮次，或者身份本来就一致：不动。
    expect(adoptLocalStartSessionId({ runId: 'run-9', sessionId: 'native-9' }, 'run-1', starts)).toBeNull()
    expect(adoptLocalStartSessionId({ runId: 'run-2', sessionId: 'run-1' }, 'run-1', starts)).toBeNull()
    expect(adoptLocalStartSessionId({ runId: 'run-2' }, 'run-1', starts)).toBeNull()
  })

  it('归档当前打开的会话后会回到新会话，避免后续发送被会话身份守卫拒绝', async () => {
    const calls: string[] = []

    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: true,
      activeSessionBusy: false,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive', 'undo', 'reload', 'reset'])

    calls.length = 0
    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: false,
      activeSessionBusy: false,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive', 'undo', 'reload'])

    calls.length = 0
    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return false },
      archivingActiveSession: true,
      activeSessionBusy: false,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })
    expect(calls).toEqual(['archive'])
  })

  // 真实回归：归档一个正在跑的当前会话曾经会 clearTurns + 新会话，把还在跑的轮次从视图里抹掉，
  // 用户看到“运行中”但时间线空白、停止按钮失效。
  it('归档正在跑的当前会话只改 catalog，不重置视图', async () => {
    const calls: string[] = []

    await applySessionArchiveEffects({
      archive: async () => { calls.push('archive'); return true },
      archivingActiveSession: true,
      activeSessionBusy: true,
      rememberUndo: () => calls.push('undo'),
      resetConversation: async () => { calls.push('reset') },
      reloadProjects: () => calls.push('reload')
    })

    expect(calls).toEqual(['archive', 'undo', 'reload'])
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

  it('使用结构化 intervention 展示所在轮次、问题、答案与结构化介入计数', () => {
    const completed: Turn = {
      ...askTurn,
      done: true,
      items: [
        ...askTurn.items,
        ev({
          id: 'human-intervention',
          runId: 'ask-run',
          ts: '2026-08-06T10:00:02.000Z',
          kind: 'human',
          stage: 'intervention',
          toolUseId: 'ask-tool',
          providerId: 'qoder',
          intervention: {
            kind: 'clarification',
            source: 'qoder:AskUserQuestion',
            resolution: 'answered',
            request: { ...pendingRequest, providerId: 'qoder', questionKind: 'clarification', source: 'qoder:AskUserQuestion' },
            response: {
              runId: 'ask-run',
              questionId: 'ask-tool',
              behavior: 'answered',
              answers: {
                '请选择验证方式': '自动验证',
                '请选择需要验证的能力': 'MCP, Skill'
              }
            },
            openedAt: '2026-08-06T10:00:00.000Z',
            closedAt: '2026-08-06T10:00:02.000Z',
            durationMs: 2000
          }
        })
      ]
    }
    const turnHtml = renderToStaticMarkup(<AssistantTurn turn={completed} selectedId={null} onSelect={() => {}} />)
    const overviewHtml = renderToStaticMarkup(
      <OverviewPanel turns={[completed]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(turnHtml).toContain('请选择验证方式')
    expect(turnHtml).toContain('自动验证')
    expect(turnHtml).toContain('MCP, Skill')
    expect(turnHtml).toContain('等待 2.0s')
    expect(turnHtml).toContain('human</span> <b>1 · 2Q</b>')
    expect(overviewHtml).toContain('1 次结构化介入')
    expect(overviewHtml).toContain('aria-label="结构化介入 1，展开明细"')
    expect(overviewHtml).toContain('T01')
  })
})

describe('OverviewPanel compact count', () => {
  it('展示当前会话的 compact 次数', () => {
    const compactTurn: Turn = {
      ...turn,
      items: [
        ...turn.items,
        ev({ id: 'compact-1', kind: 'harness', stage: 'context_compaction', compaction: { trigger: 'auto' } })
      ]
    }
    const html = renderToStaticMarkup(
      <OverviewPanel turns={[compactTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(html).toContain('<span class="fname">Compact</span><span class="dim">1 次</span>')
  })
})

describe('OverviewPanel 渲染：verdict 卡 + context + top tools + 文件足迹 + git diff + 累计 + sqlite 分析', () => {
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
  it('verdict 卡：聚合 token + 无报错无危险 → 只声明 Provider 轮次已结束', () => {
    expect(html).toContain('3.0k tok') // 跨轮累计本会话 token（含 cache）
    expect(html).not.toContain('$0.1234')
    expect(html).toContain('1 轮已结束')
    expect(html).toContain('overview-verdict ok') // 无 error/danger → ok
    expect(html).toContain('轮次已结束')
    expect(html).toContain('Provider 终态不代表用户目标完成')
    expect(html).toContain('输入+输出+缓存')
    expect(html).toContain('reasoning 单列')
    expect(html).toMatch(/<b>reason<\/b>—/)
    expect(html).toContain('overview-metric-foot') // cache·r/cache·w/reason/api foot
  })

  it('百万级 token 总量、输入及缓存使用 M，小数值和缺失证据保持原样', () => {
    const largeTokenTurn: Turn = {
      runId: 'large-token-usage',
      userText: 'probe',
      done: true,
      items: [ev({
        id: 'large-token-result',
        kind: 'harness',
        stage: 'result',
        providerId: 'claude',
        tokensIn: 10_597_700,
        tokensOut: 43_900,
        cacheReadTokens: 9_038_700,
        cacheCreationTokens: 0
      })]
    }
    const largeTokenHtml = renderToStaticMarkup(
      <OverviewPanel turns={[largeTokenTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(largeTokenHtml).toContain('<strong>19.7M tok</strong>')
    expect(largeTokenHtml).toContain('<strong>10.6M / 43.9k</strong>')
    expect(largeTokenHtml).toContain('<b>cache·r</b>9.0M')
    expect(largeTokenHtml).toContain('<b>cache·w</b>0')
    expect(largeTokenHtml).toContain('<b>reason</b>—')
  })

  it('Codex 缓存已包含在 input 时展示真实 Token 加总口径', () => {
    const codexTurn: Turn = {
      runId: 'codex-token-label',
      userText: 'probe',
      done: true,
      items: [ev({
        id: 'codex-result',
        kind: 'harness',
        stage: 'result',
        providerId: 'codex',
        runtimeProvider: 'codex_cli',
        tokensIn: 100,
        tokensOut: 20,
        cacheReadTokens: 80
      })]
    }
    const codexHtml = renderToStaticMarkup(
      <OverviewPanel turns={[codexTurn]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(codexHtml).toContain('输入（含缓存）+输出')
    expect(codexHtml).not.toContain('输入+输出+缓存')
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

    expect(mergedHtml).toContain('1 轮已结束')
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

  it('上下文推断证据必须显式标注，不能冒充 Provider 精确值', () => {
    const inferred: Turn = {
      runId: 'inferred-context',
      userText: 'x',
      done: true,
      items: [ev({
        id: 'inferred-context-result',
        kind: 'harness',
        stage: 'result',
        contextTokens: 103_176,
        contextUsageSource: 'qoder_native_transcript',
        contextUsageQuality: 'inferred',
        modelUsage: [{ model: 'ultimate', contextWindow: 1_000_000 }]
      })]
    }
    const inferredHtml = renderToStaticMarkup(
      <OverviewPanel turns={[inferred]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(inferredHtml).toContain('103.2k / 1.0M')
    expect(inferredHtml).toContain('推断：Provider usage 比例换算')
  })

  it('旧上下文缺少 provenance 时明确标记质量未知，不默认精确', () => {
    const legacy: Turn = {
      runId: 'legacy-context',
      userText: 'x',
      done: true,
      items: [ev({
        id: 'legacy-context-result',
        kind: 'harness',
        stage: 'result',
        contextTokens: 50_000,
        modelUsage: [{ model: 'legacy-model', contextWindow: 200_000 }]
      })]
    }
    const legacyHtml = renderToStaticMarkup(
      <OverviewPanel turns={[legacy]} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )

    expect(legacyHtml).toContain('旧记录：证据质量未标记')
    expect(legacyHtml).not.toContain('精确：最近一轮 Provider 上下文用量')
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
    expect(html).toContain('aria-label="跳到第 1 轮，对话中共 3 次工具/Skill/MCP/子 Agent 调用"')
    expect(html).toContain('创建并读回文件')
    expect(html).toContain('turn-call-group turn-call-toggle timing')
    expect(html).toContain('title="查看耗时来源与统计范围"')
    expect(html).toContain('<span class="turn-call-count">2 项</span>')
    expect(html).toContain('aria-label="展开第 1 轮耗时明细"')
    expect(html).toContain('aria-controls="turn-timing-1"')
    expect(html).toContain('aria-label="MCP 0，无明细"')
    expect(html).toContain('aria-label="Skill 0，无明细"')
    expect(html).toContain('title="本轮子 Agent 调用 0 次"')
    expect(html).toContain('aria-label="Hooks 1，展开明细"')
    expect(html).toContain('aria-label="文件 2，展开明细"')
    expect(html.indexOf('turn-call-toggle timing')).toBeLessThan(html.indexOf('turn-call-toggle mcp'))
    expect(html).not.toContain('turn-call-group tool')
    expect(html).toContain('turn-call-group agent empty')
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
    expect(turnsPanel).toContain('aria-label="文件 2，展开明细"')
    expect(turnsPanel).toContain('aria-label="Hooks 1，展开明细"')
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
    const turnCalls = multiMcpHtml.slice(multiMcpHtml.indexOf('turn-call-list'), multiMcpHtml.indexOf('每轮仅展示'))

    expect(turnCalls).toContain('aria-label="MCP 2，展开明细"')
    expect(turnCalls).toContain('turn-call-count">2</span>')
  })

  it('本轮文件足迹优先展示 Git 净改动与行数；无 diff 时诚实降级到工具证据', () => {
    const toolOnlyHtml = renderToStaticMarkup(
      <TurnFileFootprint files={[{ path: '/repo/src/a.ts', read: 2, inferredRead: 1, write: 1, edit: 0 }]} />
    )
    const diffHtml = renderToStaticMarkup(
      <TurnFileFootprint
        files={[
          { path: '/tmp/list_after.md', read: 2, inferredRead: 2, write: 0, edit: 0 },
          { path: '/repo/raw/list.md', read: 1, inferredRead: 0, write: 0, edit: 1 },
          { path: '/repo/wiki-log.md', read: 0, inferredRead: 0, write: 1, edit: 0 }
        ]}
        turnDiff={{
          version: 1,
          status: 'captured',
          files: [
            { path: '/repo/raw/list.md', added: 0, deleted: 2, change: 'modified' },
            { path: '/repo/wiki-log.md', added: 3, deleted: 0, change: 'added' },
            { path: '/repo/obsolete.md', added: 0, deleted: 10, patch: 'diff --git a/obsolete.md b/obsolete.md\ndeleted file mode 100644' }
          ],
          repoRoot: '/repo',
          beforeAt: 'before',
          afterAt: 'after',
          captureMs: 1,
          cleanup: 'ok'
        }}
      />
    )
    const zeroDiffHtml = renderToStaticMarkup(
      <TurnFileFootprint
        files={[{ path: '/tmp/validation.txt', read: 1, inferredRead: 1, write: 0, edit: 0 }]}
        turnDiff={{
          version: 1,
          status: 'captured',
          files: [],
          beforeAt: 'before',
          afterAt: 'after',
          captureMs: 1,
          cleanup: 'ok'
        }}
      />
    )
    const emptyHtml = renderToStaticMarkup(<TurnFileFootprint files={[]} />)

    expect(toolOnlyHtml).toContain('本轮文件足迹（工具证据）')
    expect(toolOnlyHtml).toContain('1 files')
    expect(toolOnlyHtml).toContain('R1 ~R1 W1')
    expect(diffHtml).toContain('本轮改动（Git 证据）')
    expect(diffHtml).toContain('3 files')
    expect(diffHtml).toContain('raw/list.md')
    expect(diffHtml).toContain('+0 −2')
    expect(diffHtml).toContain('wiki-log.md')
    expect(diffHtml).toContain('+3 −0')
    expect(diffHtml).toContain('obsolete.md')
    expect(diffHtml).toContain('fbadge e')
    expect(diffHtml).toContain('>E</span>')
    expect(diffHtml).toContain('fbadge w')
    expect(diffHtml).toContain('>W</span>')
    expect(diffHtml).toContain('fbadge d')
    expect(diffHtml).toContain('>D</span>')
    expect(diffHtml).not.toContain('>Δ</span>')
    expect(diffHtml).not.toContain('list_after.md')
    expect(zeroDiffHtml).toContain('本轮改动（Git 证据）')
    expect(zeroDiffHtml).toContain('0 files')
    expect(zeroDiffHtml).not.toContain('validation.txt')
    expect(zeroDiffHtml).not.toContain('本轮文件足迹（工具证据）')
    expect(emptyHtml).toContain('暂无文件工具证据')
  })

  it('每轮文件数量优先采用 turn_diff，不再把 Bash 临时文件数量冒充实际改动数', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[{
          runId: 'diff-files',
          userText: '修改文件',
          done: true,
          items: [ev({
            id: 'diff-files-snapshot',
            runId: 'diff-files',
            kind: 'harness',
            stage: 'turn_diff',
            turnDiff: {
              version: 1,
              status: 'captured',
              files: [
                { path: '/repo/a.md', added: 1, deleted: 0 },
                { path: '/repo/b.md', added: 0, deleted: 2 }
              ],
              beforeAt: 'before',
              afterAt: 'after',
              captureMs: 1,
              cleanup: 'ok'
            }
          })]
        }]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )

    expect(html).toContain('aria-label="文件 2，展开明细"')
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

  it('工作区未提交改动段：独立语义 + 工具足迹对照（check 碰过 / alert 未碰）', () => {
    expect(html).toContain('工作区未提交改动（vs HEAD）')
    expect(html).toContain('2 files · +6 −2')
    expect(html).toContain('gd-add') // probe.txt 在工具足迹内
    expect(html).toContain('gd-del') // other.ts 被改但工具没碰过
    expect(html).toContain('当前工作树对比 HEAD（含未跟踪新文件，不含 ignored）')
    // 没有任何 captured turnDiff 时，不能把工作区 diff 冒充成本会话改动
    expect(html).not.toContain('本会话改动')
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
    // Skill 无结构化证据时不能声称整段会话从未使用，也不应静默隐藏。
    expect(html).toContain('尚未观测到 Skill 调用或加载证据')
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

  it('总览只保留纵览内容，不再提供账单卫士和 MCP 信任入口', () => {
    expect(html).not.toContain('面板视图')
    expect(html).not.toContain('账单卫士')
    expect(html).not.toContain('MCP 信任')
    expect(html).toContain('轮次数据')
    expect(html).toContain('会话数据')
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

describe('OverviewPanel 本会话改动：来自各轮 turnDiff 累计，不冒充工作区 diff', () => {
  const diffTurn = (runId: string, files: { path: string; added: number; deleted: number }[]): Turn => ({
    runId,
    userText: `轮 ${runId}`,
    done: true,
    items: [
      ev({
        id: `${runId}-diff`,
        runId,
        kind: 'harness',
        stage: 'turn_diff',
        turnDiff: {
          version: 1,
          status: 'captured',
          files,
          repoRoot: '/repo',
          scope: '.',
          beforeAt: '2026-08-10T00:00:00.000Z',
          afterAt: '2026-08-10T00:00:01.000Z',
          captureMs: 7,
          cleanup: 'ok'
        }
      })
    ]
  })
  const turns = [
    diffTurn('r1', [{ path: '/repo/src/a.ts', added: 3, deleted: 1 }, { path: '/repo/src/b.ts', added: 2, deleted: 0 }]),
    diffTurn('r2', [{ path: '/repo/src/a.ts', added: 5, deleted: 4 }])
  ]

  it('汇总 unique files 与各轮累计 +/−，并标明是累计活动量', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={turns}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        onOpenSessionDiff={() => {}}
      />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).toContain('2 files · +10 −5')
    expect(html).toContain('src/a.ts')
    expect(html).toContain('>+8<')
    expect(html).toContain('>−5<')
    expect(html).toContain('2 轮')
    expect(html).toContain('+/− 是累计活动量，不是当前工作树净改动')
    expect(html).toContain('gdrow click')
  })

  it('工作区未提交改动仍是独立段，两个数字不互相顶替', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={turns}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
        gitDiff={[{ path: '/repo/src/a.ts', added: 4, deleted: 5 }]}
        onOpenSessionDiff={() => {}}
      />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).toContain('2 files · +10 −5')
    expect(html).toContain('工作区未提交改动（vs HEAD）')
    expect(html).toContain('1 files · +4 −5')
  })

  it('没有 onOpenSessionDiff 时不渲染假可点行', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel turns={turns} selected={null} onSelect={() => {}} usage={null} stats={null} />
    )
    expect(html).toContain('本会话活动（2 轮快照累计）')
    expect(html).not.toContain('gdrow click')
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
    expect(html).toContain('overview-verdict warn')
    expect(html).toContain('处工具报错')
    expect(html).not.toContain('overview-verdict ok') // 失败会话顶绿色健康判决 = 假状态
  })

  it('高危操作 → 卡 bad + 判决 bad + 危险 pillar 标"审计·未拦截"（非 blocked）', () => {
    const { t } = dangerTurn()
    const html = panel(t)
    expect(html).toContain('overview-verdict bad')
    expect(html).toContain('overview-verdict-line')
    expect(html).toContain('1 处高危操作')
    expect(html).toContain('rm -rf 强删')
    expect(html).toContain('审计·未拦截') // P3 是观测不拦截，诚实标注
    expect(html).toContain('class="overview-metric overview-metric-action bad"')
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
    expect(html).toContain('<span class="sdot bad"></span><strong>1 处高危操作</strong>')
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
    expect(html).toContain('正在等待 Provider 终态')
    expect(html).not.toContain('轮已结束')
    expect(html).not.toContain('Provider 终态不代表用户目标完成')
    expect(html).toContain('overview-verdict warn')
  })

  it('输入输出、缓存与 API 缺失部分轮次时显示已捕获值但不加不等号', () => {
    const html = renderToStaticMarkup(
      <OverviewPanel
        turns={[
          {
            runId: 'coverage-1',
            userText: 'one',
            done: true,
            items: [ev({ id: 'coverage-result-1', kind: 'harness', stage: 'result', tokensIn: 10, tokensOut: 5, reasoningTokens: 4, cacheReadTokens: 7, cacheCreationTokens: 2, durationApiMs: 1000 })]
          },
          {
            runId: 'coverage-2',
            userText: 'two',
            done: true,
            items: [ev({ id: 'coverage-result-2', kind: 'harness', stage: 'result', tokensIn: 3 })]
          }
        ]}
        selected={null}
        onSelect={() => {}}
        usage={null}
        stats={null}
      />
    )

    expect(html).toContain('<strong>13 / 5</strong>')
    expect(html).toContain('<b>cache·r</b>7')
    expect(html).toContain('<b>cache·w</b>2')
    expect(html).toContain('<b>reason</b>4')
    expect(html).toContain('<b>api</b>1.0s')
    expect(html).not.toContain('≥')
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
      ev({
        id: 's-hook',
        kind: 'hook',
        stage: 'hook_response',
        hookId: 's-hook',
        hookEvent: 'PostToolUse',
        hookName: 'PostToolUse:Read',
        hookCommand: 'event_router.py',
        hookOutcome: 'success'
      }),
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

  it('每轮调用展示介入、MCP、Skill、子 Agent、Hooks、文件计数，五项明细默认收起', () => {
    const turnCallHtml = html.slice(html.indexOf('turn-call-list'), html.indexOf('每轮展示结构化介入'))
    expect(html).toContain('每轮调用')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle intervention')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle mcp')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle skill')
    expect(turnCallHtml).toContain('turn-call-group agent')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle hooks')
    expect(turnCallHtml).toContain('turn-call-group turn-call-toggle file')
    expect(turnCallHtml).toContain('aria-expanded="false"')
    expect(turnCallHtml).toContain('aria-label="结构化介入 0，无明细"')
    expect(turnCallHtml).toContain('aria-label="MCP 1，展开明细"')
    expect(turnCallHtml).toContain('aria-label="Skill 1，展开明细"')
    expect(turnCallHtml).toContain('title="本轮子 Agent 调用 1 次"')
    expect(turnCallHtml).toContain('aria-label="Hooks 1，展开明细"')
    expect(turnCallHtml).toContain('aria-label="文件 1，展开明细"')
    expect(turnCallHtml).not.toContain('turn-call-group tool')
    expect(turnCallHtml).not.toContain('humanizer')
    expect(turnCallHtml).not.toContain('tracker.call')
  })

  it('会话总调用拆分为工具、MCP、Skill、子 Agent，四项之和等于总数', () => {
    expect(html).toContain('4 calls')
    expect(html).toContain('<span>调用</span><strong>4</strong>')
    expect(html).toContain('工具 1 · MCP 1 · Skill 1 · 子Agent 1')
    expect(html).toContain('TOP TOOLS<span class="more">工具 1 · MCP 1</span>')
  })

  it('用量报告不在总览展示', () => {
    expect(html).not.toContain('用量报告')
    expect(html).not.toContain('复制 Markdown')
    expect(html).not.toContain('本会话 token 用量解释')
  })
})

import { ArchivedChatsPanel, CapabilitiesModal, filterSkillsForScope, McpModal, SettingsModal, SkillsModal } from './Modals'

describe('McpModal 渲染：pending 不伪装 connected', () => {
  it('设置弹窗把当前主题呈现为可访问的单选项', () => {
    const html = renderToStaticMarkup(
      <SettingsModal theme="light" onThemeChange={() => {}} onSessionsChanged={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('class="modal settings-modal"')
    expect(html).toContain('role="radiogroup" aria-label="界面主题"')
    expect(html).toContain('class="theme-option active" role="radio" aria-checked="true"')
    expect(html).toContain('浅色')
    expect(html).toContain('立即应用到全部视图')
  })

  it('设置弹窗用左侧 tab 分区，默认停在外观', () => {
    const html = renderToStaticMarkup(
      <SettingsModal theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onClose={() => {}} />
    )
    expect(html).toContain('class="settings-rail" aria-label="设置分区"')
    expect(html).toContain('class="settings-tab active"')
    expect(html).toContain('已存档会话')
    // 首帧还没读到索引，不展示假的 0。
    expect(html).not.toContain('<span class="cnt">0</span>')
  })

  it('已存档会话读不到索引时说明不可用，而不是显示没有存档', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel projects={null} onRefresh={async () => {}} onSessionsChanged={() => {}} />
    )
    expect(html).toContain('会话索引不可用')
    expect(html).not.toContain('没有已存档会话')
  })

  it('确实没有已存档会话时给出引导空态，并禁用全部删除', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel projects={[]} onRefresh={async () => {}} onSessionsChanged={() => {}} />
    )
    expect(html).toContain('没有已存档会话')
    expect(html).toContain('class="arch-danger" disabled=""')
  })

  it('已存档会话按项目分组，每行给出取消存档与永久删除', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel
        projects={[{
          cwd: '/Users/example/rate-native',
          name: 'rate-native',
          mtime: 2,
          sessions: [{
            sessionId: 's1',
            externalSessionId: 's1',
            providerId: 'codex',
            mtime: 2,
            preview: '迁移埋点上报 MCP',
            count: 24,
            archivedAt: Date.UTC(2026, 7, 25, 9, 12)
          }]
        }]}
        onRefresh={async () => {}}
        onSessionsChanged={() => {}}
      />
    )
    expect(html).toContain('class="arch-group-head"')
    expect(html).toContain('rate-native')
    expect(html).toContain('1 个会话')
    expect(html).toContain('迁移埋点上报 MCP')
    expect(html).toContain('24 轮')
    expect(html).toContain('存档于 2026年8月25日')
    expect(html).toContain('取消存档')
    expect(html).toContain('aria-label="永久删除：迁移埋点上报 MCP"')
  })

  it('存档时间缺失时如实标注未知', () => {
    const html = renderToStaticMarkup(
      <ArchivedChatsPanel
        projects={[{
          cwd: '',
          name: 'Chats',
          mtime: 1,
          sessions: [{ sessionId: 's1', externalSessionId: 's1', providerId: 'claude', mtime: 1, preview: '临时问题', count: 1 }]
        }]}
        onRefresh={async () => {}}
        onSessionsChanged={() => {}}
      />
    )
    expect(html).toContain('存档时间未知')
  })

  it('Skill 与 MCP 首次后台读取时立即展示诚实加载态', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[]}
        capability={null}
        refreshing
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
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('pending')
    expect(html).not.toContain('connected')
  })

  it('Fleet 把运行态与认证作为独立证据，配置只在已关闭时标注，并以 targetId 关联操作结果', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'fleet-target', name: 'fleet', scope: 'project', transport: 'http', detail: 'https://mcp.example.test', enabled: false }]}
        status={{ 'fleet-target': { ok: false, error: 'timeout', authOk: true } }}
        live={[{ name: 'fleet', status: 'connected', tools: 2 }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['fleet-target'] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    const row = html.slice(html.indexOf('mcp-fleet__row'), html.indexOf('</tbody>'))
    expect(html).not.toContain('<th scope="col">配置</th>')
    expect(html).not.toContain('<th scope="col">本次测试</th>')
    expect(html).toContain('<th scope="col">Provider 运行态</th>')
    expect(html).toContain('<th scope="col">认证</th>')
    expect(row).toContain('inventory-scope--off')
    expect(row).toContain('已关闭')
    expect(row).toContain('已连接')
    expect(row).not.toContain('2 tools')
    expect(row).toContain('测试失败 · timeout')
    expect(row).toContain('认证成功，运行状态已刷新')
  })

  it('Pi lazy 与缓存态保持非连接语义，不伪装 connected 或 failed', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[
          { name: 'cached', scope: 'effective', transport: 'http', detail: 'https://mcp.example.test', enabled: true },
          { name: 'lazy', scope: 'effective', transport: 'stdio', detail: 'lazy-mcp', enabled: true }
        ]}
        status={{}}
        live={[
          { name: 'cached', status: 'cached', tools: 7 },
          { name: 'lazy', status: 'disconnected', tools: 0 }
        ]}
        refreshing={false}
        capability={{
          providerId: 'pi', agentProfileId: 'pi:test', cwd: '/repo', mode: 'read', state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).toContain('Pi 有效配置（合并后）')
    expect(html).toContain('aria-label="刷新 Pi MCP 快照"')
    expect(html).toContain('刷新快照')
    expect(html).toContain('不会主动连接 lazy server')
    expect(html).toContain('仅缓存元数据')
    expect(html).not.toContain('7 tools')
    expect(html).toContain('这不是实时连接证据')
    expect(html).toContain('尚未连接')
    expect(html).toContain('lazy server 尚未建立连接')
    expect(html).not.toContain('inventory-state--connected')
    expect(html).not.toContain('inventory-state--failed')
  })

  it('只读 Provider 不再展示无效的单项测试按钮，改为明确检测全部运行态', () => {
    const html = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'github', status: 'connected', tools: 7 }]}
        refreshing={false}
        capability={{
          providerId: 'codex',
          cwd: '/repo',
          mode: 'read',
          state: 'degraded',
          reason: '配置已读取；刷新后读取 Codex app-server 运行状态',
          data: { configured: [], runtime: null }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )

    expect(html).toContain('aria-label="检测全部 MCP 运行状态"')
    expect(html).toContain('检测全部')
    expect(html).toContain('已连接')
    expect(html).not.toContain('7 tools')
    expect(html).not.toContain('测试连接')
    expect(html).toContain('不提供单项直测')
  })

  it('检测全部与逐项直测始终展示进行中和最终结果', () => {
    const refreshingHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[]}
        refreshing
        capability={{
          providerId: 'codex',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(refreshingHtml).toContain('正在检测全部 MCP…')
    expect(refreshingHtml).toContain('检测中…')
    expect(refreshingHtml).toMatch(/class="modal-refresh mcp-refresh-all"[^>]*disabled=""/)
    expect(refreshingHtml).toContain('aria-label="检测全部 MCP 运行状态"')

    const failedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { ok: false, error: 'initialize timeout' } }}
        live={[{ name: 'github', status: 'connected', tools: 3 }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [] }
        }}
        onTest={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(failedHtml).toContain('connected')
    expect(failedHtml).toContain('role="alert"')
    expect(failedHtml).toContain('测试失败 · initialize timeout')
    expect(failedHtml).toContain('title="本次测试失败 · initialize timeout"')
  })

  it('仅对 Provider 声明支持的 needs-auth 目标提供重新认证与可访问反馈', () => {
    const capability: ComponentProps<typeof McpModal>['capability'] = {
      providerId: 'codex',
      cwd: '/repo',
      mode: 'read',
      state: 'ready',
      data: {
        configured: [],
        runtime: [],
        operations: { authenticate: ['github-target'] }
      }
    }
    const authenticatingHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: true } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(authenticatingHtml).toContain('aria-label="重新认证 MCP github"')
    expect(authenticatingHtml).toMatch(/<button class="mcp-test" disabled="" aria-label="重新认证 MCP github">/)
    expect(authenticatingHtml).toContain('等待浏览器完成授权…')
    expect(authenticatingHtml).toContain('role="status" aria-live="polite"')

    const successHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: true } }}
        live={[{ name: 'github', status: 'connected' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(successHtml).toContain('认证成功，运行状态已刷新')
    expect(successHtml).not.toContain('aria-label="重新认证 MCP github"')

    const unverifiedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: true, authError: '连接状态仍为 pending' } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(unverifiedHtml).toContain('授权流程已完成；运行状态未确认 · 连接状态仍为 pending')
    expect(unverifiedHtml).toContain('role="status" aria-live="polite"')

    const failedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'github-target', name: 'github', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{ 'github-target': { authenticating: false, authOk: false, authError: '用户取消授权' } }}
        live={[{ name: 'github', status: 'needs-auth' }]}
        refreshing={false}
        capability={capability}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(failedHtml).toContain('role="alert" aria-live="polite"')
    expect(failedHtml).toContain('认证失败 · 用户取消授权')
  })

  it('OAuth Client 未注册和不支持认证的 Provider 只展示被动指引', () => {
    const clientRegistrationHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'remote-target', name: 'remote', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'remote', status: 'needs-client-registration' }]}
        refreshing={false}
        capability={{
          providerId: 'opencode',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['remote-target'] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(clientRegistrationHtml).toContain('需配置 OAuth Client')
    expect(clientRegistrationHtml).toContain('需在 Provider 中配置 OAuth Client ID')
    expect(clientRegistrationHtml).not.toContain('aria-label="重新认证 MCP remote"')

    const unsupportedHtml = renderToStaticMarkup(
      <McpModal
        mcps={[{ targetId: 'remote-target', name: 'remote', scope: 'user', transport: 'http', detail: 'https://mcp.example.test', enabled: true }]}
        status={{}}
        live={[{ name: 'remote', status: 'needs-auth' }]}
        refreshing={false}
        capability={{
          providerId: 'claude',
          cwd: '/repo',
          mode: 'manage',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: [] } }
        }}
        onTest={() => {}}
        onReauthenticate={() => {}}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(unsupportedHtml).toContain('请在 Provider 客户端完成认证')
    expect(unsupportedHtml).not.toContain('aria-label="重新认证 MCP remote"')
  })
})

describe('CapabilitiesModal 精简能力页', () => {
  const sharedProps: ComponentProps<typeof CapabilitiesModal> = {
    view: 'skills',
    onViewChange: () => {},
    skills: [],
    skillCapability: { providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [] },
    mcps: [],
    status: {},
    live: [],
    mcpRefreshing: false,
    mcpCapability: {
      providerId: 'qoder',
      cwd: '/repo',
      mode: 'read',
      state: 'ready',
      data: { configured: [], runtime: [], operations: { authenticate: [] } }
    },
    onTestMcp: () => {},
    onRefreshMcp: () => {},
    onClose: () => {}
  }

  it('Skills 只保留双来源、名称和描述', () => {
    const html = renderToStaticMarkup(
      <CapabilitiesModal
        {...sharedProps}
        skills={[
          { name: 'project-skill', dir: '/repo/SKILL.md', scope: 'project', description: '项目能力说明', enabled: true },
          { name: 'provider-skill', dir: 'qoder:builtin', scope: 'qoder', description: 'Provider 能力', enabled: true }
        ]}
      />
    )

    expect(html).toContain('role="tablist" aria-label="能力类型"')
    expect(html).toContain('role="tablist" aria-label="Skill 来源"')
    expect(html).toContain('项目能力说明')
    expect(html).not.toContain('/repo/SKILL.md')
    expect(html).not.toContain('Provider 能力')
    expect(html).not.toContain('搜索')
    expect(html).not.toContain('个结果')
    expect(html).not.toContain('刷新 MCP 运行状态')
  })

  it('MCP 不显示列头和工具数量，已关闭归入运行态，并保留真实工具明细与状态认证按钮', () => {
    const html = renderToStaticMarkup(
      <CapabilitiesModal
        {...sharedProps}
        view="mcp"
        mcps={[
          { targetId: 'connected-target', name: 'connected', scope: 'project', transport: 'http', detail: 'https://mcp.example.test', enabled: true },
          { targetId: 'auth-target', name: 'auth', scope: 'project', transport: 'http', detail: 'https://auth.example.test', enabled: true },
          { targetId: 'disabled-target', name: 'disabled', scope: 'project', transport: 'stdio', detail: 'disabled', enabled: false }
        ]}
        live={[
          { name: 'connected', status: 'connected', tools: 2, toolNames: ['tool_a', 'tool_b'] },
          { name: 'auth', status: 'needs-auth' }
        ]}
        mcpCapability={{
          providerId: 'qoder',
          cwd: '/repo',
          mode: 'read',
          state: 'ready',
          data: { configured: [], runtime: [], operations: { authenticate: ['auth-target'] } }
        }}
        onReauthenticateMcp={() => {}}
      />
    )

    expect(html).not.toContain('<table')
    expect(html).not.toContain('Server / 来源')
    expect(html).not.toContain('Provider 运行态')
    expect(html).not.toContain('2 tools')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('tool_a')
    expect(html).toContain('tool_b')
    expect(html).toContain('inventory-state--disabled')
    expect(html).toContain('已关闭')
    expect(html).toContain('class="capability-auth capability-auth--required"')
    expect(html).toContain('需要认证')
  })
})

describe('Skill/MCP 操作能力渲染', () => {
  it('Skill 清单只呈现发现结果，不渲染配置状态、开关与账号证据', () => {
    const html = renderToStaticMarkup(
      <SkillsModal
        skills={[
          { name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: true },
          { name: 'user-home', dir: '/home-skill', scope: 'user', description: 'shared', enabled: true }
        ]}
        capability={{ providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('class="inventory-switch"')
    expect(html).not.toContain('skill-ledger__status')
    expect(html).not.toContain('配置状态')
    expect(html).not.toContain('inventory-account')
    expect(html).toContain('inventory-modal--skills')
    expect(html).toContain('aria-label="Skills 查询上下文"')
    expect(html).toContain('<strong>qoder</strong>')
    expect(html).toContain('<code title="/repo">/repo</code>')
    expect(html).toContain('尚未观测')
    expect(html).toContain('1 个结果')
    expect(html).toContain('发现证据')
    expect(html).toContain('Scry 只读取、不改写 Skill 配置')
    expect(html).toContain('role="tablist" aria-label="Skill 来源"')
    expect(html).toContain('项目 Skill <span>1</span>')
    expect(html).toContain('用户 Skill <span>1</span>')
    expect(html).not.toContain('user-home')
    expect(filterSkillsForScope([
      { name: 'project-audit', dir: '/repo', scope: 'project', description: 'audit', enabled: true },
      { name: 'user-home', dir: '/home', scope: 'user', description: 'shared', enabled: true }
    ], 'user')).toEqual([{ name: 'user-home', dir: '/home', scope: 'user', description: 'shared', enabled: true }])
  })

  it('不丢弃 Provider 原生 Skill scope', () => {
    const providerSkill = {
      name: 'scry-e2e-audit',
      dir: '/repo/.opencode/skills/scry-e2e-audit',
      scope: 'opencode',
      description: 'Repository audit',
      enabled: true
    }
    const html = renderToStaticMarkup(
      <SkillsModal
        skills={[providerSkill]}
        capability={{ providerId: 'qoder', cwd: '/repo', mode: 'read', state: 'ready', data: [providerSkill] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )

    expect(filterSkillsForScope([providerSkill], 'provider')).toEqual([providerSkill])
    expect(html).toContain('Provider Skill <span>1</span>')
    expect(html).toContain('scry-e2e-audit')
    expect(html).toContain('inventory-scope--unknown')
  })

  it('可管理 Provider 也不再渲染 Skill 开关，MCP 面板保持 connected 真值', () => {
    const skillHtml = renderToStaticMarkup(
      <SkillsModal
        skills={[{ name: 'scry-e2e-audit', dir: '/skill', scope: 'project', description: 'audit', enabled: false }]}
        capability={{ providerId: 'claude', cwd: '/repo', mode: 'manage', state: 'ready', data: [] }}
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(skillHtml).not.toContain('type="checkbox"')
    expect(skillHtml).not.toContain('已关闭')
    expect(skillHtml).not.toContain('可管理')

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
        onRefresh={() => {}}
        onClose={() => {}}
      />
    )
    expect(mcpHtml).not.toContain('type="checkbox"')
    expect(mcpHtml).not.toContain('运行态只读')
    expect(mcpHtml).toContain('aria-label="MCP 查询上下文"')
    expect(mcpHtml).toContain('<strong>opencode</strong>')
    expect(mcpHtml).toContain('<code title="/repo">/repo</code>')
    expect(mcpHtml).toContain('connected')
    expect(mcpHtml).toContain('只暴露原生 MCP 配置/运行状态')
  })
})

import { AnalyticsView } from './AnalyticsView'

describe('AnalyticsView 渲染：T3 风格用量分析', () => {
  const aggregate = {
    inputTokens: 1000, outputTokens: 200, cacheReadTokens: 600, cacheWriteTokens: 100, reasoningTokens: 50,
    costUsd: 1.25, turns: 2, usageRows: 2,
    inputKnownRows: 2, outputKnownRows: 2, cacheReadKnownRows: 2, cacheWriteKnownRows: 2, reasoningKnownRows: 2,
    tokenKnownRows: 2, costKnownRows: 2,
    exactCostRows: 0, providerReportedCostRows: 1, estimatedCostRows: 1, inferredCostRows: 0
  }
  const analytics = {
    status: 'ready' as const,
    rangeDays: 30 as const,
    fromDay: '2026-08-05',
    toDay: '2026-09-03',
    observedAt: 1,
    days: ['2026-08-05', '2026-09-03'],
    totals: aggregate,
    byDay: [
      { day: '2026-08-05', ...aggregate },
      { day: '2026-09-03', ...aggregate }
    ],
    dailyByProvider: [
      { day: '2026-08-05', provider: 'anthropic' as const, ...aggregate },
      { day: '2026-09-03', provider: 'anthropic' as const, ...aggregate },
      { day: '2026-08-05', provider: 'codex' as const, ...aggregate },
      { day: '2026-09-03', provider: 'codex' as const, ...aggregate }
    ],
    byProvider: [
      { provider: 'anthropic' as const, model: null, ...aggregate },
      { provider: 'codex' as const, model: null, ...aggregate }
    ],
    byModel: [
      { provider: 'anthropic' as const, model: 'claude-sonnet', ...aggregate },
      { provider: 'codex' as const, model: 'gpt-5', ...aggregate }
    ]
  }
  const html = renderToStaticMarkup(
    <AnalyticsView
      analytics={analytics}
      rangeDays={30}
      loading={false}
      error={null}
      onRangeChange={() => {}}
      onRefresh={() => {}}
      onBack={() => {}}
    />
  )

  it('展示时间范围、返回、刷新、Raw Cost 和面积趋势', () => {
    expect(html).toContain('<h1>用量</h1>')
    expect(html).toContain('2026-08-05 至 2026-09-03')
    expect(html).toContain('aria-label="分析时间范围"')
    expect(html).toContain('aria-label="返回对话"')
    expect(html).toContain('aria-label="刷新分析数据"')
    expect(html).toContain('RAW TOKEN COST')
    expect(html).toContain('$1.25')
    expect(html).toContain('每日成本趋势')
    expect(html).toContain('usage-chart-area')
    expect(html).toContain('usage-chart-line')
    expect(html).toContain('Anthropic')
    expect(html).toContain('Codex')
  })

  it('展示真实摘要与紧凑模型明细，不展示旧四章节和诊断', () => {
    expect(html).toContain('已处理 Token')
    expect(html).toContain('缓存输入')
    expect(html).toContain('已观测输入')
    expect(html).toContain('缓存写入')
    expect(html).toContain('推理 50')
    expect(html).toContain('claude-sonnet')
    expect(html).toContain('gpt-5')
    expect(html).not.toContain('<th>Provider</th>')
    expect(html).not.toContain('风险与盲区')
    expect(html).not.toContain('诊断')
  })

  it('Qoder 的模式名和未归因项在模型明细中合并为一个 Qoder 行', () => {
    const qoderAggregate = {
      ...aggregate,
      costUsd: null,
      costKnownRows: 0,
      exactCostRows: 0,
      providerReportedCostRows: 0,
      estimatedCostRows: 0,
      inferredCostRows: 0
    }
    const groupedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          byProvider: [...analytics.byProvider, { provider: 'qoder', model: null, ...qoderAggregate }],
          byModel: [
            ...analytics.byModel,
            { provider: 'qoder', model: 'ultimate', ...qoderAggregate },
            { provider: 'qoder', model: 'efficient', ...qoderAggregate },
            { provider: 'qoder', model: null, ...qoderAggregate },
            { provider: 'qoder', model: 'lite', ...qoderAggregate }
          ]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const breakdownHtml = groupedHtml.slice(groupedHtml.indexOf('<section class="usage-breakdown">'))

    expect(breakdownHtml).toContain('<b title="Qoder">Qoder</b>')
    expect(breakdownHtml.match(/provider-glyph usage-provider-mark is-qoder/g)).toHaveLength(1)
    expect(breakdownHtml).not.toContain('title="ultimate"')
    expect(breakdownHtml).not.toContain('title="efficient"')
    expect(breakdownHtml).not.toContain('title="lite"')
    expect(breakdownHtml).not.toContain('title="未归因"')
  })

  it('成本来源使用文案标注，不在数字上追加证据符号', () => {
    expect(html).toContain('Provider 报告成本 + 估算成本')
    expect(html).not.toContain('>P≈</sup>')
    expect(html).toContain('成本来源与 Token 覆盖状态见行内说明')
    expect(html).toContain('aria-describedby="usage-chart-instructions"')
  })

  it('精确成本与 Provider 报告成本保持不同证据文案', () => {
    const exactHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: { ...aggregate, exactCostRows: 2, providerReportedCostRows: 0, estimatedCostRows: 0 },
          byProvider: [{ provider: 'anthropic', model: null, ...aggregate, exactCostRows: 2, providerReportedCostRows: 0, estimatedCostRows: 0 }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const providerReportedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: { ...aggregate, exactCostRows: 0, providerReportedCostRows: 2, estimatedCostRows: 0 },
          byProvider: [{ provider: 'codex', model: null, ...aggregate, exactCostRows: 0, providerReportedCostRows: 2, estimatedCostRows: 0 }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(exactHtml).toContain('<small>精确成本 · 2 轮</small>')
    expect(providerReportedHtml).toContain('<small>Provider 报告成本 · 2 轮</small>')
    expect(providerReportedHtml).not.toContain('>P</sup>')
  })

  it('混合成本来源不被优先级分支吞掉', () => {
    const mixed = {
      ...aggregate,
      costKnownRows: 4,
      exactCostRows: 1,
      providerReportedCostRows: 1,
      estimatedCostRows: 1,
      inferredCostRows: 1
    }
    const mixedHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{ ...analytics, totals: mixed, byProvider: [{ provider: 'codex', model: null, ...mixed }] }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(mixedHtml).toContain('精确成本 + Provider 报告成本 + 估算成本 + 推断成本')
    expect(mixedHtml).not.toContain('>P≈†</sup>')
  })

  it('部分 Token 在总览、Provider 和明细中都显式显示为已知下界', () => {
    const partial = {
      ...aggregate,
      outputTokens: null,
      outputKnownRows: 0
    }
    const partialHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: partial,
          byProvider: [{ provider: 'anthropic', model: null, ...partial }],
          byModel: [{ provider: 'anthropic', model: 'claude-sonnet', ...partial }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(partialHtml).toContain('<b>1.00K</b>')
    expect(partialHtml).not.toContain('≥1.00K')
    expect(partialHtml).toContain('已知下界 · 2/2 条明细有 Token')
    expect(partialHtml).toContain('Token 已知下界')
    expect(partialHtml).toContain('class="is-lower-bound"')
    expect(partialHtml).not.toContain('/ 活跃日')
  })

  it('稀疏缺失日和显式未知日沿基线连续连接，但保留无记录语义', () => {
    const unavailableCost = {
      ...aggregate,
      costUsd: null,
      costKnownRows: 0,
      exactCostRows: 0,
      providerReportedCostRows: 0,
      estimatedCostRows: 0,
      inferredCostRows: 0
    }
    const gapHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          days: ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
          dailyByProvider: [
            { day: '2026-08-05', provider: 'codex', ...aggregate },
            { day: '2026-08-07', provider: 'codex', ...unavailableCost },
            { day: '2026-08-08', provider: 'codex', ...aggregate }
          ],
          byProvider: [{ provider: 'codex', model: null, ...aggregate }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(gapHtml).toContain('data-missing-days="2"')
    expect(gapHtml).toContain('usage-chart-line')
    expect(gapHtml).toContain('usage-chart-area')
    expect(gapHtml).toContain('无记录日沿基线连接以保持走势连续，但不代表实际值为零')
  })

  it('未知成本不画成零值趋势，小额非零成本不显示成 $0.00 且最大横条占满', () => {
    const unknownAggregate = {
      ...aggregate,
      costUsd: null,
      costKnownRows: 0,
      providerReportedCostRows: 0,
      estimatedCostRows: 0
    }
    const unknownHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: unknownAggregate,
          byDay: analytics.byDay.map((row) => ({ ...row, ...unknownAggregate })),
          dailyByProvider: analytics.dailyByProvider.map((row) => ({ ...row, ...unknownAggregate })),
          byProvider: analytics.byProvider.map((row) => ({ ...row, ...unknownAggregate })),
          byModel: analytics.byModel.map((row) => ({ ...row, ...unknownAggregate }))
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )
    const small = { ...aggregate, costUsd: 0.001 }
    const smallCostHtml = renderToStaticMarkup(
      <AnalyticsView
        analytics={{
          ...analytics,
          totals: small,
          dailyByProvider: analytics.dailyByProvider.map((row) => ({ ...row, ...small })),
          byProvider: [{ provider: 'codex', model: null, ...small }]
        }}
        rangeDays={30}
        loading={false}
        error={null}
        onRangeChange={() => {}}
        onRefresh={() => {}}
      />
    )

    expect(unknownHtml).toContain('该时间范围没有可绘制的成本数据')
    expect(unknownHtml).not.toContain('usage-chart-area')
    expect(unknownHtml).not.toContain('usage-chart-line')
    expect(smallCostHtml).toContain('&lt;$0.01')
    expect(smallCostHtml).toContain('$0.0010')
    expect(smallCostHtml).toContain('style="width:100%"')
  })
})

describe('附件预览 data URL 复用', () => {
  it('同一附件对象只构造一次 data URL，不同对象各自构造', () => {
    const attachment = {
      kind: 'image' as const,
      name: 'shot.png',
      mimeType: 'image/png' as const,
      dataBase64: 'aGVsbG8=',
      size: 5
    }
    const first = attachmentSrc(attachment)
    expect(attachmentSrc(attachment)).toBe(first)
    expect(first).toBe('data:image/png;base64,aGVsbG8=')
    const other = attachmentSrc({ ...attachment, dataBase64: 'aGk=' })
    expect(other).toBe('data:image/png;base64,aGk=')
  })
})
