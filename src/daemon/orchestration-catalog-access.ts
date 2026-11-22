import { isSessionProviderId, type AppSession, type AppSessionRef } from '../main/app-store'
import type { ReadProjectedHistorySession } from '../main/bootstrap/history-catalog'
import { available } from '../shared/turn-record'
import type { Conversation } from '../shared/conversation'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { DeleteSessionOutcome } from '../host-runtime/orchestration/event-sink-maintenance'
import { deletedNativeSessionKey, findNativeSession, scopedNativeSessionKey } from '../host-runtime/orchestration/native-session-lookup'
import type { SessionDiscoverPayload } from '../host-runtime/orchestration/orchestrator-commands'
import { mapSessionRow } from '../host-runtime/orchestration/projection-mappers'
import type { SessionProjectionRow } from '../host-runtime/orchestration/types'
import { createConversationProjectionAccess } from './orchestration-conversation-projection'

type NativeIdentity = { sessionId: string; providerId?: string; agentProfileId?: string; cwd: string | undefined }

function identityKey(session: NativeIdentity): string {
  return JSON.stringify([session.providerId ?? 'legacy_unknown', session.agentProfileId ?? null, session.cwd, session.sessionId])
}

export function findProjectedNativeSession(sink: EventSink, session: NativeIdentity): SessionProjectionRow | undefined {
  return findNativeSession(sink, {
    sessionId: session.sessionId,
    provider: session.providerId ?? 'legacy_unknown',
    profile: session.agentProfileId ?? null,
    cwd: session.cwd
  })
}

function displayedOutcome(value: string | undefined): AppSession['lastRunOutcome'] {
  if (value === 'settled' || value === 'completed') return 'completed'
  if (value === 'failed' || value === 'cancelled' || value === 'interrupted') return value
  return undefined
}

function projectAppSession(row: SessionProjectionRow): AppSession | undefined {
  if (!row.catalog || row.cwd === null) return undefined
  const { nativeSessionId, projectCwd, preview, runtimeProvider } = row.catalog
  return {
    sessionId: nativeSessionId ?? row.sessionKey,
    providerId: isSessionProviderId(row.provider) ? row.provider : 'legacy_unknown',
    agentProfileId: row.profile ?? undefined,
    cwd: row.cwd,
    title: row.title ?? undefined,
    ts: row.ts,
    runId: row.lastRunId ?? undefined,
    lastRunOutcome: row.lastRunOutcome?.status === 'available'
      ? displayedOutcome(row.lastRunOutcome.value) : undefined,
    externalSessionId: nativeSessionId ?? undefined,
    projectCwd: projectCwd ?? undefined,
    runtimeProvider: runtimeProvider ?? undefined,
    preview: preview ?? '',
    pinnedAt: row.pinnedAt ?? undefined,
    archivedAt: row.archivedAt ?? undefined
  }
}

/** Local sidebar rows come from the authority. The old file is still mirrored
 * for off/shadow startup and readers that have yet to migrate. */
