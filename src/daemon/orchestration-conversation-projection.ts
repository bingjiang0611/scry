import type { ReadConversationProjection } from '../main/conversation-service-deps'
import type { Conversation } from '../shared/conversation'
import { canonicalJson, sha256Hex } from '../host-runtime/orchestration/canonical-json'
import type { EventSink } from '../host-runtime/orchestration/event-sink'
import type { SessionDiscoverPayload, SessionImportPayload } from '../host-runtime/orchestration/orchestrator-commands'

interface MirroredMetadata {
  revision: number
  titleHash: string
  pinnedAt: number | null
  archivedAt: number | null
}

export function createConversationProjectionAccess(getSink: () => EventSink | undefined, log: (message: string) => void) {
  function syncMetadata(sink: EventSink, conversation: Conversation, committed = false) {
    const { id: sessionKey, cwd } = conversation
    const current = sink.getSession(sessionKey)
    if (current && (current.cwd !== cwd || current.catalog || (current.conversationId && current.conversationId !== sessionKey))) return null
    if (conversation.deletion || (!current && sink.handle.db.prepare(
      "SELECT 1 FROM orch_event WHERE session_key = ? AND cwd = ? AND type = 'session.deleted' LIMIT 1"
    ).get(sessionKey, cwd))) return null

    const key = `conversation_catalog:${sessionKey}`
    const raw = sink.getMeta(key)
    const prior = raw ? JSON.parse(raw) as MirroredMetadata : undefined
    const metadata: MirroredMetadata = {
      revision: conversation.revision,
      titleHash: sha256Hex(canonicalJson(conversation.title ?? null)),
      pinnedAt: conversation.pinnedAt ?? null,
      archivedAt: conversation.archivedAt ?? null
    }
    if (current?.conversationId && prior && (prior.revision >= metadata.revision ||
        (prior.titleHash === metadata.titleHash && prior.pinnedAt === metadata.pinnedAt && prior.archivedAt === metadata.archivedAt))) return current

    const title = prior && prior.titleHash === metadata.titleHash ? current?.title ?? null : conversation.title ?? null
    const pinnedAt = prior && prior.pinnedAt === metadata.pinnedAt ? current?.pinnedAt ?? null : metadata.pinnedAt
    const archivedAt = prior && prior.archivedAt === metadata.archivedAt ? current?.archivedAt ?? null : metadata.archivedAt
    const at = Date.now()
    const identity = { sessionKey, conversationId: sessionKey, cwd, title, provider: current?.provider ?? null }
    const display = { title, pinnedAt, archivedAt, lastRunId: current?.lastRunId ?? null, lastRunOutcome: current?.lastRunOutcome ?? null }
    const base = { commandId: `conversation-catalog:${sessionKey}:${metadata.revision}`, actor: 'system', scope: 'system' as const, at }
    const change = !current?.conversationId && (!committed || conversation.turns.length > 0)
      ? { type: 'session.import' as const, payload: { ...identity, ts: current?.ts ?? at, pinnedAt, archivedAt } satisfies SessionImportPayload }
      : { type: 'session.discover' as const, payload: { ...identity, display } satisfies SessionDiscoverPayload }
    sink.runInBatchTransaction(() => {
      const result = sink.execute({ ...base, ...change, payloadSha256: sha256Hex(canonicalJson(change.payload)) })
      if (result.kind === 'rejected') throw new Error(result.reason)
      sink.setMeta(key, canonicalJson(metadata))
    })
    return sink.getSession(sessionKey) ?? null
  }

  const readConversation: ReadConversationProjection = (conversation) => {
    const sink = getSink()
    if (!sink) return undefined
    const session = syncMetadata(sink, conversation)
    if (!session) return null
    const { revSeq, legacy, title, pinnedAt, archivedAt, activeRunId } = session
    return {
      revSeq, legacy, title, pinnedAt, archivedAt, activeRunId,
      turnOrdinals: (runIds) => {
        const rows = sink.handle.db.prepare(
          'SELECT run_id, ordinal FROM orch_p_turn WHERE session_key = ? AND run_id IN (SELECT value FROM json_each(?))'
        ).all(session.sessionKey, canonicalJson(runIds)) as { run_id: string; ordinal: number }[]
        return new Map(rows.map(row => [row.run_id, row.ordinal]))
      }
    }
  }

  return {
    readConversation,
    recordConversation: (conversation: Conversation) => {
      const sink = getSink()
      if (!sink) return
      try { syncMetadata(sink, conversation, true) }
      catch (error) {
        // The file and its ID are already durable. A failed SQL update is retried
        // from that file on an authoritative read or at the next startup.
        log(`daemon.conversation-projection ${(error as { code?: string }).code ?? 'unavailable'}`)
      }
    },
    importExisting: (conversations: Iterable<Conversation>) => {
      const sink = getSink()
      if (!sink) return
      sink.runInBatchTransaction(() => {
        for (const conversation of conversations) syncMetadata(sink, conversation)
      })
    }
  }
}
