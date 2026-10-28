import { isAbsolute } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext, ProviderId } from '../shared/provider'
import type { ActiveRun } from '../shared/trace'
import { SESSION_CATALOG_COPY as copy } from '../shared/constants/session-catalog-copy'
import { isSessionProviderId, type AppSessionRef, type ProjectMeta,
  type createAppSessionStore, type createProjectStore, type createRecentFoldersStore } from './app-store'
import type { ConversationStore } from './conversation-store'
import { archiveSessionAndStop } from './session-archive'

/** Catalog operations only: no native transcript deletion or execution authority.
 * Store accessors and recovery are live dependencies, not startup snapshots.
 * Local IPC and remote management share the same legacy ownership fence. */
export function registerSessionCatalogIpc(deps: {
  handleTrusted: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  projectStore: () => ReturnType<typeof createProjectStore>
  recentStore: () => ReturnType<typeof createRecentFoldersStore>
  listProjectCatalog: () => Promise<ProjectMeta[]>
  showItemInFolder: (cwd: string) => void
  startupManagedRecovery: () => Promise<void>
  conversationStore: () => Pick<ConversationStore, 'assertLegacyWriteAllowed'>
  adoptingSessionKeys: ReadonlySet<string>
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  activeRuns: () => ActiveRun[]
  requestRunStop: (runId: string) => boolean
}) {
  const { handleTrusted, appSessionStore, projectStore, recentStore } = deps
  const projectCwdFromRequest = (value: unknown): string => {
    if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096) throw new Error(copy.invalidDirectory)
    return value
  }
  const sessionRefFromRequest = (p: unknown): AppSessionRef | null => {
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
  const changeLegacySessionMetadata = async (ref: AppSessionRef, change: () => boolean): Promise<boolean> => {
    if (ref.providerId === 'legacy_unknown') return change()
    await deps.startupManagedRecovery()
    await deps.conversationStore().assertLegacyWriteAllowed({ ...ref, providerId: ref.providerId, nativeSessionId: ref.externalSessionId })
    if (deps.adoptingSessionKeys.has(deps.providerSessionKey(ref.providerId, ref.cwd, ref.externalSessionId, ref.agentProfileId))) {
      throw new Error(copy.ownedSession)
    }
    // Persist-first archiving must not queue behind start preparation: its
    // existing catalog fence stops only the exact registered session owner.
    return change()
  }

  handleTrusted('agent:listSessions', (_event, context: ProviderContext) =>
    appSessionStore().listSessions(context.cwd ?? '', context.providerId, context.agentProfileId))
  handleTrusted('agent:listProjects', () => deps.listProjectCatalog())
  handleTrusted('agent:catalogHealth', () => appSessionStore().health())
  handleTrusted('agent:setProjectPinned', (_event, cwd: unknown, pinned: unknown) => {
    if (typeof pinned !== 'boolean') throw new Error(copy.invalidProjectPin)
    return projectStore().setPinned(projectCwdFromRequest(cwd), pinned)
  })
  handleTrusted('agent:renameProject', (_event, cwd: unknown, name: unknown) => {
    const label = typeof name === 'string' ? name.trim() : ''
    if (!label || label.length > 120) throw new Error(copy.invalidProjectName)
    return projectStore().rename(projectCwdFromRequest(cwd), label)
  })
  handleTrusted('agent:removeProject', (_event, cwd: unknown) => {
    const dir = projectCwdFromRequest(cwd)
    projectStore().remove(dir)
    recentStore().remove(dir)
    return true as const
  })
  handleTrusted('agent:revealProject', (_event, cwd: unknown) => {
    deps.showItemInFolder(projectCwdFromRequest(cwd))
    return true as const
  })
  handleTrusted('agent:renameSession', (_event, p: unknown, title: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof (p as AppSessionRef).cwd !== 'string') throw new Error(copy.invalidRename)
    return changeLegacySessionMetadata(ref, () => appSessionStore().rename(ref, title))
  })
  handleTrusted('agent:setSessionPinned', (_event, p: unknown, pinned: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof pinned !== 'boolean') throw new Error(copy.invalidPin)
    return changeLegacySessionMetadata(ref, () => appSessionStore().setPinned(ref, pinned))
  })
  handleTrusted('agent:setSessionArchived', (_event, p: unknown, archived: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof archived !== 'boolean') throw new Error(copy.invalidArchive)
    return changeLegacySessionMetadata(ref, () => archived
      ? archiveSessionAndStop(appSessionStore(), ref, deps.activeRuns(), deps.requestRunStop)
      : appSessionStore().setArchived(ref, false))
  })
  handleTrusted('agent:listArchivedSessions', () => appSessionStore().listArchivedProjects())
  return { sessionRefFromRequest, changeLegacySessionMetadata }
}
