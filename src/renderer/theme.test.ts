import { describe, expect, it, vi } from 'vitest'
import { applyTheme, normalizeTheme, persistTheme, readStoredTheme, THEME_STORAGE_KEY } from './theme'

describe('renderer 主题偏好', () => {
  it('只接受 light，其余值安全回退到现有深色主题', () => {
    expect(normalizeTheme('light')).toBe('light')
    expect(normalizeTheme('dark')).toBe('dark')
    expect(normalizeTheme('system')).toBe('dark')
    expect(readStoredTheme({ getItem: () => null })).toBe('dark')
    expect(readStoredTheme({ getItem: () => 'light' })).toBe('light')
  })

  it('localStorage 失败时仍能启动和切换主题', () => {
    expect(readStoredTheme({ getItem: () => { throw new Error('denied') } })).toBe('dark')
    expect(() => persistTheme('light', { setItem: () => { throw new Error('quota') } })).not.toThrow()
  })

  it('持久化选择并同步根节点的主题与原生控件配色', () => {
    const setItem = vi.fn()
    persistTheme('light', { setItem })
    expect(setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, 'light')

    const setAttribute = vi.fn()
    const root = { setAttribute, style: { colorScheme: '' } }
    applyTheme('light', root)
    expect(setAttribute).toHaveBeenCalledWith('data-theme', 'light')
    expect(root.style.colorScheme).toBe('light')
  })
})
