import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, OverviewPanel, TurnFileFootprint, ev, turn } = shared
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
  it('verdict 卡：聚合 token + 无报错无危险 → 极简展示 Provider 轮次终态', () => {
    expect(html).toContain('<strong>3.0k</strong>') // 跨轮累计本会话 token（含 cache）
    expect(html).not.toContain('$0.1234')
    expect(html).toContain('overview-verdict ok') // 无 error/danger → ok
    expect(html).toContain('轮次已结束')
    expect(html).toContain('输入+输出+缓存')
    expect(html).not.toContain('reasoning 单列')
    expect(html).not.toContain('overview-metric-foot')
  })
it('百万级 token 总量使用 M，不再单独展示输入/输出', () => {
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

    expect(largeTokenHtml).toContain('<strong>19.7M</strong>')
    expect(largeTokenHtml).not.toContain('<strong>19.7M tok</strong>')
    expect(largeTokenHtml).not.toContain('<strong>10.6M / 43.9k</strong>')
    expect(largeTokenHtml).not.toContain('overview-metric-foot')
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

    expect(mergedHtml).toContain('轮次已结束')
    expect(mergedHtml).not.toContain('轮已捕获')
    expect(mergedHtml).toContain('<strong>35</strong>')
    expect(mergedHtml).not.toContain('<strong>47</strong>')
  })
it('上下文段：最近一轮占用 ÷ 窗口（诚实单条，不伪造三色分段）', () => {
    expect(html).toContain('上下文')
    expect(html).toContain('claude-opus-4-8')
    expect(html).toContain('<b>87.0k</b><span> / 200.0k</span>')
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

    expect(inferredHtml).toContain('<b>103.2k</b><span> / 1.0M</span>')
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
    expect(unknownHtml).not.toContain('<b>50.0k</b><span> / 200.0k</span>')
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
            { server: 'workitem', action: 'query_workitem_detail', tool: 'mcporter:workitem.query_workitem_detail' },
            { server: 'workitem', action: 'get_workitem_comments', tool: 'mcporter:workitem.get_workitem_comments' }
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


})