export function createOrchestrationCatalogAccess(getSink: () => EventSink | undefined) {
  const readDetail: ReadProjectedHistorySession = (context, canonicalCwd) => {
    const sink = getSink()
    if (!sink) return undefined
    if (!context.externalSessionId) return null
    const row = findProjectedNativeSession(sink, { ...context, sessionId: context.externalSessionId, cwd: canonicalCwd })
    const session = row && projectAppSession(row)
    if (!row || !session) return null
    return { session, identity: { sessionKey: row.sessionKey, ...(row.legacy ? { legacyBefore: true } : {}) } }
  }
  return {
    readDetail,
    ...createConversationProjectionAccess(getSink),
    deleteNative(ref: AppSessionRef, runIds: ReadonlySet<string>): DeleteSessionOutcome {
      const sink = getSink()
      if (!sink) return { status: 'not_present' }
      if (!sink.handle.db.open || sink.isWriteIndeterminate()) {
        return { status: 'unavailable', error: 'orchestration_write_indeterminate' }
      }
      const session = findProjectedNativeSession(sink, { ...ref, sessionId: ref.externalSessionId })
      const identity = {
        sessionId: ref.externalSessionId, provider: ref.providerId, profile: ref.agentProfileId ?? null, cwd: ref.cwd
      }
      const sessionKey = session?.sessionKey ?? deletedNativeSessionKey(sink, identity)
      if (!sessionKey) return { status: 'not_present' }
      return sink.deleteSession({
        sessionKey,
        cwd: session?.cwd ?? ref.cwd,
        actor: 'system',
        scope: 'system',
        at: Date.now(),
        unboundRunIds: [...runIds],
        nativeIdentity: scopedNativeSessionKey(identity),
        nativeSource: scopedNativeSessionKey({ ...identity, profile: null })
      })
    },

    deleteConversation(conversation: Conversation): DeleteSessionOutcome {
      const sink = getSink()
      if (!sink) return { status: 'not_present' }
      if (!sink.handle.db.open || sink.isWriteIndeterminate()) {
        return { status: 'unavailable', error: 'orchestration_write_indeterminate' }
      }
      const { id: sessionKey, cwd } = conversation
      const session = sink.getSession(sessionKey)
      if (session) {
        if (session.cwd !== cwd) return { status: 'not_present' }
        // Older run-created rows have no conversationId. Prove their ownership
        // with the dispatched run IDs from the authorized conversation ledger.
        if (session.conversationId !== sessionKey && (session.conversationId !== null || !sink.handle.db
          .prepare('SELECT 1 FROM orch_p_run WHERE session_key = ? AND run_id IN (SELECT value FROM json_each(?)) LIMIT 1')
          .get(sessionKey, canonicalJson(conversation.turns.map(turn => turn.runId))))) return { status: 'not_present' }
      } else if (!sink.handle.db
        .prepare("SELECT 1 FROM orch_event WHERE type = 'session.deleted' AND session_key = ? AND cwd = ? LIMIT 1")
        .get(sessionKey, cwd)) {
        return { status: 'not_present' }
      }
      return sink.deleteSession({ sessionKey, cwd, actor: 'system', scope: 'system', at: Date.now() })
    },

    read(): AppSession[] | undefined {
      const sink = getSink()
      if (!sink) return undefined
      const rows = sink.handle.db.prepare(
        `SELECT * FROM orch_p_session
         WHERE conversation_id IS NULL AND catalog IS NOT NULL ORDER BY ts DESC, session_key`
      ).all() as Record<string, unknown>[]
      return rows.map(mapSessionRow).map(projectAppSession).filter((row): row is AppSession => row !== undefined)
    },

    beforeMirrorWrite(previous: readonly AppSession[], next: readonly AppSession[]): void {
      const sink = getSink()
      if (!sink) return
      const byIdentity = new Map(previous.map((row) => [identityKey(row), row]))
      const pendingByRun = new Map(previous.filter((row) => !row.externalSessionId && row.runId).map((row) => [row.runId, row]))
      sink.runInBatchTransaction(() => {
        for (const row of next) {
          const identity = identityKey(row)
          const prior = byIdentity.get(identity)
          if (prior && canonicalJson(prior) === canonicalJson(row)) continue

          const pending = row.runId ? pendingByRun.get(row.runId) : undefined
          const native = row.externalSessionId ? { ...row, sessionId: row.externalSessionId } : row
          const current = findProjectedNativeSession(sink, native) ??
            (pending ? findProjectedNativeSession(sink, pending) : undefined)
          const sessionKey = current?.sessionKey ?? (sink.getSession(row.sessionId) ? `native:${sha256Hex(identity)}` : row.sessionId)
          const outcome = row.runId ? sink.getRun(row.runId)?.outcome : undefined
          const payload: SessionDiscoverPayload = {
            sessionKey,
            provider: row.providerId ?? 'legacy_unknown',
            profile: row.agentProfileId ?? null,
            cwd: row.cwd,
            catalog: {
              nativeSessionId: row.externalSessionId ?? null,
              projectCwd: row.projectCwd ?? null,
              preview: row.preview,
              runtimeProvider: row.runtimeProvider ?? null
            },
            display: {
              title: row.title === prior?.title && current ? current.title : row.title ?? null,
              pinnedAt: row.pinnedAt === prior?.pinnedAt && current ? current.pinnedAt : row.pinnedAt ?? null,
              archivedAt: row.archivedAt === prior?.archivedAt && current ? current.archivedAt : row.archivedAt ?? null,
              lastRunId: row.runId ?? current?.lastRunId ?? null,
              lastRunOutcome: outcome ?? (row.lastRunOutcome ? available(row.lastRunOutcome, ['host.catalog_mutation'], 'inferred') : null)
            }
          }
          const payloadSha256 = sha256Hex(canonicalJson(payload))
          const updated = sink.execute({
            type: 'session.discover',
            commandId: `app-catalog:${sessionKey}:${current?.revSeq ?? 0}:${payloadSha256.slice(0, 16)}`,
            actor: 'system',
            scope: 'system',
            at: row.ts,
            payload,
            payloadSha256
          })
          if (updated.kind === 'rejected') throw new Error(updated.reason)
        }
        const kept = new Set(next.map(identityKey))
        for (const pending of pendingByRun.values()) {
          if (kept.has(identityKey(pending))) continue
          const session = findProjectedNativeSession(sink, pending)
          if (session?.catalog?.nativeSessionId !== null || session.activeRunId) continue
          const payload = { sessionKey: session.sessionKey }
          const updated = sink.execute({
            type: 'session.withdraw',
            commandId: `app-catalog-withdraw:${session.sessionKey}:${session.revSeq}`,
            actor: 'system',
            scope: 'system',
            at: Date.now(),
            payload,
            payloadSha256: sha256Hex(canonicalJson(payload))
          })
          if (updated.kind === 'rejected') throw new Error(updated.reason)
        }
      })
    }
  }
}
