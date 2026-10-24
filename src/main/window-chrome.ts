export type WindowChromeTheme = 'dark' | 'light'

export function windowBackgroundColor(theme: WindowChromeTheme, rendererReady = false, platform: NodeJS.Platform = process.platform): string {
  // Keep the launch frame opaque; only a ready macOS renderer exposes native material.
  if (platform === 'darwin' && rendererReady) return '#00000000'
  return theme === 'light' ? '#f3f5f7' : '#07090d'
}

export function windowTitleBarOptions(platform: NodeJS.Platform = process.platform): {
  titleBarStyle?: 'hiddenInset'
  trafficLightPosition?: { x: number; y: number }
  vibrancy?: 'sidebar'
  visualEffectState?: 'followWindow'
} {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow'
  }
}
