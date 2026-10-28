import type { BrowserWindow, Dialog, IpcMainInvokeEvent } from 'electron'
import type { Conversation } from '../shared/conversation'
import type { ConversationDeletionPreview } from '../shared/conversation-api'
import type { DeleteArchivedSessionsResult, DeleteSessionResult, ProviderId } from '../shared/provider'
import type { createAppSessionStore } from './app-store'
import type { ConversationStore, NativeSessionScope } from './conversation-store'
import type { SessionDeletionRequest } from './conversation-app-ipc'
import type { ContextAdmission } from './context-admission'
import type { ActiveRun } from '../shared/trace'
import type { SessionDiffBaselineRegistry } from './session-diff'
import { attachmentSessionRunIds, deleteRunAttachments } from './attachment-store'
import { deleteSessionData, deleteTurnOutboxSessionRows, resolveSessionRunIds, turnOutboxSessionRunIds } from './db'
import { deleteOwnedSessionData } from './session-deletion'
import { deleteManagedTurnArtifacts, managedSessionRunIds } from './managed-turn-commit'
import { deleteTranscriptCopies, traceArchiveRunIds } from './transcript-archive'
import { deleteUsageSessionRows, usageSessionRunIds } from './usage-jsonl'
import { deleteTraceTurnProgressArtifacts, traceProgressSessionRunIds } from './trace-turn-progress'
import type { DockBadgeState } from './dock-badge'
import { sessionDeletionCopy as copy } from '../shared/constants/session-deletion-copy'

export type DeleteOneSession = (
  request: SessionDeletionRequest,
  options: { confirm: boolean; notifyFailure: boolean; conversationId?: string; runIds?: readonly string[] }
) => Promise<DeleteSessionResult>

type DeletionRunState = Pick<ActiveRun, 'runId' | 'providerId' | 'cwd' | 'externalSessionId' | 'sessionId'>

