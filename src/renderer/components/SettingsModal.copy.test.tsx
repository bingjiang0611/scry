import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArchivedChatsPanel, SettingsModal } from './Modals'

describe('Settings copy density', () => {
  it('keeps theme controls without repeating their purpose or persistence', () => {
    const html = renderToStaticMarkup(<SettingsModal theme="dark" onThemeChange={() => {}} onSessionsChanged={() => {}} onNewRemoteSession={() => {}} onClose={() => {}} />)
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('深色')
    expect(html).toContain('浅色')
    expect(html).not.toContain('选择 Scry 的全局界面主题')
    expect(html).not.toContain('低光环境')
    expect(html).not.toContain('明亮环境')
    expect(html).not.toContain('modal-foot')
  })

  it('keeps archive discovery and empty states without storage implementation prose', () => {
    const html = renderToStaticMarkup(<ArchivedChatsPanel projects={[]} onRefresh={async () => {}} onSessionsChanged={() => {}} />)
    expect(html).toContain('class="arch-empty"')
    expect(html).toContain('存档图标')
    expect(html).toContain('搜索已存档会话')
    expect(html).not.toContain('存档后会话从左侧列表移出')
    expect(html).not.toContain('trace 都保留')
  })
})
