import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl } from './renderer-security'
import { PerformanceTrace, performanceRecordingEnabled } from './performance-timing'

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

export function registerTrustedIpcHandler<TArgs extends unknown[], TResult>(
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
