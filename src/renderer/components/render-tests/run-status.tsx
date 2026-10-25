import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, ModelEffortPicker, RunControlSelect, renderWelcome } = shared
type Turn = shared.Turn

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

  it('Provider 结束后仍保持 busy 与排队，只展示记录收口而非生成或完成', () => {
    const closing: Turn = {
      ...runningTurn,
      items: [...runningTurn.items, {
        id: 'provider-ended', runId: runningTurn.runId, ts: '', kind: 'harness', stage: 'runtime:provider_ended'
      }]
    }
    const html = renderWelcome({ turns: [closing], busy: true, input: '下一条' })
    expect(html).toContain('记录收口中')
    expect(html).toContain('Provider 已结束，正在保存文件差异与记录；新消息继续排队')
    expect(html).toContain('加入队列')
    expect(html).toContain('data-stop-tone="finalizing"')
    expect(html).toMatch(/class="stop run-status-stop" disabled=""/)
    expect(html).not.toContain('md streaming')
    expect(html).not.toContain('class="skeleton"')
    expect(closing.done).toBe(false)
    const completed = renderWelcome({ turns: [{ ...closing, done: true }], busy: false })
    expect(completed).not.toContain('记录收口中')
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

  // 时间线保留已加载的数据，但长历史正文按视口挂载。这里描述 renderer
  // 的数据范围，不冒称所有 Provider 的 main 读取都已经分页。
  it('分页历史说明时间线已加载范围，并保留取回更早轮次的入口', () => {
    const html = renderWelcome({
      turns: [runningTurn],
      busy: false,
      historyWindow: { sessionId: 's1', offset: 460, totalTurns: 500, hasOlder: true, completeness: 'partial' },
      onLoadOlderTurns: () => {}
    })
    expect(html).toContain('history-window-note')
    expect(html).toContain('时间线已加载最近')
    expect(html).not.toContain('仅挂载最近')
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

  it('Model 与 Effort 组合入口显示当前值，权限使用自定义审批入口', () => {
    const html = renderWelcome({ turns: [runningTurn], busy: true })
    expect(html).toContain('class="model-effort-model">自动模型')
    expect(html).toContain('class="model-effort-effort">默认')
    expect(html).toContain('class="permission-mode-trigger"')
    expect(html).toContain('rc-value" aria-hidden="true">默认审批')
    expect(html).not.toContain('<select')
  })

  it('权限浮层同时说明审批方式、风险和当前选择', () => {
    const html = renderToStaticMarkup(
      <RunControlSelect
        ariaLabel="权限"
        value="full_access"
        options={[
          { value: 'default', label: '默认审批', description: '危险操作会暂停并请求你的确认' },
          { value: 'auto_review', label: '自动审查', description: '由 Provider 的原生审查器判断是否放行' },
          { value: 'full_access', label: '完全访问', description: '跳过审批并允许 Agent 直接执行操作' }
        ]}
        tone="danger"
        onChange={() => {}}
        open
      />
    )
    expect(html).toContain('如何批准 Agent 操作？')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('class="permission-mode-option is-selected is-danger"')
    expect(html).toContain('跳过审批并允许 Agent 直接执行操作')
    expect(html).toContain('aria-selected="true"')
  })

  it('只有一种权限模式时明确说明 Provider 限制，不暗示还有隐藏选项', () => {
    const html = renderToStaticMarkup(
      <RunControlSelect
        ariaLabel="权限"
        value="default"
        options={[
          { value: 'default', label: '请选择权限', disabled: true },
          {
            value: 'full_access',
            label: '本机完全访问',
            description: 'Pi 没有内置沙箱；launcher、Extension 与工具继承当前本机用户权限'
          }
        ]}
        onChange={() => {}}
        open
      />
    )
    expect(html).toContain('permission-mode-popover is-single-option')
    expect(html).toContain('当前 Agent 仅支持此权限模式')
    expect(html).not.toContain('如何批准 Agent 操作？')
    expect(html.match(/请选择权限/g)).toHaveLength(2)
    expect(html).toContain('本机完全访问')
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

    const modelIndex = html.indexOf('class="model-effort-current-model"')
    const effortIndex = html.indexOf('class="model-effort-current-effort"')
    expect(modelIndex).toBeGreaterThan(-1)
    expect(effortIndex).toBeGreaterThan(modelIndex)
    expect(html).toContain('class="model-effort-field-label">模型')
    expect(html).toContain('class="model-effort-field-label">推理强度')
    expect(html).toContain('class="model-effort-current-effort">高')
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