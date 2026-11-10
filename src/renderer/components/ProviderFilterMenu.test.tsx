import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProviderFilterMenu, providerFilterLabel } from './ProviderFilterMenu'

function menu(providers: string[], value = 'all'): string {
  return renderToStaticMarkup(
    <ProviderFilterMenu providers={providers} value={value} onChange={() => {}} open />
  )
}

describe('归档列表的 Provider 筛选菜单', () => {
  it('Provider 显示名可读，未知来源不冒充成某个 Provider', () => {
    expect(providerFilterLabel('all')).toBe('全部 Provider')
    expect(providerFilterLabel('claude')).toBe('Claude Code')
    expect(providerFilterLabel('opencode')).toBe('OpenCode')
    expect(providerFilterLabel('legacy_unknown')).toBe('Provider 未知')
  })

  it('用单选菜单取代原生 select，并保留品牌图标', () => {
    const html = menu(['claude', 'codex', 'legacy_unknown'], 'claude')
    expect(html).not.toContain('<select')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('role="menu"')
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(4)
    expect(html).toContain('data-provider-option="claude"')
    expect(html).toContain('data-provider="claude"')
    expect(html).toContain('data-provider="codex"')
    expect(html).toContain('Provider 未知')
    // 未知来源没有品牌标，不能借用其它 Provider 的图标。
    expect(html).not.toContain('data-provider="legacy_unknown"')
  })

  it('只有当前筛选项带对勾', () => {
    const html = menu(['claude', 'codex'], 'codex')
    const checked = [...html.matchAll(/aria-checked="true"[^>]*data-provider-option="([^"]+)"|data-provider-option="([^"]+)"[^>]*aria-checked="true"/g)]
    expect(checked.map((match) => match[1] ?? match[2])).toEqual(['codex'])
    expect(html).toMatch(/aria-checked="false"[^>]*data-provider-option="claude"|data-provider-option="claude"[^>]*aria-checked="false"/)
  })

  it('触发器显示当前筛选值', () => {
    expect(menu(['claude'], 'claude')).toContain('>Claude Code<')
    expect(menu(['claude'], 'all')).toContain('>全部 Provider<')
  })
})
