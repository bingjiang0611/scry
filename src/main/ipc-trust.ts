import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { isTrustedRendererUrl } from './renderer-security'

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
    return listener(event, ...(args as TArgs))
  })
}
