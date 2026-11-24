import { findNativeSession } from '../../host-runtime/orchestration/native-session-lookup'
import { hostQueueEntries, type HostQueueAnswer, type HostQueueRow } from '../../shared/host-queue'
import type { DaemonLocalOpGroup } from './deps'

interface HostQueueRequest {
  /** The App's own session id; also the projection key for non-native sessions. */
  sessionId: string
  providerId?: string
  agentProfileId?: string | null
  cwd?: string
}

/**
 * D1: the queue lives on the host, so the App asks for it instead of reconstructing one from what it
 * happens to have sent. The App knows a session by its own id, provider and cwd — not by the
 * projection's `native:<digest>` key — so the daemon resolves the key with the same lookup the
 * catalog uses, and only then reads the rows.
 *
 * A session the projection has never seen answers with an empty queue: "nothing queued" is the truth
 * for a session that has not run yet.
 */
export const hostQueueLocalOps: DaemonLocalOpGroup = (deps) => ({
  'agent:hostQueue': async (input: unknown): Promise<HostQueueAnswer> => {
    const request = readRequest(input)
    const reader = deps.orchestrationReader?.()
    if (!reader) throw new Error('orchestration_unavailable')
    const bound = findNativeSession(reader, {
      sessionId: request.sessionId,
      provider: request.providerId ?? 'legacy_unknown',
      profile: request.agentProfileId ?? null,
      cwd: request.cwd
    })
    // No binding and no row of its own means the projection has never seen this session: the queue
    // is unknown. Saying "empty" there would be a guess, and a queue is a promise about dispatch.
    const own = bound ? undefined : reader.getSession(request.sessionId)
    const sessionKey = bound?.sessionKey ?? own?.sessionKey ?? null
    if (!sessionKey) return { resolved: false, entries: [] }
    const rows = reader.handle.db.prepare(
      `SELECT run_id AS runId, session_key AS sessionKey, lifecycle, queue_position AS queuePosition,
              queue_held AS queueHeld, origin, intent_seq AS intentSeq, prompt_preview AS promptPreview
         FROM orch_p_run
        WHERE session_key = ? AND lifecycle = 'queued'`
    ).all(sessionKey) as (Omit<HostQueueRow, 'queueHeld'> & { queueHeld: number | null })[]
    // The shared ordering decides the order, so the App and a device cannot disagree.
    return { resolved: true, entries: hostQueueEntries(rows.map((row) => ({ ...row, queueHeld: row.queueHeld === 1 })), sessionKey) }
  }
})

function readRequest(input: unknown): HostQueueRequest {
  const value = (input ?? {}) as Record<string, unknown>
  const sessionId = value.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) throw new Error('invalid_session_id')
  const providerId = value.providerId
  if (providerId !== undefined && (typeof providerId !== 'string' || providerId.length > 128)) throw new Error('invalid_provider_id')
  const cwd = value.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > 4096 || cwd.includes('\0'))) throw new Error('invalid_cwd')
  const agentProfileId = value.agentProfileId
  if (agentProfileId !== undefined && agentProfileId !== null && typeof agentProfileId !== 'string') throw new Error('invalid_agent_profile_id')
  return {
    sessionId,
    ...(providerId === undefined ? {} : { providerId }),
    ...(agentProfileId === undefined ? {} : { agentProfileId }),
    ...(cwd === undefined ? {} : { cwd })
  }
}
