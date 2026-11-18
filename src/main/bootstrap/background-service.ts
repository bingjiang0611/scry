import { app, dialog, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackgroundServiceActionResult, BackgroundServiceConnection } from '../../shared/background-service'
import { daemonClientPaths } from '../daemon-client'
import { requestLocalEnrollment } from '../../daemon/local-enrollment-request'
import { callDaemonChannel, installDaemonChannelGuard } from '../daemon-channel-gate'
import { prepareBackgroundServiceStop, stopBackgroundService, type BackgroundServiceStopDeps } from '../background-service-stop'
import { connectionFromMode, parseSelfReport, readBackgroundServiceStatus } from '../background-service-status'
import { quitWithBackgroundService, reconnectBackgroundService, restartBackgroundService, type BackgroundServiceActionDeps } from '../background-service-actions'
import { CONFIRM_BUTTON, confirmPrompt, leftoverNotice, reasonMessage, type BackgroundServicePrompt } from '../background-service-copy'
import { createVersionMismatchPrompt } from '../background-service-mismatch-prompt'
import type { LazyDaemonRunSurface } from './daemon-run-lazy'

// Electron edge of the «后台服务» settings section (B4-S S0-1). The decisions live in
// background-service-{status,stop,actions}.ts; this file only supplies the paths, the
// daemon client surface, the native dialogs and app.quit. None of the four channels takes
// an argument, so a renderer cannot name a pid, a path or an answer to a confirmation:
// every confirmation is main's own dialog.

type TrustedRegistrar = <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void

const DISABLED: BackgroundServiceConnection = { state: 'unavailable', reason: 'daemon_mode_disabled' }

function refuseArguments(args: readonly unknown[]): void {
  if (args.length > 0) throw new Error('invalid_request')
}

export function registerBackgroundServiceHandlers(input: {
  handleTrusted: TrustedRegistrar
  /** The App's daemon client; absent with the switch off. */
  daemon: LazyDaemonRunSurface | undefined
  getWindow: () => BrowserWindow | null
}): void {
  const { daemon } = input
  const userDataDir = app.getPath('userData')
  const appVersion = app.getVersion()
  const stopDeps: BackgroundServiceStopDeps = { paths: { stateDirectory: join(userDataDir, 'daemon'), userDataDir } }

  const connection = async (): Promise<BackgroundServiceConnection> =>
    daemon ? connectionFromMode(await daemon.ready(), appVersion) : DISABLED
  // The daemon's own report, asked without the channel's guard (which is this status).
  const selfReport = (): Promise<unknown> => callDaemonChannel('remote:backgroundService:status', [])
  const status = () => readBackgroundServiceStatus({
    daemonMode: daemon !== undefined,
    userDataDir,
    connection,
    selfReport,
    lockHolder: async () => {
      const prepared = await prepareBackgroundServiceStop(stopDeps)
      return prepared.status === 'running' ? { pid: prepared.holder.pid } : undefined
    }
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

  // One action at a time: a second click while a stop is in flight is refused by name.
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
  register('remote:backgroundService:status', status)
  register('remote:backgroundService:restart', restart)
  register('remote:backgroundService:quit', exclusive(() => quitWithBackgroundService(actionDeps)))
  register('remote:backgroundService:reconnect', exclusive(() => reconnectBackgroundService(actionDeps)))
  // Switch on: the gate routes the status channel to the daemon; the App's part comes
  // first and answers it, asking the daemon itself only while connected.
  if (daemon) {
    installDaemonChannelGuard('remote:backgroundService:status', async (args) => {
      refuseArguments(args)
      return { result: await status() }
    })
    // The one startup prompt for a daemon of another version (approved 2026-11-12): told
    // by the lazy surface when it connects on its own, so no probe is added and nothing
    // waits on the answer. 重启后台服务 is the restart channel's own action.
    const promptMismatch = createVersionMismatchPrompt({
      daemonMode: true,
      ask: show,
      restart,
      reportFailure: async (prompt) => { await show(prompt) },
      actionInProgress: () => busy
    })
    daemon.onOutcome((result) => {
      void promptMismatch(connectionFromMode(result, appVersion)).catch((error: unknown) => {
        console.warn('[background-service] version mismatch prompt failed', error)
      })
    })
  }
}
