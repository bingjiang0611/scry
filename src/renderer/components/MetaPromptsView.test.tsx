import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MetaPromptsView } from './MetaPromptsView'
import { Sidebar } from './Sidebar'

const renderLibrary = (raw: string | null) => {
  vi.stubGlobal('window', { localStorage: { getItem: () => raw } })
  return renderToStaticMarkup(<MetaPromptsView onBack={() => {}} onInsert={() => {}} />)
}

afterEach(() => vi.unstubAllGlobals())

describe('Meta Prompts view', () => {
  it('starts with a real empty state, with no samples or favorites', () => {
    const html = renderLibrary(null)
    expect(html).toContain('还没有提示词')
    expect(html).toContain('0 条提示词')
    expect(html).not.toContain('收藏')
    expect(html).not.toContain('先写方案，再开始实现')
    expect(html).not.toContain('常用提示词，随取随用')
    expect(html).not.toContain('个人提示词库 · 保存在本机')
    expect(html).not.toContain('不必创建 Skill')
    expect(html).toContain('新建提示词')
  })

  it('renders stored prompts as plain text with copy, edit and insert actions', () => {
    const html = renderLibrary(JSON.stringify([{ id: 'one', title: 'test <script>', body: '<script>alert(1)</script>\n\n正文' }]))
    expect(html).toContain('test &lt;script&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('编辑提示词')
    expect(html).toContain('删除提示词')
    expect(html).toContain('复制提示词')
    expect(html).toContain('放入当前会话')
    expect(html).not.toContain('收藏')
  })

  it('does not present corrupt storage as empty or allow overwriting it', () => {
    const html = renderLibrary('invalid json')
    expect(html).toContain('提示词库无法读取')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('0 条提示词')
    expect(html).not.toContain('还没有提示词')
  })

  it('puts the entry below MCP and marks the current view', () => {
    const html = renderToStaticMarkup(<Sidebar projects={[]} activeCwd={null} onNewChat={() => {}} onPick={() => {}} onTogglePin={() => {}} onArchive={() => {}} onAnalytics={() => {}} onSkills={() => {}} onMcp={() => {}} onMetaPrompts={() => {}} metaPromptsActive />)
    expect(html.indexOf('title="MCP"')).toBeLessThan(html.indexOf('Meta Prompts'))
    expect(html).toContain('aria-current="page"')
    expect(html).not.toContain('收藏')
  })
})
