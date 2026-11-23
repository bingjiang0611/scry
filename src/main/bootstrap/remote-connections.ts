import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { DesktopRemoteClient } from '../remote/desktop-client'
import type { DesktopRemoteUpdate } from '../../shared/desktop-remote'
import type { RemoteAttentionTracker } from '../remote/remote-attention'

// Linux 的 safeStorage 在没有可用密钥环时会退回 `basic_text`（用固定明文口令加密），
// isEncryptionAvailable() 仍返回 true。把弱后端当成安全存储会把远程设备凭据
// 写成“看起来已加密”的伪保护，所以在这里 fail closed。
// daemon 模式下本机 run 也经过这条路径：App 连本机后台服务的 grant 同样存在 safeStorage，
// 所以密钥环不可用时本机 run 一样被拒（B4-S F2）。Linux 上 Hyprland 或未命名桌面会先
// 追加 password-store=gnome-libsecret（linux-password-store.ts），但从不退回明文。
export function unsafeCredentialStorageReason(input: {
  platform?: NodeJS.Platform
  encryptionAvailable: boolean
  storageBackend?: string
}): string | undefined {
  const platform = input.platform ?? process.platform
  if (!input.encryptionAvailable) return '系统安全存储不可用，无法保存远程设备凭据'
  if (platform === 'linux' && input.storageBackend === 'basic_text') {
    return '系统密钥环不可用（Linux 安全存储当前为 basic_text 明文后端），无法安全保存远程设备凭据；请先解锁或配置 GNOME Keyring / libsecret 后重试'
  }
  return undefined
}

/**
 * The App's client to other hosts (desktop remote): the saved hosts are the App's own
 * state, kept in its secure storage. Built on first use so an empty saved-host list never
 * initializes or unlocks the keychain during startup.
 */
export function createRemoteConnections({ remoteAttention, publishSubscription }: {
  remoteAttention: RemoteAttentionTracker
  publishSubscription?: (update: DesktopRemoteUpdate) => void
}) {
  let desktopRemoteClient: DesktopRemoteClient | null = null
  function requireDesktopSecureStorage(): typeof safeStorage {
    const unsafe = unsafeCredentialStorageReason({
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
    })
    if (unsafe) throw new Error(unsafe)
    return safeStorage
  }
  function requireDesktopRemoteClient(): DesktopRemoteClient {
    // Existing credentials and every persisted write still require secure storage.
    desktopRemoteClient ??= new DesktopRemoteClient({
      directory: join(app.getPath('userData'), 'desktop-connections'),
      encrypt: (value) => requireDesktopSecureStorage().encryptString(value),
      decrypt: (value) => requireDesktopSecureStorage().decryptString(value),
      attention: remoteAttention,
      publishSubscription
    })
    return desktopRemoteClient
  }
  return { requireDesktopRemoteClient, getDesktopRemoteClient: () => desktopRemoteClient }
}
