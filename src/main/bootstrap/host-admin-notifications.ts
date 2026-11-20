import { Notification, type BrowserWindow } from 'electron'
import { formatHostAdminNoticeText, type HostAdminNotice } from '../../shared/host-admin'

// Native desktop notification when CLI approval is turned on or `scry-host` approves,
// cancels, revokes, or disables desktop access (P5-host-security §4.3, P5-7).
// Clicking focuses Scry and opens the remote devices view so the user can revoke directly.

const TITLES: Record<HostAdminNotice['kind'], string> = {
  cli_approval_enabled: 'Scry · 已开启命令行批准',
  device_approved_via_cli: 'Scry · 命令行已批准新设备',
  device_revoked_via_cli: 'Scry · 命令行已撤销设备',
  pairing_cancelled_via_cli: 'Scry · 命令行已取消配对',
  desktop_disabled_via_cli: 'Scry · 命令行已关闭桌面访问'
}

export interface HostAdminNotificationDeps {
  getWindow: () => BrowserWindow | null
  NotificationCtor?: typeof Notification
}

export function showHostAdminSystemNotification(
  notice: HostAdminNotice,
  deps: HostAdminNotificationDeps
): void {
  const win = deps.getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents?.send?.('remote:hostAdmin:notice', notice)
  }
  const Ctor = deps.NotificationCtor ?? Notification
  if (!Ctor || typeof Ctor.isSupported !== 'function' || !Ctor.isSupported()) return
  const item = new Ctor({
    title: TITLES[notice.kind],
    body: formatHostAdminNoticeText(notice)
  })
  item.on('click', () => {
    const target = deps.getWindow()
    if (!target || target.isDestroyed()) return
    target.show()
    target.focus()
    target.webContents?.send?.('remote:hostAdmin:openDevices', {
      ...(notice.deviceId ? { deviceId: notice.deviceId } : {})
    })
  })
  item.show()
}
