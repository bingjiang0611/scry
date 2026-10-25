import { dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import type { ProviderContext, ProviderId, SessionProviderId, DeleteSessionResult, DeleteArchivedSessionsResult } from '../../shared/provider'
import type { Conversation } from '../../shared/conversation'
import type { ConversationDeletionPreview } from '../../shared/conversation-api'
import type { AppSessionRef, createAppSessionStore } from '../app-store'
import type { ConversationStore } from '../conversation-store'
import type { ContextAdmission } from '../context-admission'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { ActiveRun } from '../../shared/trace'
import { isSessionProviderId } from '../app-store'
import { archiveSessionAndStop } from '../session-archive'
import { deleteTranscriptCopies, traceArchiveRunIds } from '../transcript-archive'
import { resolveSessionRunIds, deleteSessionData, deleteTurnOutboxSessionRows, turnOutboxSessionRunIds } from '../db'
import { usageSessionRunIds, deleteUsageSessionRows } from '../usage-jsonl'
import { attachmentSessionRunIds, deleteRunAttachments } from '../attachment-store'
import { managedSessionRunIds, deleteManagedTurnArtifacts } from '../managed-turn-commit'
import { traceProgressSessionRunIds, deleteTraceTurnProgressArtifacts } from '../trace-turn-progress'
import { deleteOwnedSessionData } from '../session-deletion'

interface DeletionRuns {
  activeStates: () => ActiveRun[]
  unsettledStates: () => ActiveRun[]
}

export interface SessionDeletionDependencies {
  handleTrusted: <TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult) => void
  getRuns: () => DeletionRuns
  appSessionStore: () => ReturnType<typeof createAppSessionStore>
  conversationStore: () => ConversationStore
  contextAdmission: Pick<ContextAdmission, 'run'>
  getStartupManagedRecovery: () => Promise<void>
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  deletingSessions: Set<string>
  sessionDiffBaselines: SessionDiffBaselineRegistry
  sessionBaselineKey: (context: string, sessionId: string) => string
  recordingBlockedSessions: Map<string, string>
  getWindow: () => BrowserWindow | null
  assertLegacyConversationWriteAllowed: (scope: { providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId?: string }, deletion?: { ownerId?: string }) => Promise<void>
  sessionByContext: Map<string, string>
  adoptingSessionKeys: Set<string>
  dockBadge: { remove: (key: string) => void }
  rendererCanReceive: () => boolean
  appUserDataDir: string
  isOwnedTestApp: boolean
  requestRunStop: (runId: string) => boolean
  prepareConversationDeletion: (conversation: Conversation) => Promise<ConversationDeletionPreview>
}

export type SessionDeletionRequest = Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }

