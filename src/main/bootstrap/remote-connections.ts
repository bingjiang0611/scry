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
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存远程设备凭据')
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
