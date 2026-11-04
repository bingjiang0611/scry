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

function terminalFingerprint(session: RemoteSessionRef): string | null {
  return session.lastRunOutcome === 'completed' || session.lastRunOutcome === 'failed'
    ? `${session.lastRunId ?? ''}:${session.lastRunOutcome}`
    : null
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
    const previousSession = prior.get(key)
    const previousTerminal = previousSession ? terminalFingerprint(previousSession) : null
    const currentTerminal = !session.isActive ? terminalFingerprint(session) : null
    // First discovery is an explicit baseline. Later catalogs announce a new
    // terminal fingerprint, including active -> completed with the same run id.
    const newResult = previous !== undefined && currentTerminal !== null && currentTerminal !== previousTerminal
    if (unread.has(key) || newResult) next.add(key)
  }
  return next
}
