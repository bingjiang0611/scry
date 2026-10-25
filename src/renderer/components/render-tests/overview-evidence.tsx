import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, OverviewPanel, ev, turn } = shared
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
it('不再展示底部本会话 Token 用量区块，保留文件足迹', () => {
    expect(html).not.toContain('本会话 Token 用量')
    expect(html).not.toContain('仅聚合当前会话已加载的轮次；不会混入其他会话')
    expect(html).not.toContain('<span class="fchip">1 turns</span>')
    expect(html).toContain('overview-file-footprint')
  })
it('会话数据只聚合当前会话，不混入 usage.jsonl 与 SQLite 的跨会话累计', () => {
    expect(html).toContain('<strong>3.0k</strong>')
    expect(html).not.toContain('<strong>1.5k / 200</strong>')
    expect(html).not.toContain('累计 Token 用量')
    expect(html).not.toContain('3.4k tok')
    expect(html).not.toContain('SQLite 历史累计')
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