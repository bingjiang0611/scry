import { app, BrowserWindow, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { showHostAdminSystemNotification } from './host-admin-notifications'
import { daemonLaunchTarget, spawnDaemonSupervisor } from './daemon-launch'
import { unsafeCredentialStorageReason } from './remote-connections'
import { readDaemonLaunchFailure } from '../daemon-launch-failure'
import { createServiceLaunchController, type ServiceLaunchController } from '../background-service-launch'
import type { LoginStartManager } from '../../daemon/login-start'
import { scryBuildId } from '../../shared/build-identity'
import type { DaemonRunModeDeps } from './daemon-run-mode'

/**
 * The App's own wiring for daemon mode: the same credential rule paired devices use,
 * a log file the daemon owns, and the supervisor launched through the packaged or
 * development entry. Kept here so the main entry only decides whether to use it.
 */
export function appDaemonModeDeps(input: {
  send: (channel: string, payload: unknown) => void
  currentCwd: () => string | undefined
  dockBadge?: DaemonRunModeDeps['dockBadge']
  isWindowFocused?: () => boolean
  rendererCanReceive?: () => boolean
  runTraces?: DaemonRunModeDeps['runTraces']
  desktopRemoteClient?: DaemonRunModeDeps['desktopRemoteClient']
  env?: NodeJS.ProcessEnv
  /** Shared login-start manager so App launches via launchd/systemd when installed (P5 §2.4). */
  loginStart?: LoginStartManager
  /** Called whenever a service-manager launch falls back to direct supervisor spawn. */
  onServiceLaunchFallback?: (fallback: ReturnType<ServiceLaunchController['latestFallback']>) => void
  getWindow?: () => BrowserWindow | null
}): DaemonRunModeDeps {
  const userDataDir = app.getPath('userData')
  const daemonStateDirectory = join(userDataDir, 'daemon')
  const appVersion = app.getVersion()
  const appBuild = scryBuildId()
  const appPath = app.getAppPath()
  const isPackaged = app.isPackaged
  let launchedAt = Number.POSITIVE_INFINITY
  const spawnDirect = () => {
    launchedAt = Date.now()
    const started = spawnDaemonSupervisor({
      target: daemonLaunchTarget({ isPackaged, appPath, execPath: process.execPath }),
      stateDirectory: daemonStateDirectory,
      userDataDir,
      appPath,
      resourcesPath: process.resourcesPath,
      appVersion,
      isPackaged,
      ...(input.env ? { env: input.env } : {})
    })
    return started.status === 'started' ? { status: 'started' as const } : { status: 'failed' as const, reason: started.reason ?? 'daemon_spawn_failed' }
  }
  const serviceLaunch = input.loginStart
    ? createServiceLaunchController({
      canLaunchViaService: () => input.loginStart!.canLaunchViaService(),
      startViaService: () => input.loginStart!.startViaService(),
      spawnDirect,
      ...(input.onServiceLaunchFallback ? { onFallbackChange: input.onServiceLaunchFallback } : {})
    })
    : undefined
  return {
    userDataDir,
    daemonStateDirectory,
    appVersion,
    appDataDir: app.getPath('appData'),
    appName: app.getName(),
    ...(input.env ? { env: input.env } : {}),
    ...(appBuild === undefined ? {} : { appBuild }),
    credentialCipher: () => {
      // Acceptance only. A dev Electron cannot answer the macOS "Safe Storage" Keychain
      // prompt, and isEncryptionAvailable() blocks on it, so an isolated test instance
      // would hang before its window loads. This codec keeps the same 0600 file and the
      // same envelope but stores base64; it needs SCRY_TEST_APP=1 plus an explicit
      // variable, so a normal install never reaches it.
      if (process.env.SCRY_TEST_APP === '1' && process.env.SCRY_DAEMON_CREDENTIAL_PLAINTEXT === '1') {
        return {
          ok: true as const,
          encrypt: (value: string) => Buffer.from(value, 'utf8'),
          decrypt: (value: Buffer) => value.toString('utf8')
        }
      }
      const unsafe = unsafeCredentialStorageReason({
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        storageBackend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined
      })
      if (unsafe) return { ok: false, reason: 'unsafe_credential_storage' }
      return {
        ok: true,
        encrypt: (value: string) => safeStorage.encryptString(value),
        decrypt: (value: Buffer) => safeStorage.decryptString(value)
      }
    },
    send: input.send,
    currentCwd: input.currentCwd,
    ...(input.dockBadge ? { dockBadge: input.dockBadge } : {}),
    ...(input.isWindowFocused ? { isWindowFocused: input.isWindowFocused } : {}),
    ...(input.rendererCanReceive ? { rendererCanReceive: input.rendererCanReceive } : {}),
    ...(input.runTraces ? { runTraces: input.runTraces } : {}),
    ...(input.desktopRemoteClient ? { desktopRemoteClient: input.desktopRemoteClient } : {}),
    shellOps: {
      openPath: async (target) => { const err = await shell.openPath(target); if (err) throw new Error(err) },
      trashItem: (target) => shell.trashItem(target)
    },
    onHostAdmin: (notice) => showHostAdminSystemNotification(notice, {
      getWindow: () => input.getWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null
    }),
    // The pump stops on its own after a failure; without this line the reason would be
    // dropped and the window would just never update.
    onWarn: (message, detail) => {
      console.error(`[scry] ${message}`, detail instanceof Error ? `${detail.name}: ${detail.message}` : detail ?? '')
    },
    launchFailure: () => readDaemonLaunchFailure(daemonStateDirectory, launchedAt),
    launch: async () => {
      launchedAt = Date.now()
      return serviceLaunch ? await serviceLaunch.launch() : spawnDirect()
    },
    ...(serviceLaunch ? {
      launchFallback: async () => {
        launchedAt = Date.now()
        return await serviceLaunch.fallbackAfterTimeout()
      }
    } : {})
  }
}
