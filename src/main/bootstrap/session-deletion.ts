import { dialog } from 'electron'
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { createSessionLifecycle, type SessionDeletionRequest, type SessionLifecycleDependencies } from './session-lifecycle'
import { installSessionLifecycleDialogs } from './session-lifecycle-daemon'
import { daemonModeEnabled } from '../daemon-channel-gate'

export type { SessionDeletionRequest } from './session-lifecycle'

// Main's session delete/rename/pin/archive channels: the shared lifecycle with this
// window's dialogs. In daemon mode the gate answers these channels from the daemon,
// which runs the same lifecycle without dialogs (session-lifecycle-daemon.ts asks first).

export interface SessionDeletionDependencies extends Omit<SessionLifecycleDependencies, 'publishDataUpdated' | 'confirm' | 'notifyFailure'> {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getWindow: () => BrowserWindow | null
  rendererCanReceive: () => boolean
  isOwnedTestApp: boolean
}

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

export function registerSessionDeletionHandlers(deps: SessionDeletionDependencies) {
  const { handleTrusted, getWindow, rendererCanReceive, isOwnedTestApp } = deps
  const lifecycle = createSessionLifecycle({
    ...deps,
    publishDataUpdated: (event) => { if (rendererCanReceive()) getWindow()?.webContents.send('agent:dataUpdated', event) },
    confirm: confirmWithDialog(getWindow),
    notifyFailure: notifyWithDialog(getWindow)
  })
  // confirm / notifyFailure: a single deletion asks and reports once each; the archived
  // batch asks and reports once for the whole batch.
  handleTrusted('agent:deleteSession', (_e, p: SessionDeletionRequest) =>
    lifecycle.deleteOneSession(p, { confirm: !isOwnedTestApp, notifyFailure: true }))
  handleTrusted('agent:renameSession', (_e, p: unknown, title: unknown) => lifecycle.renameSession(p, title))
  handleTrusted('agent:setSessionPinned', (_e, p: unknown, pinned: unknown) => lifecycle.setSessionPinned(p, pinned))
  handleTrusted('agent:setSessionArchived', (_e, p: unknown, archived: unknown) => lifecycle.setSessionArchived(p, archived))
  handleTrusted('agent:listArchivedSessions', () => lifecycle.listArchivedSessions())
  handleTrusted('agent:deleteArchivedSessions', () => lifecycle.deleteArchivedSessions())
  // Daemon mode answers these channels from the daemon; the dialogs stay in this window.
  if (daemonModeEnabled()) {
    installSessionLifecycleDialogs({ confirm: confirmWithDialog(getWindow), notifyFailure: notifyWithDialog(getWindow), confirmSingle: !isOwnedTestApp })
  }
  return { deleteOneSession: lifecycle.deleteOneSession, sessionRefFromRequest: lifecycle.sessionRefFromRequest, changeLegacySessionMetadata: lifecycle.changeLegacySessionMetadata }
}
