type NotificationPermissionRequester = Pick<typeof Notification, 'permission' | 'requestPermission'>

export type DockBadgePermissionOutcome = 'skipped' | 'settled' | 'timeout'

// macOS 的通知授权弹窗由系统拥有：它可能长时间不返回，甚至永远不 resolve。
// Dock badge 只是可选观测装饰，任何调用方都不能因为它卡住，所以这里做有界等待。
const DOCK_BADGE_PERMISSION_TIMEOUT_MS = 3_000

export async function requestDockBadgePermission(
  notifications: NotificationPermissionRequester | undefined = globalThis.Notification,
  options: { timeoutMs?: number; delay?: (ms: number) => Promise<void> } = {}
): Promise<DockBadgePermissionOutcome> {
  if (!notifications || notifications.permission !== 'default') return 'skipped'
  const timeoutMs = options.timeoutMs ?? DOCK_BADGE_PERMISSION_TIMEOUT_MS
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => notifications.requestPermission())
        .then((): DockBadgePermissionOutcome => 'settled'),
      delay(timeoutMs).then((): DockBadgePermissionOutcome => 'timeout')
    ])
  } catch {
    // Sending a turn must not depend on the optional macOS badge permission.
    return 'settled'
  }
}
