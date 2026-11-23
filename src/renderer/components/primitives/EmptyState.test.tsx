import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmptyState, EmptyStateSlot } from './EmptyState'
import { EmptyStateArtwork } from './EmptyStateArtwork'

const retry = { label: '重新读取', intent: 'secondary' as const, icon: 'refresh' as const, onClick: () => {} }

describe('EmptyState', () => {
  it('gives the page one named heading, decorative artwork, and a bounded action group', () => {
    const html = renderToStaticMarkup(<EmptyState size="page" title="没能读取会话" description="草稿会保留"
      picture={<EmptyStateArtwork scene="locked-file" />} actions={[retry, { ...retry, label: '返回' }]} />)
    expect(html).toContain('<h2 class="empty-state-title" dir="auto">没能读取会话</h2>')
    expect(html).toContain('class="empty-state-picture" aria-hidden="true"')
    expect(html).toContain('viewBox="0 0 120 90"')
    expect(html).toContain('草稿会保留')
    expect(html.match(/<button /g)).toHaveLength(2)
    expect(html).not.toContain(' btn primary')
  })

  it.each(['card', 'row', 'menu'] as const)('does not display a description at %s size', (size) => {
    const html = renderToStaticMarkup(<EmptyState size={size} title="没有匹配结果" description="不应显示"
      announcement="polite" picture="search" actions={[retry]} />)
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('不应显示')
    if (size === 'menu') expect(html).not.toContain('<button')
    else expect(html).toContain('btn quiet sm')
    if (size !== 'card') expect(html).not.toContain('empty-state-picture')
  })

  it('keeps a retry focusable during the read and never renders children alongside a cold empty state', () => {
    const empty = <EmptyState size="card" title="读取失败" actions={[{ ...retry, busy: true }]} />
    const html = renderToStaticMarkup(<EmptyStateSlot empty={empty}><p>已读取内容</p></EmptyStateSlot>)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toMatch(/\sdisabled=""/)
    expect(html).not.toContain('已读取内容')
    const ready = renderToStaticMarkup(<EmptyStateSlot empty={null}><p>已读取内容</p></EmptyStateSlot>)
    expect(ready).toContain('已读取内容')
    expect(ready).not.toContain('读取失败')
  })
})
