export type RendererPlatform = 'macos' | 'linux' | 'other'

// renderer 只用这个值决定展示（窗口样式、快捷键提示）。
// 权限、路径授权与 trust 判断都在 main 里，不能读这个值。
export function detectRendererPlatform(platform?: string, userAgent?: string): RendererPlatform {
  const navigatorPlatform = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform)
  const navigatorUserAgent = userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)
  if (!navigatorUserAgent.includes('Electron')) return 'other'
  const normalized = navigatorPlatform.toLowerCase()
  if (normalized.startsWith('mac')) return 'macos'
  if (normalized.startsWith('linux')) return 'linux'
  return 'other'
}

// 快捷键提示必须和实际生效的按键一致：处理逻辑同时接受 metaKey 与 ctrlKey，
// 所以 macOS 显示 ⌘，其余平台显示 Ctrl+。
export function shortcutModifierLabel(platform: RendererPlatform): string {
  return platform === 'macos' ? '⌘' : 'Ctrl+'
}
