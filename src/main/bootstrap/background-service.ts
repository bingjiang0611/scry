import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BackgroundServiceActionResult,
  BackgroundServiceConnection,
  BackgroundServiceRuntimeNotice
} from '../../shared/background-service'
import { daemonClientPaths } from '../daemon-client'
import { requestLocalEnrollment } from '../../daemon/local-enrollment-request'
import {
  computeEffectiveRemoteConfig,
  createLoginStartManager,
  diffRemoteConfigs,
  type LoginStartManager
} from '../../daemon/login-start'
import { callDaemonChannel, installDaemonChannelGuard } from '../daemon-channel-gate'
import { prepareBackgroundServiceStop, stopBackgroundService, type BackgroundServiceStopDeps } from '../background-service-stop'
import { connectionFromMode, parseSelfReport, readBackgroundServiceStatus } from '../background-service-status'
import {
  quitWithBackgroundService,
  reconnectBackgroundService,
  restartBackgroundService,
  setBackgroundServiceLoginStart,
  setHostCliApproval,
  type BackgroundServiceActionDeps
} from '../background-service-actions'
import {
  CONFIRM_BUTTON,
  confirmHostCliApprovalPrompt,
  confirmLoginStartPrompt,
  confirmPrompt,
  leftoverNotice,
  reasonMessage,
  type BackgroundServicePrompt
} from '../background-service-copy'
import { isHostCliExperimentalEnabled } from '../../shared/experimental-host-cli'
import { createVersionMismatchPrompt } from '../background-service-mismatch-prompt'
import type { LazyDaemonRunSurface } from './daemon-run-lazy'

// Electron edge of the «后台服务» settings section (B4-S S0-1, P5-2). The decisions live
// in background-service-{status,stop,actions}.ts and daemon/login-start; this file only
// supplies the paths, the daemon client surface, the native dialogs and app.quit.
// Every action channel takes zero arguments except setLoginStart, which accepts exactly
// one boolean; every confirmation is main's own dialog.

type TrustedRegistrar = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void

const DISABLED: BackgroundServiceConnection = { state: 'unavailable', reason: 'daemon_mode_disabled' }

function refuseArguments(args: readonly unknown[]): void {
  if (args.length > 0) throw new Error('invalid_request')
}

function requireBooleanArgument(args: readonly unknown[]): boolean {
  if (args.length !== 1 || typeof args[0] !== 'boolean') throw new Error('invalid_request')
  return args[0]
}

export function createAppLoginStartManager(options: {
  daemonMode: boolean
  env?: NodeJS.ProcessEnv
}): LoginStartManager {
  const userDataDir = app.getPath('userData')
  const appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : process.cwd()
  const resourcesPath = process.resourcesPath ?? process.cwd()
  return createLoginStartManager({
    daemonMode: options.daemonMode,
    target: {
      executable: process.execPath,
      appPath,
      resourcesPath,
      userDataDir,
      isPackaged: Boolean(app.isPackaged)
    },
    ...(options.env ? { env: options.env } : {}),
    log: (line) => console.info(`[background-service] ${line}`)
  })
}

export function createDaemonLoginStartBridge(daemonMode: boolean) {
  let fallback: BackgroundServiceRuntimeNotice['serviceLaunchFallback']
  let listener: ((next: BackgroundServiceRuntimeNotice['serviceLaunchFallback']) => void) | undefined
  const loginStart = daemonMode ? createAppLoginStartManager({ daemonMode: true }) : undefined
  return {
    daemonModeOptions: loginStart ? {
      loginStart,
      onServiceLaunchFallback: (next: BackgroundServiceRuntimeNotice['serviceLaunchFallback']) => {
        fallback = next
        listener?.(next)
      }
    } : {},
    handlerOptions: {
      ...(loginStart ? { loginStart } : {}),
      serviceLaunchFallback: () => fallback,
      onServiceLaunchFallback: (cb: (next: BackgroundServiceRuntimeNotice['serviceLaunchFallback']) => void) => { listener = cb }
    }
  }
}

