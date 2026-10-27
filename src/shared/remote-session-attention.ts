import type { RemoteSessionRef } from './desktop-remote'

export interface RemoteSessionIdentity {
  providerId: string
  agentProfileId?: string
  cwd: string
  externalSessionId?: string
}

export function remoteSessionAttentionKey(connectionId: string, session: RemoteSessionIdentity): string {
  return JSON.stringify([connectionId, session.providerId, session.agentProfileId ?? '', session.cwd, session.externalSessionId])
}

export function reconcileRemoteSessionAttention(
  connectionId: string,
  previous: readonly RemoteSessionRef[] | undefined,
  sessions: readonly RemoteSessionRef[],
  unread: ReadonlySet<string>,
  viewedKey: string | null
): ReadonlySet<string> {
  const prior = new Map(previous?.map(session => [remoteSessionAttentionKey(connectionId, session), session]))
  const next = new Set<string>()
  for (const session of sessions) {
    if (!session.externalSessionId || session.archivedAt) continue
    const key = remoteSessionAttentionKey(connectionId, session)
    if (key === viewedKey) continue
    const terminal = !session.isActive && (session.lastRunOutcome === 'completed' || session.lastRunOutcome === 'failed')
    // First discovery is a baseline, not thousands of unseen historical results.
    // Keep it across disconnects so a new terminal run is detected on reconnect.
    const newResult = previous !== undefined && terminal && session.lastRunId && prior.get(key)?.lastRunId !== session.lastRunId
    if (unread.has(key) || newResult) next.add(key)
  }
  return next
}
