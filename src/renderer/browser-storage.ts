// Renderer 持久化统一入口：Local Storage 在收紧的桌面环境里可能直接抛错，
// 读取失败只应让对应偏好退化为进程内记忆，不能让 UI 初始化失败。
export function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}