export function registerBackgroundServiceHandlers(input: {
  handleTrusted: TrustedRegistrar
  /** The App's daemon client; absent with the switch off. */
  daemon: LazyDaemonRunSurface | undefined
  getWindow: () => BrowserWindow | null
  /** Shared login-start manager (also used by appDaemonModeDeps for service launch). */
  loginStart?: LoginStartManager
  /** Reads the latest service-launch fallback warning, if any. */
  serviceLaunchFallback?: () => BackgroundServiceRuntimeNotice['serviceLaunchFallback']
  /** Subscribes to service-launch fallback changes so the run path gets notified immediately. */
  onServiceLaunchFallback?: (listener: (fallback: BackgroundServiceRuntimeNotice['serviceLaunchFallback']) => void) => void
  env?: NodeJS.ProcessEnv
}): void {
  const { daemon } = input
  const env = input.env ?? process.env
  const userDataDir = app.getPath('userData')
  const appVersion = app.getVersion()
  const isPackaged = Boolean(app.isPackaged)
  const stopDeps: BackgroundServiceStopDeps = { paths: { stateDirectory: join(userDataDir, 'daemon'), userDataDir } }
  const loginStart = input.loginStart ?? createAppLoginStartManager({ daemonMode: daemon !== undefined, env })

  let latestConfigMismatch: BackgroundServiceRuntimeNotice['remoteConfigMismatch']
  let latestFallback: BackgroundServiceRuntimeNotice['serviceLaunchFallback'] = input.serviceLaunchFallback?.()

  const buildRuntimeNotice = (): BackgroundServiceRuntimeNotice | null => {
    const fallback = input.serviceLaunchFallback ? input.serviceLaunchFallback() : latestFallback
    if (!fallback && !latestConfigMismatch) return null
    return {
      ...(fallback ? { serviceLaunchFallback: fallback } : {}),
      ...(latestConfigMismatch ? { remoteConfigMismatch: latestConfigMismatch } : {})
    }
  }

  const pushRuntimeNotice = (): void => {
    const win = input.getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents?.send?.('remote:backgroundService:notice', buildRuntimeNotice())
  }

  input.onServiceLaunchFallback?.((fallback) => {
    latestFallback = fallback
    pushRuntimeNotice()
  })

  const connection = async (): Promise<BackgroundServiceConnection> =>
    daemon ? connectionFromMode(await daemon.ready(), appVersion) : DISABLED
  // The daemon's own report, asked without the channel's guard (which is this status).
  const selfReport = (): Promise<unknown> => callDaemonChannel('remote:backgroundService:status', [])
  const expectedRemoteConfig = () => computeEffectiveRemoteConfig(env, isPackaged)
  const hostCliExperimental = isHostCliExperimentalEnabled(env)
  const hostCliPath = isPackaged && process.resourcesPath ? join(process.resourcesPath, 'bin', 'scry-host') : undefined
  const status = () => readBackgroundServiceStatus({
    daemonMode: daemon !== undefined,
    userDataDir,
    connection,
    selfReport,
    lockHolder: async () => {
      const prepared = await prepareBackgroundServiceStop(stopDeps)
      return prepared.status === 'running' ? { pid: prepared.holder.pid } : undefined
    },
    loginStart: () => loginStart.status(),
    expectedRemoteConfig,
    serviceLaunchFallback: () => input.serviceLaunchFallback ? input.serviceLaunchFallback() : latestFallback,
    hostCliExperimental,
    ...(hostCliPath ? { hostCliPath } : {})
  })
  const show = async (prompt: BackgroundServicePrompt): Promise<number> => {
    const win = input.getWindow()
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, prompt) : await dialog.showMessageBox(prompt)
    return response
  }
  const actionDeps: BackgroundServiceActionDeps = {
    daemonMode: daemon !== undefined,
    connection,
    activeRuns: async () => {
      if ((await connection()).state !== 'ready') return undefined
      return parseSelfReport(await selfReport())?.activeRuns
    },
    prepareStop: () => prepareBackgroundServiceStop(stopDeps),
    stop: (holder) => stopBackgroundService(holder, stopDeps),
    confirm: async (action, runs) => await show(confirmPrompt(action, runs)) === CONFIRM_BUTTON,
    holdLaunches: () => daemon?.holdLaunches() ?? (() => undefined),
    reconnect: async () => daemon ? connectionFromMode(await daemon.restart(), appVersion) : DISABLED,
    // The credential the daemon refused; its 0600 file is the App's own (daemon-client.ts).
    discardLocalCredential: () => rm(daemonClientPaths(stopDeps.paths.stateDirectory, userDataDir).statePath, { force: true }),
    requestLocalEnrollment: () => requestLocalEnrollment(stopDeps.paths.stateDirectory),
    hasLocalCredential: () => access(daemonClientPaths(stopDeps.paths.stateDirectory, userDataDir).statePath).then(() => true, () => false),
    reportLeftovers: async (leftovers) => { await show(leftoverNotice(leftovers)) },
    // After the IPC reply is sent; before-quit runs the usual bounded cleanup.
    quitApp: () => { setImmediate(() => app.quit()) }
  }

  // One action at a time: a second click while a stop or login-start change is in flight is refused by name.
  let busy = false
  const exclusive = (run: () => Promise<BackgroundServiceActionResult>) => async (): Promise<BackgroundServiceActionResult> => {
    if (busy) return { status: 'failed', reason: 'action_in_progress', message: reasonMessage('action_in_progress') }
    busy = true
    try { return await run() } finally { busy = false }
  }
  const register = (channel: string, run: () => Promise<unknown>): void => {
    input.handleTrusted(channel, async (_event, ...args: unknown[]) => {
      refuseArguments(args)
      return await run()
    })
  }
  const restart = exclusive(() => restartBackgroundService(actionDeps))
  const restartIdle = exclusive(() => restartBackgroundService({ ...actionDeps, activeRuns: async () => 0 }))
  const setLoginStart = (enabled: boolean) => exclusive(() => setBackgroundServiceLoginStart(enabled, {
    daemonMode: daemon !== undefined,
    precheckEnable: () => loginStart.precheckEnable(),
    confirmEnable: async (policyEnvKeys) => await show(confirmLoginStartPrompt(policyEnvKeys)) === CONFIRM_BUTTON,
    isDaemonRunning: async () => (await prepareBackgroundServiceStop(stopDeps)).status === 'running',
    enable: (options) => loginStart.enable(options),
    disable: (options) => loginStart.disable(options)
  }))()

  const setCliApproval = (enabled: boolean) => exclusive(() => setHostCliApproval(enabled, {
    experimentalEnabled: hostCliExperimental,
    daemonMode: daemon !== undefined,
    connection,
    confirmEnable: async () => await show(confirmHostCliApprovalPrompt()) === CONFIRM_BUTTON,
    apply: async (value) => { await callDaemonChannel('remote:hostAdmin:setCliApproval', [value]) }
  }))()

  register('remote:backgroundService:status', status)
  register('remote:backgroundService:runtimeNotice', async () => buildRuntimeNotice())
  register('remote:backgroundService:restart', restart)
  register('remote:backgroundService:quit', exclusive(() => quitWithBackgroundService(actionDeps)))
  register('remote:backgroundService:reconnect', exclusive(() => reconnectBackgroundService(actionDeps)))
  input.handleTrusted('remote:backgroundService:setLoginStart', async (_event, ...args: unknown[]) => {
    const enabled = requireBooleanArgument(args)
    return await setLoginStart(enabled)
  })
  input.handleTrusted('remote:hostAdmin:setCliApproval', async (_event, ...args: unknown[]) => {
    const enabled = requireBooleanArgument(args)
    return await setCliApproval(enabled)
  })

  // Switch on: the gate routes the status channel to the daemon; the App's part comes
  // first and answers it, asking the daemon itself only while connected.
  if (daemon) {
    // Reconcile moved-App service file once explicitly (status() stays read-only).
    loginStart.reconcileMovedApp()
    installDaemonChannelGuard('remote:backgroundService:status', async (args) => {
      refuseArguments(args)
      return { result: await status() }
    })
    installDaemonChannelGuard('remote:hostAdmin:setCliApproval', async (args) => {
      const enabled = requireBooleanArgument(args)
      return { result: await setCliApproval(enabled) }
    })
    // The one startup prompt for a daemon of another version (approved 2026-11-12): told
    // by the lazy surface when it connects on its own, so no probe is added and nothing
    // waits on the answer. 重启后台服务 is the restart channel's own action.
    const promptMismatch = createVersionMismatchPrompt({
      daemonMode: true,
      autoRestartIdle: !isPackaged,
      ask: show,
      restart,
      restartIdle,
      reportFailure: async (prompt) => { await show(prompt) },
      actionInProgress: () => busy
    })
    daemon.onOutcome((result) => {
      void promptMismatch(
        connectionFromMode(result, appVersion),
        result.runningActiveRuns !== undefined ? { activeRuns: result.runningActiveRuns } : undefined
      ).catch((error: unknown) => {
        console.warn('[background-service] version mismatch prompt failed', error)
      })
      if (result.status === 'ready') {
        void selfReport().then((raw) => {
          const report = parseSelfReport(raw)
          if (report?.launchedBy === 'service' && report.remoteConfig) {
            const expected = expectedRemoteConfig()
            const diffs = diffRemoteConfigs(expected, report.remoteConfig)
            latestConfigMismatch = diffs.length > 0 ? { diffs, expected, actual: report.remoteConfig } : undefined
          } else {
            latestConfigMismatch = undefined
          }
          pushRuntimeNotice()
        }, () => undefined)
      }
    })
  }
}
