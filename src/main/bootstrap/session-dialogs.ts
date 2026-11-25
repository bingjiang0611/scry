import { dialog } from 'electron'
import type { BrowserWindow, MessageBoxOptions } from 'electron'

// itself (delete, rename, pin, archive) runs in the daemon without dialogs;
// session-lifecycle-daemon.ts asks here first and reports here after.

export async function showSessionDialog(getWindow: () => BrowserWindow | null, options: MessageBoxOptions): Promise<number> {
  const window = getWindow()
  const answer = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  return answer.response
}

export function confirmWithDialog(getWindow: () => BrowserWindow | null) {
  return async (prompt: { message: string; detail: string; button: string }): Promise<boolean> =>
    await showSessionDialog(getWindow, {
      type: 'warning', buttons: ['取消', prompt.button], defaultId: 0, cancelId: 0, noLink: true,
      message: prompt.message, detail: prompt.detail
    }) === 1
}

export function notifyWithDialog(getWindow: () => BrowserWindow | null) {
  return async (notice: { message: string; detail: string }): Promise<void> => {
    await showSessionDialog(getWindow, { type: 'error', message: notice.message, detail: notice.detail })
  }
}
