export type WindowChromeTheme = 'dark' | 'light'

export function windowBackgroundColor(theme: WindowChromeTheme): string {
  return theme === 'light' ? '#f3f5f7' : '#07090d'
}

export function windowTitleBarOptions(platform: NodeJS.Platform = process.platform): {
  titleBarStyle?: 'hiddenInset'
  trafficLightPosition?: { x: number; y: number }
} {
  if (platform !== 'darwin') return {}
  return {
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 }
  }
}
