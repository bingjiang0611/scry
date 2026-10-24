import { describe, expect, it } from 'vitest'
import { windowBackgroundColor, windowTitleBarOptions } from './window-chrome'

describe('window chrome', () => {
  it('uses the integrated inset titlebar only on macOS', () => {
    expect(windowTitleBarOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow'
    })
    expect(windowTitleBarOptions('linux')).toEqual({})
    expect(windowTitleBarOptions('win32')).toEqual({})
  })

  it('exposes material only after the macOS renderer is ready', () => {
    for (const theme of ['dark', 'light'] as const) {
      expect(windowBackgroundColor(theme, true, 'darwin')).toBe('#00000000')
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        expect(windowBackgroundColor(theme, false, platform)).toBe(theme === 'dark' ? '#07090d' : '#f3f5f7')
        if (platform !== 'darwin') expect(windowBackgroundColor(theme, true, platform)).toBe(windowBackgroundColor(theme, false, platform))
      }
    }
  })

  it('keeps the native window background aligned with the renderer canvas', () => {
    expect(windowBackgroundColor('dark')).toBe('#07090d')
    expect(windowBackgroundColor('light')).toBe('#f3f5f7')
  })
})
