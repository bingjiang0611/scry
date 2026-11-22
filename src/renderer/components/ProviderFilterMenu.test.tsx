import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderFilterSelect, providerFilterLabel } from './ProviderFilterMenu'

function menu(providers: string[], value = 'all'): string {
  return renderToStaticMarkup(<ProviderFilterSelect providers={providers} value={value} onChange={() => {}} />)
}

describe('归档列表的 Provider 筛选菜单', () => {
  it('Provider 显示名可读，未知来源不冒充成某个 Provider', () => {
    expect(providerFilterLabel('all')).toBe('全部 Provider')
    expect(providerFilterLabel('claude')).toBe('Claude Code')
    expect(providerFilterLabel('opencode')).toBe('OpenCode')
    expect(providerFilterLabel('legacy_unknown')).toBe('Provider 未知')
  })

  it('原生选择框只标记当前筛选值', () => {
    const html = menu(['claude', 'codex', 'legacy_unknown'], 'claude')
    expect(html).toContain('<select')
    expect(html).not.toContain('role="menu"')
    expect(html.match(/<option/g)).toHaveLength(4)
    expect(html.match(/ selected=""/g)).toHaveLength(1)
    expect(html).toContain('value="claude" selected="">Claude Code')
    expect(html).toContain('Provider 未知')
  })

  it('筛选值从目录暂时消失时仍显示该值', () => {
    const html = menu(['claude'], 'codex')
    expect(html).toContain('value="codex" selected="">Codex')
  })

  it('触发器显示当前筛选值', () => {
    expect(menu(['claude'], 'claude')).toContain('>Claude Code<')
    expect(menu(['claude'], 'all')).toContain('>全部 Provider<')
  })
})
