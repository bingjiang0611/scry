import { join } from 'node:path'
import type { ProviderContext, ProviderId, SessionProviderId, DeleteSessionResult, DeleteArchivedSessionsResult, DeleteArchivedProgress } from '../../shared/provider'
import type { AgentDataUpdated } from '../../shared/runtime'
import type { Conversation } from '../../shared/conversation'
import type { ConversationDeletionPreview } from '../../shared/conversation-api'
import type { AppSessionRef, createAppSessionStore } from '../app-store'
import type { ConversationStore } from '../conversation-store'
import type { ContextAdmission } from '../context-admission'
import type { SessionDiffBaselineRegistry } from '../session-diff'
import type { ActiveRun } from '../../shared/trace'
import { deleteTranscriptCopies, traceArchiveRunIds } from '../transcript-archive'
import { resolveSessionRunIds, deleteSessionData, deleteTurnOutboxSessionRows, turnOutboxSessionRunIds } from '../db'
import { usageSessionRunIds, deleteUsageSessionRows } from '../usage-jsonl'
import { attachmentSessionRunIds, deleteRunAttachments } from '../attachment-store'
import { managedSessionRunIds, deleteManagedTurnArtifacts } from '../managed-turn-commit'
import { traceProgressSessionRunIds, deleteTraceTurnProgressArtifacts } from '../trace-turn-progress'
import { deleteOwnedSessionData } from '../session-deletion'
import type { SideChatCascade } from './conversation-delete'
import { createSessionSideChats } from './session-side-chats'
import { createSessionMetadataOps, sessionRefFromRequest } from './session-lifecycle-metadata'
import { createSessionMetadataRecorder } from './session-metadata-reconcile'
import { archivedDeletionPrompt, sessionDeletionPrompt, untouchedDeletion } from './session-deletion-prompts'

// Session delete, rename, pin, archive and archived purge, free of Electron so main and
// the daemon run one implementation. Asking the user is the caller's: main passes its
// dialogs; the daemon passes none, because in daemon mode the App asked before sending.

interface DeletionRuns {
  activeStates: () => ActiveRun[]
  unsettledStates: () => ActiveRun[]
}

export interface SessionLifecycleDependencies {
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
  assertLegacyConversationWriteAllowed: (scope: { providerId: ProviderId; agentProfileId?: string; cwd: string; nativeSessionId?: string }, deletion?: { ownerId?: string }) => Promise<void>
  sessionByContext: Map<string, string>
  adoptingSessionKeys: Set<string>
  dockBadge: { remove: (key: string) => void }
  appUserDataDir: string
  requestRunStop: (runId: string) => boolean
  prepareConversationDeletion: (conversation: Conversation) => Promise<ConversationDeletionPreview>
  /** A Provider session's side chats, deleted with it (they live only in its panel). */
  sideChatCascade: SideChatCascade
  deleteNativeProjection?: (ref: AppSessionRef, runIds: ReadonlySet<string>, actor?: string) => { status: 'deleted' | 'not_present' | 'unavailable'; error?: string }
  /** D4: the authority records rename/pin/archive so the projection and devices see them. */
  recordSessionMetadata?: (input: {
    externalSessionId: string
    providerId: string
    agentProfileId?: string | undefined
    cwd: string
    change: { kind: 'rename'; title: string } | { kind: 'pin'; pinned: boolean } | { kind: 'archive'; archived: boolean }
    actor: string
  }) => unknown
  warnSessionMetadata?: (message: string, error: unknown) => void
  publishDataUpdated: (event: AgentDataUpdated) => void
  /** The real count of archived sessions handled so far, for the renderer to show in place. */
  publishDeleteProgress?: (progress: DeleteArchivedProgress) => void
  /** Asks the user; false or absent answer means no. Absent when the caller already asked. */
  confirm?: (prompt: { message: string; detail: string; button: string }) => Promise<boolean>
  notifyFailure?: (notice: { message: string; detail: string }) => Promise<void>
}

export type SessionDeletionRequest = Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }

export function createSessionLifecycle(deps: SessionLifecycleDependencies) {
  const { getRuns, appSessionStore, conversationStore, contextAdmission, getStartupManagedRecovery, providerContextKey, providerSessionKey, deletingSessions, sessionDiffBaselines, sessionBaselineKey, recordingBlockedSessions, appUserDataDir, requestRunStop, prepareConversationDeletion, assertLegacyConversationWriteAllowed, sessionByContext, adoptingSessionKeys, dockBadge, publishDataUpdated, sideChatCascade } = deps
  const sessionSideChats = createSessionSideChats({ appSessionStore, sideChatCascade, notifyFailure: deps.notifyFailure })
  const { deleteNativeProjection } = deps
  // R10: the catalog file is already written when the event is attempted, so a failed event is logged,
  // queued and replayed instead of turning the user's change into a failed call.
  const metadataRecorder = createSessionMetadataRecorder({
    file: join(appUserDataDir, 'session-metadata-pending.json'),
    warn: deps.warnSessionMetadata,
    ...(deps.recordSessionMetadata ? { record: deps.recordSessionMetadata } : {})
  })
  // D4: the metadata operations and their event recording live in their own module.
  const { changeLegacySessionMetadata, renameSession, setSessionPinned, setSessionArchived } = createSessionMetadataOps({
    appSessionStore,
    conversationStore,
    getStartupManagedRecovery,
    providerSessionKey: deps.providerSessionKey,
    adoptingSessionKeys,
    getRuns: () => ({ activeStates: () => getRuns().activeStates() }),
    requestRunStop,
    dockBadge,
    ...(deps.recordSessionMetadata ? { recordSessionMetadata: (input) => metadataRecorder.record(input) } : {})
  })

  // 删除一个历史会话。工作区 .scry/ 是独立 canonical evidence，明确保留。
  // confirm / notifyFailure 由调用方决定：单条删除各弹一次系统弹窗，批量删除只在批次首尾各弹一次。
  async function deleteOneSession(
    p: SessionDeletionRequest,
    options: {
      confirm: boolean
      notifyFailure: boolean
      conversationId?: string
      runIds?: readonly string[]
      authorize?: () => void
      /** D4: the caller that asked for the delete, so the tombstone event names it. */
      actor?: string
    }
  ): Promise<DeleteSessionResult> {
    const empty = untouchedDeletion
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
    // A Provider session takes its side chats with it. A conversation's own targets come
    // through here too, and that delete owns its children.
    let sideChats: Awaited<ReturnType<typeof sessionSideChats.plan>> | undefined
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
      if (!options.conversationId) {
        try {
          sideChats = await sessionSideChats.plan({ providerId, agentProfileId, cwd, externalSessionId })
        } catch (error) { return sessionSideChats.kept(sessionSideChats.failureOf(error), options.notifyFailure, empty()) }
      }
      if (options.confirm && deps.confirm) {
        const confirmed = await deps.confirm(sessionDeletionPrompt(sideChats?.count))
        if (!confirmed) {
          return { ok: false, cancelled: true, reason: 'user_cancelled', ...empty() }
        }
      }
      if (sideChats?.count) {
        // Side chats are deleted before the session's own destructive phase, so the
        // caller's authorization is re-checked here exactly as it is there.
        options.authorize?.()
        const failed = await sessionSideChats.remove(sideChats.scope)
        if (failed.length > 0) return sessionSideChats.kept(failed, options.notifyFailure, empty())
      }
      // Awaited: the finally below drops the reservation, which must outlive this phase.
      return await contextAdmission.run(admissionKey, async () => {
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
          deleteProjection: deleteNativeProjection
            ? (runIds) => {
                options.authorize?.()
                return deleteNativeProjection({ providerId, agentProfileId, cwd, externalSessionId }, runIds, options.actor)
              }
            : undefined,
          deleteCatalog: () => sessionStore.remove({ providerId, agentProfileId, cwd, externalSessionId })
        })
        if (!result.ok) {
          if (options.notifyFailure) {
            await deps.notifyFailure?.({
              message: '会话未完整删除，catalog 已保留供重试',
              detail: result.failed.map((failure) => `${failure.store}: ${failure.error}`).join('\n')
            })
          }
          return result
        }
        const key = providerContextKey(providerId, cwd, agentProfileId)
        if (sessionByContext.get(key) === externalSessionId) sessionByContext.delete(key)
        sessionDiffBaselines.discard(sessionBaselineKey(key, externalSessionId))
        recordingBlockedSessions.delete(deletionKey)
        dockBadge.remove(deletionKey)
        publishDataUpdated({ runId: catalogRunId ?? externalSessionId, kind: 'session_deleted' })
        return result
      })
    } finally {
      deletingSessions.delete(deletionKey)
    }
  }

  const listArchivedSessions = () => appSessionStore().listArchivedProjects()

  /**
   * `confirmedCount`: the App already asked about that many archived sessions (daemon
   * mode). A different count now means the catalog changed after the user answered, so
   * nothing is deleted rather than sessions the user never saw.
   */
  async function deleteArchivedSessions(confirmedCount?: number): Promise<DeleteArchivedSessionsResult> {
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
    if (confirmedCount !== undefined) {
      if (confirmedCount !== targets.length) return { ok: false, reason: 'catalog_changed', deleted: 0, failures: [] }
    } else if (deps.confirm) {
      const confirmed = await deps.confirm(archivedDeletionPrompt(targets.length))
      if (!confirmed) return { ok: false, cancelled: true, reason: 'user_cancelled', deleted: 0, failures: [] }
    }
    let deleted = 0
    const failures: DeleteArchivedSessionsResult['failures'] = []
    // Progress is the real count of sessions handled so far; the renderer shows it in place.
    const progress = (done: number): void => deps.publishDeleteProgress?.({ done, total: targets.length, failed: failures.length })
    progress(0)
    for (const [index, target] of targets.entries()) {
      const result = await deleteOneSession(target.request, { confirm: false, notifyFailure: false })
      if (result.ok) deleted += 1
      else failures.push({ preview: target.preview, reason: result.reason ?? 'partial_failure' })
      progress(index + 1)
    }
    if (failures.length > 0) {
      await deps.notifyFailure?.({
        message: `${failures.length} 个已存档会话未删除，catalog 已保留供重试`,
        detail: failures.map((failure) => `${failure.preview || '(无预览)'}: ${failure.reason}`).join('\n')
      })
    }
    return { ok: failures.length === 0, reason: failures.length > 0 ? 'partial_failure' : undefined, deleted, failures }
  }

  return {
    deleteOneSession, sessionRefFromRequest, changeLegacySessionMetadata,
    renameSession, setSessionPinned, setSessionArchived, listArchivedSessions, deleteArchivedSessions,
    /** R10: replays metadata events the authority could not record when the user made the change. */
    reconcileSessionMetadata: () => metadataRecorder.reconcile()
  }
}
