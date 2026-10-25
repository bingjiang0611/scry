import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, ViewChrome } = shared

describe('ViewChrome 顶栏', () => {
  it('隐藏 Provider 状态，只保留项目与面板入口', () => {
    const html = renderToStaticMarkup(
      <ViewChrome
        cwd={null}
        showSummary
        showPanel
        onToggleSummary={() => {}}
        onTogglePanel={() => {}}
      />
    )
    expect(html).not.toContain('tb-agent-status')
    expect(html).not.toContain('正在检测 agent')
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