import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl } from './renderer-security'
import { PerformanceTrace, performanceRecordingEnabled } from './performance-timing'
import { gateDaemonChannel } from './daemon-channel-gate'

export function assertTrustedIpcEvent(event: IpcMainInvokeEvent, win: BrowserWindow | null, rendererEntryUrl: string): void {
  if (
    !win ||
    win.isDestroyed() ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame ||
    !isTrustedRendererUrl(event.senderFrame.url, rendererEntryUrl)
  ) {
    throw new Error('拒绝来自非可信 renderer 的 IPC 调用')
  }
}

/**
 * The App's registrar: every privileged channel passes here, so this is where a channel
 * the daemon answers is forwarded to it and an unclassified one is refused
 * (daemon-channel-gate.ts); the trust check still runs first on every call.
 */
export function registerTrustedIpcHandler<TArgs extends unknown[], TResult>(
  ipcMain: Pick<IpcMain, 'handle'>,
  channel: string,
  getWindow: () => BrowserWindow | null,
  rendererEntryUrl: string,
  privilegedListener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  registerTrustCheckedListener(ipcMain, channel, getWindow, rendererEntryUrl, gateDaemonChannel(channel, privilegedListener))
}

/**
 * The trust check and timing around one listener, without the daemon gate. The App uses
 * it only through registerTrustedIpcHandler; tests use it to drive a shared handler table
 * (the daemon's implementation of a channel) behind the same trust check.
 */
export function registerTrustCheckedListener<TArgs extends unknown[], TResult>(
  ipcMain: Pick<IpcMain, 'handle'>,
  channel: string,
  getWindow: () => BrowserWindow | null,
  rendererEntryUrl: string,
  listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcEvent(event, getWindow(), rendererEntryUrl)
    // Measure privileged work only after the existing trust gate. Never inspect IPC payloads or
    // results: a resolved handler is not proof that its business operation succeeded or painted.
    if (!performanceRecordingEnabled() || channel === 'app:reportRendererPerformance' || channel === 'app:performanceDiagnosticsEnabled') {
      return listener(event, ...(args as TArgs))
    }
    const trace = new PerformanceTrace(`ipc.${channel}`)
    try {
      const result = listener(event, ...(args as TArgs))
      if (result instanceof Promise) {
        return result.then((value) => {
          trace.finish()
          return value
        }, (error: unknown) => {
          trace.finish(undefined, 'error')
          throw error
        })
      }
      trace.finish()
      return result
    } catch (error) {
      trace.finish(undefined, 'error')
      throw error
    }
  })
}
