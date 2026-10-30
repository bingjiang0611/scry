import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { isAgentPermissionMode, type AgentPermissionMode } from '../../shared/runtime'
import type { ProviderId } from '../../shared/provider'
import type { ProviderRegistry } from '../providers/registry'
import { createCachedAsyncLoader } from '../provider-detection'
import { DesktopRemoteClient } from '../remote/desktop-client'
import { createProviderDiscovery } from '../remote/provider-discovery'
import type { RemoteHostRuntime } from './remote-host'

export function configuredRemotePermissionMode(): AgentPermissionMode | undefined {
  const raw = process.env.SCRY_REMOTE_PERMISSION_MODE
  return isAgentPermissionMode(raw) ? raw : undefined
}

// Linux 的 safeStorage 在没有可用密钥环时会退回 `basic_text`（用固定明文口令加密），
// isEncryptionAvailable() 仍返回 true。把弱后端当成安全存储会把远程设备凭据
// 写成“看起来已加密”的伪保护，所以在这里 fail closed。
// 纯本地项目不经过这条路径，密钥环不可用不应阻断它。
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

export function createRemoteConnections({
  providerRegistry, listPiProfiles, resolvePiProfile, resolveRemoteProjectDirectory,
  withProviderOperation, remoteProjectRoots, hasRemoteHost
}: {
  providerRegistry: ProviderRegistry
  listPiProfiles: Parameters<typeof createProviderDiscovery>[0]['profiles']
  resolvePiProfile: Parameters<typeof createProviderDiscovery>[0]['resolveProfile']
  resolveRemoteProjectDirectory: Parameters<typeof createProviderDiscovery>[0]['authorizeWorkspace']
  withProviderOperation: RemoteHostRuntime['withProviderOperation']
  remoteProjectRoots: () => string[]
  hasRemoteHost: () => boolean
}) {
  let desktopRemoteClient: DesktopRemoteClient | null = null
  function requireDesktopSecureStorage(): typeof safeStorage {
    const unsafe = unsafeCredentialStorageReason({
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      // 只在 Linux 上查询后端名称；其他平台没有这个概念。
      storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
    })
    if (unsafe) throw new Error(unsafe)
    return safeStorage
  }
  function requireDesktopRemoteClient(): DesktopRemoteClient {
    // An empty saved-host list must not initialize/unlock Keychain during startup.
    // Existing credentials and every persisted write still require secure storage.
    desktopRemoteClient ??= new DesktopRemoteClient({
      directory: join(app.getPath('userData'), 'desktop-connections'),
      encrypt: (value) => requireDesktopSecureStorage().encryptString(value),
      decrypt: (value) => requireDesktopSecureStorage().decryptString(value)
    })
    return desktopRemoteClient
  }

  const remoteProviderDiscovery = createProviderDiscovery({
    descriptors: () => providerRegistry.describe(),
    profiles: listPiProfiles,
    resolveProfile: resolvePiProfile,
    authorizeWorkspace: resolveRemoteProjectDirectory,
    controls: (context) => withProviderOperation(context.providerId, () => providerRegistry.runControls(context), context.agentProfileId),
    defaultWorkspace: () => remoteProjectRoots()[0],
    permissionOverride: configuredRemotePermissionMode,
    supportsForkSession: (providerId) => providerRegistry.get(providerId).forkSession !== undefined,
    onError: (error) => console.warn('[scry] remote Provider discovery failed:', error)
  })

  // Timed refresh only observes descriptors/profile labels. Runtime initialization is
  // owned by a selected context (or an explicit legacy full-snapshot request).
  const remoteProviderSnapshotRefresh = createCachedAsyncLoader(() => remoteProviderDiscovery.refreshMetadata(), { ttlMs: 60_000 })
  const refreshRemoteProviderSnapshot = (): Promise<void> => remoteProviderSnapshotRefresh.load()

  function invalidateRemoteProviderMetadata(providerId: ProviderId): void {
    remoteProviderDiscovery.invalidate(providerId)
    refreshInvalidatedRemoteProviderMetadata()
  }

  function refreshInvalidatedRemoteProviderMetadata(): void {
    if (!hasRemoteHost()) return
    remoteProviderSnapshotRefresh.invalidate()
    void refreshRemoteProviderSnapshot()
  }


  return {
    requireDesktopRemoteClient, remoteProviderDiscovery, refreshRemoteProviderSnapshot,
    invalidateRemoteProviderMetadata, refreshInvalidatedRemoteProviderMetadata,
    getDesktopRemoteClient: () => desktopRemoteClient
  }
}
