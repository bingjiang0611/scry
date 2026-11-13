import type { DeleteArchivedSessionsResult, DeleteSessionResult } from '../../shared/provider'
import { callDaemonChannel, installDaemonChannelGuard, installDaemonChannelResultHandler } from '../daemon-channel-gate'
import { SESSION_DELETION_PROMPT, archivedDeletionPrompt, untouchedDeletion } from './session-lifecycle'

// Daemon mode: the session lifecycle runs in the daemon, the dialogs stay in this window
// (maintainer decision, B4 D2). The App asks before it sends, and reports what came back
// as main did in process. The daemon deletes nothing the user was not asked about.

export interface SessionLifecycleDialogs {
  confirm(prompt: { message: string; detail: string; button: string }): Promise<boolean>
  notifyFailure(notice: { message: string; detail: string }): Promise<void>
  /** The owned test App deletes a single session without asking, as in process. */
  confirmSingle: boolean
  /** The window's workspace selection (agent:setCwd), kept in main. */
  windowCwd?: () => string | undefined
}

interface ArchivedProject { sessions?: unknown[] }

export function installSessionLifecycleDialogs(dialogs: SessionLifecycleDialogs): () => void {
  const undo = [
    // In process a fork without a cwd uses the window's selection; the daemon has none, so
    // the App names it and the daemon resolves it as a known project (fail closed).
    installDaemonChannelGuard('agent:forkSession', async ([payload, ...rest]) => {
      const cwd = dialogs.windowCwd?.()
      const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined
      if (!request || !cwd || (typeof request.cwd === 'string' && request.cwd.trim())) return { args: [payload, ...rest] }
      return { args: [{ ...request, cwd }, ...rest] }
    }),
    installDaemonChannelGuard('agent:deleteSession', async (args) => {
      if (!dialogs.confirmSingle || await dialogs.confirm(SESSION_DELETION_PROMPT)) return { args }
      const cancelled: DeleteSessionResult = { ok: false, cancelled: true, reason: 'user_cancelled', ...untouchedDeletion() }
      return { result: cancelled }
    }),
    installDaemonChannelResultHandler('agent:deleteSession', async (value) => {
      const result = value as DeleteSessionResult
      if (!result.ok && result.reason === 'partial_failure' && result.failed.length > 0) {
        await dialogs.notifyFailure({
          message: '会话未完整删除，catalog 已保留供重试',
          detail: result.failed.map((failure) => `${failure.store}: ${failure.error}`).join('\n')
        })
      }
      return result
    }),
    // The count asked about travels with the call: if the archived set changed after the
    // answer, the daemon deletes nothing (catalog_changed) instead of unseen sessions.
    installDaemonChannelGuard('agent:deleteArchivedSessions', async () => {
      const projects = await callDaemonChannel('agent:listArchivedSessions', []) as ArchivedProject[]
      const count = projects.reduce((total, project) => total + (project.sessions?.length ?? 0), 0)
      if (count > 0 && !await dialogs.confirm(archivedDeletionPrompt(count))) {
        const cancelled: DeleteArchivedSessionsResult = { ok: false, cancelled: true, reason: 'user_cancelled', deleted: 0, failures: [] }
        return { result: cancelled }
      }
      return { args: [count] }
    }),
    installDaemonChannelResultHandler('agent:deleteArchivedSessions', async (value) => {
      const result = value as DeleteArchivedSessionsResult
      if (result.reason === 'catalog_changed') {
        await dialogs.notifyFailure({ message: '已存档会话在确认后有变化，没有删除任何会话', detail: '请重新打开已存档会话再试一次。' })
      } else if (result.failures.length > 0) {
        await dialogs.notifyFailure({
          message: `${result.failures.length} 个已存档会话未删除，catalog 已保留供重试`,
          detail: result.failures.map((failure) => `${failure.preview || '(无预览)'}: ${failure.reason}`).join('\n')
        })
      }
      return result
    })
  ]
  return () => { for (const step of undo) step() }
}
