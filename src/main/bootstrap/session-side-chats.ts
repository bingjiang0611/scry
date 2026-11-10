import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { DeleteSessionResult, ProviderId } from '../../shared/provider'
import type { createAppSessionStore } from '../app-store'
import type { NativeSideChatScope, SideChatCascade } from './conversation-delete'

type Failure = DeleteSessionResult['failed'][number]
const failureOf = (error: unknown): Failure[] => [{ store: 'side chats', error: error instanceof Error ? error.message : String(error) }]

/**
 * Side chats of a Provider session that is being deleted.
 *
 * A side chat lives only in its source's right panel, so a session that is deleted takes
 * them along instead of leaving records nobody can reach. They are counted before the user
 * is asked and deleted before the session itself: if one cannot be deleted, the session
 * keeps its catalog row as the retry handle and nothing is left half deleted around it.
 */
export function createSessionSideChats({ appSessionStore, sideChatCascade, getWindow }: {
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  sideChatCascade: SideChatCascade
  getWindow: () => BrowserWindow | null
}) {
  /** Read-only. Throws when a side chat is running or unresolved and so cannot be deleted. */
  async function plan(target: { providerId: ProviderId; agentProfileId?: string; cwd: string; externalSessionId: string }):
  Promise<{ scope: NativeSideChatScope; count: number }> {
    // A side chat may name either alias of the session it was created from.
    const row = appSessionStore().load().find(session => session.providerId === target.providerId &&
      session.agentProfileId === target.agentProfileId && session.cwd === target.cwd &&
      (session.sessionId === target.externalSessionId || session.externalSessionId === target.externalSessionId))
    const scope: NativeSideChatScope = { providerId: target.providerId, agentProfileId: target.agentProfileId, cwd: target.cwd,
      nativeSessionIds: [target.externalSessionId, row?.sessionId, row?.externalSessionId].filter((id): id is string => Boolean(id)) }
    return { scope, count: await sideChatCascade.count(scope) }
  }
  /** Deletes them and answers what could not be deleted; empty means none is left. */
  async function remove(scope: NativeSideChatScope): Promise<Failure[]> {
    try {
      return (await sideChatCascade.run(scope)).failed
    } catch (error) { return failureOf(error) }
  }
  /** The session was not deleted because of its side chats; say why instead of failing silently. */
  async function kept(failed: Failure[], notify: boolean, base: Pick<DeleteSessionResult, 'deleted' | 'retained'>): Promise<DeleteSessionResult> {
    if (notify) {
      const options = { type: 'error' as const, message: '会话未删除：它的侧边会话还不能删除',
        detail: failed.map(failure => `${failure.store}: ${failure.error}`).join('\n') }
      const window = getWindow()
      if (window && !window.isDestroyed()) await dialog.showMessageBox(window, options)
      else await dialog.showMessageBox(options)
    }
    return { ok: false, reason: 'partial_failure', ...base, failed }
  }
  return { plan, remove, kept, failureOf }
}
