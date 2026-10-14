import { clipboard, ipcMain, type BrowserWindow } from 'electron'
import { registerTrustedIpcHandler } from '../../src/main/ipc-trust'
import { writeClipboardText } from '../../src/main/clipboard-text'
import { configureRendererPermissions } from '../../src/main/renderer-security'

export function registerMetaPromptsFixtureIpc(win: BrowserWindow, rendererUrl: string): void {
  configureRendererPermissions(win.webContents.session, rendererUrl)
  registerTrustedIpcHandler(ipcMain, 'app:copyText', () => win, rendererUrl, (_event, text: unknown) => writeClipboardText(text, clipboard))
}
