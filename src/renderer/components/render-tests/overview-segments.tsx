import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, OverviewPanel, ev } = shared
type Turn = shared.Turn

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

  it('每轮调用展示报错、介入、MCP、Skill、子 Agent、Hooks、文件计数，常规明细默认收起', () => {
    const turnStart = html.indexOf('turn-call-list')
    const sessionStart = html.indexOf('id="overview-session-panel"')
    expect(sessionStart).toBeGreaterThan(turnStart)
    const turnCallHtml = html.slice(turnStart, sessionStart)
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
    expect(html).not.toContain('<span>调用</span><strong>4</strong>')
    expect(html).not.toContain('工具 1 · MCP 1 · Skill 1 · 子Agent 1')
    expect(html).toContain('TOP TOOLS<span class="more">工具 1 · MCP 1</span>')
  })

  it('用量报告不在总览展示', () => {
    expect(html).not.toContain('用量报告')
    expect(html).not.toContain('复制 Markdown')
    expect(html).not.toContain('本会话 token 用量解释')
  })
})