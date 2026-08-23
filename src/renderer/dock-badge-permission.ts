type NotificationPermissionRequester = Pick<typeof Notification, 'permission' | 'requestPermission'>

export async function requestDockBadgePermission(
  notifications: NotificationPermissionRequester | undefined = globalThis.Notification
): Promise<void> {
  if (!notifications || notifications.permission !== 'default') return
  try {
    await notifications.requestPermission()
  } catch {
    // Sending a turn must not depend on the optional macOS badge permission.
  }
}
