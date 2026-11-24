import type { HostQueueEntry, HostQueueRequest } from '../../shared/host-queue'
import { isAgentQueueEntry } from '../../shared/host-queue'
import { HOST_QUEUE_COPY } from '../constants/host-queue-copy'

export interface HostQueueItem {
  runId: string
  position: number
  positionLabel: string
  text: string
  /** Why this entry is not moving on its own, or who queued it; null when neither applies. */
  note: string | null
}

/**
 * The display projection of the host's queue. It keeps the host's order and position verbatim: the
 * renderer must not renumber what the host said, or two clients would disagree about "第几位".
 */
export function hostQueueItems(entries: readonly HostQueueEntry[]): HostQueueItem[] {
  return entries.map((entry) => {
    const notes = [
      ...(entry.held ? [HOST_QUEUE_COPY.held] : []),
      ...(isAgentQueueEntry(entry) ? [HOST_QUEUE_COPY.fromAgent] : [])
    ]
    return {
      runId: entry.runId,
      position: entry.position,
      positionLabel: HOST_QUEUE_COPY.position(entry.position),
      text: entry.promptPreview ?? HOST_QUEUE_COPY.noPrompt,
      note: notes.length > 0 ? notes.join(' · ') : null
    }
  })
}

/** The request the panel sends: only the fields the session actually has, so a blank never travels. */
export function hostQueueRequestFor(session: { sessionId: string | null; providerId?: string | null; cwd?: string | null; agentProfileId?: string | null }): HostQueueRequest | null {
  if (!session.sessionId) return null
  return {
    sessionId: session.sessionId,
    ...(session.providerId ? { providerId: session.providerId } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.agentProfileId ? { agentProfileId: session.agentProfileId } : {})
  }
}