export function registerSessionDeletionHandlers(deps: SessionDeletionDependencies) {
  const { handleTrusted, getRuns, appSessionStore, conversationStore, contextAdmission, getStartupManagedRecovery, providerContextKey, providerSessionKey, deletingSessions, sessionDiffBaselines, sessionBaselineKey, recordingBlockedSessions, getWindow, rendererCanReceive, appUserDataDir, isOwnedTestApp, requestRunStop, prepareConversationDeletion, assertLegacyConversationWriteAllowed, sessionByContext, adoptingSessionKeys, dockBadge } = deps

  // 删除一个历史会话。工作区 .scry/ 是独立 canonical evidence，明确保留。
  // confirm / notifyFailure 由调用方决定：单条删除各弹一次系统弹窗，批量删除只在批次首尾各弹一次。
  async function deleteOneSession(
    p: SessionDeletionRequest,
    options: { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[]; authorize?: () => void }
  ): Promise<DeleteSessionResult> {
    const empty = (): Pick<DeleteSessionResult, 'deleted' | 'retained' | 'failed'> => ({
      deleted: [],
      retained: ['workspace .scry/ canonical turn evidence', 'Provider-native session transcript/history'],
      failed: []
    })
    if (!p.externalSessionId || p.providerId === 'legacy_unknown') {
      return { ok: false, reason: 'invalid_request', ...empty() }
    }
    const cwd = p.cwd ?? ''
    const externalSessionId = p.externalSessionId
    const providerId = p.providerId as ProviderId
    const agentProfileId = p.agentProfileId
    const admissionKey = providerContextKey(providerId, cwd, agentProfileId)
    const deletionKey = providerSessionKey(providerId, cwd, externalSessionId, agentProfileId)
    let otherOwnedRunIds = new Set<string>()
    const assertDeletionAllowed = async (): Promise<void> => {
      if (!options.conversationId) return assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, {})
      const owner = await conversationStore().read(options.conversationId)
      if (!owner || owner.cwd !== cwd || owner.deletion?.status !== 'pending') throw new Error('没有已持久化的统一对话删除授权')
      const plan = await prepareConversationDeletion(owner)
      const target = plan.targets.find(target => target.providerId === providerId && target.agentProfileId === agentProfileId && target.externalSessionId === externalSessionId)
      if (!target || target.sharedWith.length) throw new Error('删除目标未归属该操作或仍被其他会话引用')
      otherOwnedRunIds = new Set(plan.targets.filter(other => other !== target).flatMap(other => other.runIds))
      await assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, { ownerId: options.conversationId })
    }
    const hasActiveSession = (): boolean => getRuns().unsettledStates().some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return run.providerId === providerId && (run.cwd ?? '') === cwd &&
        (run.runId === externalSessionId || sessionId === externalSessionId || Boolean(options.runIds?.includes(run.runId)))
    })
    const reserved = await contextAdmission.run(admissionKey, async () => {
      await getStartupManagedRecovery()
      await assertDeletionAllowed()
      if (hasActiveSession() || deletingSessions.has(deletionKey)) return false
      deletingSessions.add(deletionKey)
      return true
    })
    if (!reserved) return { ok: false, reason: 'active_session', ...empty() }
    try {
      if (options.confirm) {
        const confirmOptions = {
          type: 'warning' as const,
          buttons: ['取消', '删除 Scry 会话副本'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: '删除这个历史会话？',
          detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'
        }
        const confirmation = getWindow() && !getWindow()!.isDestroyed()
          ? await dialog.showMessageBox(getWindow()!, confirmOptions)
          : await dialog.showMessageBox(confirmOptions)
        if (confirmation.response !== 1) {
          return { ok: false, cancelled: true, reason: 'user_cancelled', ...empty() }
        }
      }
      return contextAdmission.run(admissionKey, async () => {
        // Matching starts are fenced by deletionKey. The context admission is reacquired
        // only for the destructive phase so broad managed recovery in another session
        // cannot resurrect this session while unrelated work is deleted.
        if (hasActiveSession()) return { ok: false, reason: 'active_session', ...empty() }
        await assertDeletionAllowed()

        const userDataDir = appUserDataDir
        const sessionStore = appSessionStore()
        let catalogRunId: string | undefined
        try {
          catalogRunId = sessionStore.load().find((session) =>
            session.providerId === providerId && session.agentProfileId === agentProfileId && session.cwd === cwd &&
            (session.sessionId === externalSessionId || session.externalSessionId === externalSessionId)
          )?.runId
        } catch (error) {
          return {
            ok: false,
            reason: 'partial_failure',
            ...empty(),
            failed: [{ store: 'catalog', error: error instanceof Error ? error.message : String(error) }]
          }
        }
        const initialRunIds = new Set(traceArchiveRunIds({ cwd, sessionId: externalSessionId, providerId, userDataDir }))
        for (const runId of options.runIds ?? []) initialRunIds.add(runId)
        if (catalogRunId) initialRunIds.add(catalogRunId)
        for (const runId of usageSessionRunIds({ userDataDir, providerId, agentProfileId, cwd, externalSessionId })) {
          initialRunIds.add(runId)
        }
        for (const runId of attachmentSessionRunIds(userDataDir, {
          providerId,
          cwd,
          sessionId: externalSessionId
        })) initialRunIds.add(runId)
        for (const runId of managedSessionRunIds(userDataDir, { cwd, sessionId: externalSessionId, providerId })) {
          initialRunIds.add(runId)
        }
        for (const runId of traceProgressSessionRunIds(userDataDir, {
          cwd,
          sessionId: externalSessionId,
          providerId
        })) initialRunIds.add(runId)
        for (const runId of turnOutboxSessionRunIds(userDataDir, { providerId, cwd, externalSessionId })) {
          initialRunIds.add(runId)
        }
        // A catalog/native alias can reference a run whose SQLite identity is a
        // different scope in this same deletion. Its own target cleans run artifacts.
        for (const runId of otherOwnedRunIds) initialRunIds.delete(runId)
        options.authorize?.()
        const result = await deleteOwnedSessionData(initialRunIds, {
          resolveRunIds: (runIds) => resolveSessionRunIds({ providerId, cwd, externalSessionId, runIds }),
          deleteDatabase: (runIds) => deleteSessionData({ providerId, cwd, externalSessionId, runIds }),
          deleteUsage: (runIds) => deleteUsageSessionRows({
            userDataDir,
            providerId,
            agentProfileId,
            cwd,
            externalSessionId,
            runIds
          }),
          deleteManaged: async (runIds) => {
            const traceProgress = deleteTraceTurnProgressArtifacts(userDataDir, runIds)
            if (traceProgress.failed.length > 0) return traceProgress
            return deleteManagedTurnArtifacts(userDataDir, runIds)
          },
          deleteOutbox: (runIds) => deleteTurnOutboxSessionRows(
            userDataDir,
            { providerId, cwd, externalSessionId },
            runIds
          ),
          deleteAttachments: (runId) => deleteRunAttachments(userDataDir, runId),
          deleteTranscripts: () => deleteTranscriptCopies({ cwd, sessionId: externalSessionId, providerId, userDataDir }),
          deleteCatalog: () => sessionStore.remove({ providerId, agentProfileId, cwd, externalSessionId })
        })
        if (!result.ok) {
          if (options.notifyFailure) {
            const failureOptions = {
              type: 'error' as const,
              message: '会话未完整删除，catalog 已保留供重试',
              detail: result.failed.map((failure) => `${failure.store}: ${failure.error}`).join('\n')
            }
            if (getWindow() && !getWindow()!.isDestroyed()) await dialog.showMessageBox(getWindow()!, failureOptions)
            else await dialog.showMessageBox(failureOptions)
          }
          return result
        }
        const key = providerContextKey(providerId, cwd, agentProfileId)
        if (sessionByContext.get(key) === externalSessionId) sessionByContext.delete(key)
        sessionDiffBaselines.discard(sessionBaselineKey(key, externalSessionId))
        recordingBlockedSessions.delete(deletionKey)
        dockBadge.remove(deletionKey)
        if (rendererCanReceive()) {
          getWindow()?.webContents.send('agent:dataUpdated', {
            runId: catalogRunId ?? externalSessionId,
            kind: 'session_deleted'
          })
        }
        return result
      })
    } finally {
      deletingSessions.delete(deletionKey)
    }
  }

  handleTrusted('agent:deleteSession', (_e, p: SessionDeletionRequest) =>
    deleteOneSession(p, { confirm: !isOwnedTestApp, notifyFailure: true }))

  function sessionRefFromRequest(p: unknown): AppSessionRef | null {
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

  async function changeLegacySessionMetadata(ref: AppSessionRef, change: () => boolean): Promise<boolean> {
    if (ref.providerId === 'legacy_unknown') return change()
    await getStartupManagedRecovery()
    await conversationStore().assertLegacyWriteAllowed({ ...ref, providerId: ref.providerId, nativeSessionId: ref.externalSessionId })
    if (adoptingSessionKeys.has(providerSessionKey(ref.providerId, ref.cwd, ref.externalSessionId, ref.agentProfileId))) {
      throw new Error('会话已归属统一对话或正在迁移，请从统一对话管理')
    }
    // Do not queue ordinary legacy archiving behind start preparation: it must
    // retain the existing persist-first fence and stop its registered owner.
    return change()
  }

  // 名称、置顶与存档只改 catalog，不动 Provider transcript 或 turn/usage/trace 数据。
  handleTrusted('agent:renameSession', (_e, p: unknown, title: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof (p as AppSessionRef).cwd !== 'string') throw new Error('无效的会话重命名请求')
    return changeLegacySessionMetadata(ref, () => appSessionStore().rename(ref, title))
  })

  handleTrusted('agent:setSessionPinned', (_e, p: unknown, pinned: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof pinned !== 'boolean') throw new Error('无效的置顶请求')
    return changeLegacySessionMetadata(ref, () => appSessionStore().setPinned(ref, pinned))
  })

  handleTrusted('agent:setSessionArchived', (_e, p: unknown, archived: unknown) => {
    const ref = sessionRefFromRequest(p)
    if (!ref || typeof archived !== 'boolean') throw new Error('无效的存档请求')
    return changeLegacySessionMetadata(ref, () => archived
      ? archiveSessionAndStop(appSessionStore(), ref, getRuns().activeStates(), requestRunStop)
      : appSessionStore().setArchived(ref, false))
  })

  handleTrusted('agent:listArchivedSessions', () => appSessionStore().listArchivedProjects())

  handleTrusted('agent:deleteArchivedSessions', async (): Promise<DeleteArchivedSessionsResult> => {
    let targets: Array<{ request: SessionDeletionRequest; preview: string }>
    try {
      targets = appSessionStore()
        .load()
        .filter((session) => session.archivedAt)
        .map((session) => ({
          request: {
            providerId: session.providerId ?? 'legacy_unknown',
            agentProfileId: session.agentProfileId,
            cwd: session.cwd,
            externalSessionId: session.externalSessionId ?? session.sessionId
          },
          preview: session.preview
        }))
    } catch {
      return { ok: false, reason: 'catalog_unavailable', deleted: 0, failures: [] }
    }
    if (targets.length === 0) return { ok: true, deleted: 0, failures: [] }
    const confirmOptions = {
      type: 'warning' as const,
      buttons: ['取消', `删除全部 ${targets.length} 个`],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: `永久删除全部 ${targets.length} 个已存档会话？`,
      detail: '将删除 Scry 的 catalog、archive、附件、SQLite 和 usage 记录。工作区 .scry/ canonical evidence 与 Provider 原生 transcript/history 会保留。'
    }
    const confirmation = getWindow() && !getWindow()!.isDestroyed()
      ? await dialog.showMessageBox(getWindow()!, confirmOptions)
      : await dialog.showMessageBox(confirmOptions)
    if (confirmation.response !== 1) {
      return { ok: false, cancelled: true, reason: 'user_cancelled', deleted: 0, failures: [] }
    }
    let deleted = 0
    const failures: DeleteArchivedSessionsResult['failures'] = []
    for (const target of targets) {
      const result = await deleteOneSession(target.request, { confirm: false, notifyFailure: false })
      if (result.ok) deleted += 1
      else failures.push({ preview: target.preview, reason: result.reason ?? 'partial_failure' })
    }
    if (failures.length > 0) {
      const failureOptions = {
        type: 'error' as const,
        message: `${failures.length} 个已存档会话未删除，catalog 已保留供重试`,
        detail: failures.map((failure) => `${failure.preview || '(无预览)'}: ${failure.reason}`).join('\n')
      }
      if (getWindow() && !getWindow()!.isDestroyed()) await dialog.showMessageBox(getWindow()!, failureOptions)
      else await dialog.showMessageBox(failureOptions)
    }
    return { ok: failures.length === 0, reason: failures.length > 0 ? 'partial_failure' : undefined, deleted, failures }
  })


  return { deleteOneSession, sessionRefFromRequest, changeLegacySessionMetadata }
}
