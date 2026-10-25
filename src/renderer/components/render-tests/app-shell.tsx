import * as shared from './shared'
const { describe, it, expect, renderToStaticMarkup, App } = shared

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
    expect(html).toContain('今天想构建什么？')
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