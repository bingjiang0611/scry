import { describe, expect, it } from 'vitest'
import { detectRendererPlatform, shortcutModifierLabel } from './platform'

describe('renderer 平台标记', () => {
  it('只在 Electron 里区分桌面平台', () => {
    expect(detectRendererPlatform('MacIntel', 'Mozilla/5.0 Electron/42.0.0')).toBe('macos')
    expect(detectRendererPlatform('Linux x86_64', 'Mozilla/5.0 Electron/42.0.0')).toBe('linux')
    expect(detectRendererPlatform('Win32', 'Mozilla/5.0 Electron/42.0.0')).toBe('other')
  })

  it('浏览器环境不会把自己标成桌面平台', () => {
    expect(detectRendererPlatform('MacIntel', 'Mozilla/5.0 Safari/605.1.15')).toBe('other')
    expect(detectRendererPlatform('Linux x86_64', 'Mozilla/5.0 Chrome/140')).toBe('other')
  })

  it('快捷键提示跟随平台，但在没有平台信息时不冒充 macOS', () => {
    expect(shortcutModifierLabel('macos')).toBe('⌘')
    expect(shortcutModifierLabel('linux')).toBe('Ctrl+')
    expect(shortcutModifierLabel(detectRendererPlatform('', ''))).toBe('Ctrl+')
  })
})