/** Historical-session deletion IPC and its shared physical cleanup helper. */
export function registerSessionDeletionIpc(deps: {
  handleTrusted: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: never[]) => unknown) => void
  appSessionStore: () => Pick<ReturnType<typeof createAppSessionStore>, 'load' | 'remove'>
  dialog: Pick<Dialog, 'showMessageBox'>
  window: () => BrowserWindow | null
  isOwnedTestApp: boolean
  providerContextKey: (providerId: ProviderId, cwd: string, agentProfileId?: string) => string
  providerSessionKey: (providerId: ProviderId, cwd: string, sessionId: string, agentProfileId?: string) => string
  conversationStore: () => Pick<ConversationStore, 'read'>
  prepareConversationDeletion: (conversation: Conversation) => Promise<ConversationDeletionPreview>
  assertLegacyConversationWriteAllowed: (scope: NativeSessionScope, deletion?: { ownerId?: string }) => Promise<void>
  unsettledRuns: () => DeletionRunState[]
  contextAdmission: Pick<ContextAdmission, 'run'>
  startupManagedRecovery: () => Promise<void>
  deletingSessions: Set<string>
  userDataDir: () => string
  sessionByContext: Map<string, string>
  sessionDiffBaselines: Pick<SessionDiffBaselineRegistry, 'discard'>
  sessionBaselineKey: (context: string, sessionId: string) => string
  recordingBlockedSessions: Pick<Map<string, string>, 'delete'>
  dockBadge: Pick<DockBadgeState, 'remove'>
  rendererCanReceive: () => boolean
  sendDataUpdated: (payload: { runId: string; kind: 'session_deleted' }) => void
}) {
  const deleteOneSession: DeleteOneSession = async (
    p,
    options
  ): Promise<DeleteSessionResult> => {
    const empty = (): Pick<DeleteSessionResult, 'deleted' | 'retained' | 'failed'> => ({
      deleted: [],
      retained: [...copy.retained],
      failed: []
    })
    if (!p.externalSessionId || p.providerId === 'legacy_unknown') {
      return { ok: false, reason: 'invalid_request', ...empty() }
    }
    const cwd = p.cwd ?? ''
    const externalSessionId = p.externalSessionId
    const providerId = p.providerId as ProviderId
    const agentProfileId = p.agentProfileId
    const admissionKey = deps.providerContextKey(providerId, cwd, agentProfileId)
    const deletionKey = deps.providerSessionKey(providerId, cwd, externalSessionId, agentProfileId)
    let otherOwnedRunIds = new Set<string>()
    const assertDeletionAllowed = async (): Promise<void> => {
      if (!options.conversationId) return deps.assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, {})
      const owner = await deps.conversationStore().read(options.conversationId)
      if (!owner || owner.cwd !== cwd || owner.deletion?.status !== 'pending') throw new Error(copy.missingAuthorization)
      const plan = await deps.prepareConversationDeletion(owner)
      const target = plan.targets.find(target => target.providerId === providerId && target.agentProfileId === agentProfileId && target.externalSessionId === externalSessionId)
      if (!target || target.sharedWith.length) throw new Error(copy.targetShared)
      otherOwnedRunIds = new Set(plan.targets.filter(other => other !== target).flatMap(other => other.runIds))
      await deps.assertLegacyConversationWriteAllowed({ providerId, agentProfileId, cwd, nativeSessionId: externalSessionId }, { ownerId: options.conversationId })
    }
    const hasActiveSession = (): boolean => deps.unsettledRuns().some((run) => {
      const sessionId = run.externalSessionId ?? run.sessionId
      return run.providerId === providerId && (run.cwd ?? '') === cwd &&
        (run.runId === externalSessionId || sessionId === externalSessionId || Boolean(options.runIds?.includes(run.runId)))
    })
    const reserved = await deps.contextAdmission.run(admissionKey, async () => {
      await deps.startupManagedRecovery()
      await assertDeletionAllowed()
      if (hasActiveSession() || deps.deletingSessions.has(deletionKey)) return false
      deps.deletingSessions.add(deletionKey)
      return true
    })
    if (!reserved) return { ok: false, reason: 'active_session', ...empty() }
    try {
      if (options.confirm) {
        const confirmOptions = {
          type: 'warning' as const,
          buttons: [copy.cancel, copy.deleteCopies],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: copy.confirmOne,
          detail: copy.detail
        }
        const window = deps.window()
        const confirmation = window && !window.isDestroyed()
          ? await deps.dialog.showMessageBox(window, confirmOptions)
          : await deps.dialog.showMessageBox(confirmOptions)
        if (confirmation.response !== 1) {
          return { ok: false, cancelled: true, reason: 'user_cancelled', ...empty() }
        }
      }
      return deps.contextAdmission.run(admissionKey, async () => {
        // Matching starts are fenced by deletionKey. The context admission is reacquired
        // only for the destructive phase so broad managed recovery in another session
        // cannot resurrect this session while unrelated work is deleted.
        if (hasActiveSession()) return { ok: false, reason: 'active_session', ...empty() }
        await assertDeletionAllowed()

        const userDataDir = deps.userDataDir()
        const sessionStore = deps.appSessionStore()
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
              message: copy.partialFailure,
              detail: copy.partialDetails(result.failed)
            }
            const window = deps.window()
            if (window && !window.isDestroyed()) await deps.dialog.showMessageBox(window, failureOptions)
            else await deps.dialog.showMessageBox(failureOptions)
          }
          return result
        }
        const key = deps.providerContextKey(providerId, cwd, agentProfileId)
        if (deps.sessionByContext.get(key) === externalSessionId) deps.sessionByContext.delete(key)
        deps.sessionDiffBaselines.discard(deps.sessionBaselineKey(key, externalSessionId))
        deps.recordingBlockedSessions.delete(deletionKey)
        deps.dockBadge.remove(deletionKey)
        if (deps.rendererCanReceive()) {
          deps.sendDataUpdated({
            runId: catalogRunId ?? externalSessionId,
            kind: 'session_deleted'
          })
        }
        return result
      })
    } finally {
      deps.deletingSessions.delete(deletionKey)
    }
  }

  deps.handleTrusted('agent:deleteSession', (_event, p: SessionDeletionRequest) =>
    deleteOneSession(p, { confirm: !deps.isOwnedTestApp, notifyFailure: true }))

  deps.handleTrusted('agent:deleteArchivedSessions', async (): Promise<DeleteArchivedSessionsResult> => {
    let targets: Array<{ request: SessionDeletionRequest; preview: string }>
    try {
      targets = deps.appSessionStore()
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
      buttons: [copy.cancel, copy.deleteAll(targets.length)],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: copy.confirmAll(targets.length),
      detail: copy.detail
    }
    const window = deps.window()
    const confirmation = window && !window.isDestroyed()
      ? await deps.dialog.showMessageBox(window, confirmOptions)
      : await deps.dialog.showMessageBox(confirmOptions)
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
        message: copy.failedAll(failures.length),
        detail: copy.failedDetails(failures)
      }
      const window = deps.window()
      if (window && !window.isDestroyed()) await deps.dialog.showMessageBox(window, failureOptions)
      else await deps.dialog.showMessageBox(failureOptions)
    }
    return { ok: failures.length === 0, reason: failures.length > 0 ? 'partial_failure' : undefined, deleted, failures }
  })

  return { deleteOneSession }
}
