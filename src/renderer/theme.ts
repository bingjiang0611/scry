export type AppTheme = 'dark' | 'light'

export const THEME_STORAGE_KEY = 'scry.theme'

type ThemeReader = Pick<Storage, 'getItem'>
type ThemeWriter = Pick<Storage, 'setItem'>

interface ThemeRoot {
  setAttribute: (name: string, value: string) => void
  style: { colorScheme: string }
}

export function normalizeTheme(value: unknown): AppTheme {
  return value === 'light' ? 'light' : 'dark'
}

export function browserThemeStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function readStoredTheme(storage: ThemeReader | undefined): AppTheme {
  try {
    return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY))
  } catch {
    return 'dark'
  }
}

export function persistTheme(theme: AppTheme, storage: ThemeWriter | undefined): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // 主题切换不应因 localStorage 不可用而中断。
  }
}

export function applyTheme(theme: AppTheme, root: ThemeRoot): void {
  root.setAttribute('data-theme', theme)
  root.style.colorScheme = theme
}
