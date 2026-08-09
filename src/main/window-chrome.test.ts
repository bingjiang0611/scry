import { describe, expect, it } from 'vitest'
import { windowBackgroundColor, windowTitleBarOptions } from './window-chrome'

describe('window chrome', () => {
  it('uses the integrated inset titlebar only on macOS', () => {
    expect(windowTitleBarOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 }
    })
    expect(windowTitleBarOptions('linux')).toEqual({})
    expect(windowTitleBarOptions('win32')).toEqual({})
  })

  it('keeps the native window background aligned with the renderer canvas', () => {
    expect(windowBackgroundColor('dark')).toBe('#07090d')
    expect(windowBackgroundColor('light')).toBe('#f3f5f7')
  })
})
