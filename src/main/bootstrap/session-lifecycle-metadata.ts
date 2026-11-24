import type { AppSessionRef, createAppSessionStore } from '../app-store'
import type { ConversationStore } from '../conversation-store'
import { isSessionProviderId } from '../app-store'
import { archiveSessionAndStop } from '../session-archive'

/**
 * D4: rename, pin and archive change the catalog file. The authority records the same change as
 * an event, so the projection and every device see it, and the event names the caller. The
 * recording happens after the file write reported a change: the user's change already applied,
 * so a store that cannot write is reported rather than failing the call.
 */
export type SessionMetadataChange =
  | { kind: 'rename'; title: string }
  | { kind: 'pin'; pinned: boolean }
  | { kind: 'archive'; archived: boolean }

export interface SessionMetadataDeps {
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  conversationStore: () => ConversationStore
  getStartupManagedRecovery: () => Promise<void>
  providerSessionKey: (providerId: import('../../shared/provider').ProviderId, cwd: string, externalSessionId: string, agentProfileId?: string) => string
  adoptingSessionKeys: ReadonlySet<string>
  getRuns: () => { activeStates: () => Parameters<typeof archiveSessionAndStop>[2] }
  requestRunStop: Parameters<typeof archiveSessionAndStop>[3]
  dockBadge: { remove: (key: string) => void }
  recordSessionMetadata?: (input: {
    externalSessionId: string
    providerId: string
    agentProfileId?: string | undefined
    cwd: string
    change: SessionMetadataChange
    actor: string
  }) => unknown
}

export function sessionRefFromRequest(p: unknown): AppSessionRef | null {
  if (!p || typeof p !== 'object') return null
  const request = p as Partial<AppSessionRef>
  if (typeof request.externalSessionId !== 'string' || !request.externalSessionId) return null
  if (!isSessionProviderId(request.providerId)) return null
  if (request.agentProfileId != null && typeof request.agentProfileId !== 'string') return null
  return {
    providerId: request.providerId,
    agentProfileId: request.agentProfileId,
    cwd: typeof request.cwd === 'string' ? request.cwd : '',
    externalSessionId: request.externalSessionId
  }
}

export function createSessionMetadataOps(deps: SessionMetadataDeps) {
  async function changeLegacySessionMetadata(
    ref: AppSessionRef,
    change: () => boolean,
    meta?: { change: SessionMetadataChange; actor: string }
  ): Promise<boolean> {
    if (ref.providerId === 'legacy_unknown') return change()
    await deps.getStartupManagedRecovery()
    await deps.conversationStore().assertLegacyWriteAllowed({
      ...ref, providerId: ref.providerId, nativeSessionId: ref.externalSessionId
    })
    if (deps.adoptingSessionKeys.has(
      deps.providerSessionKey(ref.providerId, ref.cwd, ref.externalSessionId, ref.agentProfileId)
    )) {
      throw new Error('会话已归属统一对话或正在迁移，请从统一对话管理')
    }
    // Do not queue ordinary legacy archiving behind start preparation: it must
    // retain the existing persist-first fence and stop its registered owner.
    const changed = await change()
    if (changed && meta) {
      deps.recordSessionMetadata?.({
        externalSessionId: ref.externalSessionId,
        providerId: ref.providerId,
        agentProfileId: ref.agentProfileId,
        cwd: ref.cwd,
        change: meta.change,
        actor: meta.actor
      })
    }
    return changed
  }

  // 名称、置顶与存档只改 catalog，不动 Provider transcript 或 turn/usage/trace 数据。
  const renameSession = (p: unknown, title: unknown): Promise<boolean> | boolean => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof (p as AppSessionRef).cwd !== 'string') throw new Error('无效的会话重命名请求')
    return changeLegacySessionMetadata(ref, () => deps.appSessionStore().rename(ref, title),
      typeof title === 'string' ? { change: { kind: 'rename', title }, actor: 'system' } : undefined)
  }

  const setSessionPinned = (p: unknown, pinned: unknown): Promise<boolean> | boolean => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof pinned !== 'boolean') throw new Error('无效的置顶请求')
    return changeLegacySessionMetadata(ref, () => deps.appSessionStore().setPinned(ref, pinned),
      typeof pinned === 'boolean' ? { change: { kind: 'pin', pinned }, actor: 'system' } : undefined)
  }

  const setSessionArchived = (p: unknown, archived: unknown): Promise<boolean> | boolean => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof archived !== 'boolean') throw new Error('无效的存档请求')
    return changeLegacySessionMetadata(ref, () => archived
      ? archiveSessionAndStop(deps.appSessionStore(), ref, deps.getRuns().activeStates(), deps.requestRunStop,
        (key: string) => deps.dockBadge.remove(key))
      : deps.appSessionStore().setArchived(ref, false),
      typeof archived === 'boolean' ? { change: { kind: 'archive', archived }, actor: 'system' } : undefined)
  }

  return { changeLegacySessionMetadata, renameSession, setSessionPinned, setSessionArchived }
}
