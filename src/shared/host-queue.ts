/**
 * D1: the queue lives on the host, so every client shows the same one. This is the one place that
 * decides what "the queue" means: only rows the host accepted and has not dispatched, ordered by the
 * slot the host assigned, with a stable tie-break so two clients never disagree.
 *
 * A held entry is still in the queue — it just will not dispatch on its own, and saying so is the
 * difference between "this will run" and "this is waiting for you".
 */
export interface HostQueueRow {
  runId: string
  sessionKey?: string | null
  lifecycle: string
  /** Host-assigned 1-based slot; absent on older hosts, which then order by intent sequence. */
  queuePosition?: number | null
  queueHeld?: boolean
  intentSeq?: number | null
  promptPreview?: string | null
  origin?: string | null
}

export interface HostQueueEntry {
  runId: string
  position: number
  held: boolean
  promptPreview: string | null
  origin: string | null
}

/** Rows the host is holding in a session's queue, in the order it will dispatch them. */
export function hostQueueEntries(rows: readonly HostQueueRow[], sessionKey?: string): HostQueueEntry[] {
  const queued = rows.filter((row) =>
    row.lifecycle === 'queued' && (sessionKey === undefined || row.sessionKey === sessionKey)
  )
  const ordered = [...queued].sort((left, right) => {
    const leftPosition = left.queuePosition ?? Number.POSITIVE_INFINITY
    const rightPosition = right.queuePosition ?? Number.POSITIVE_INFINITY
    if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1
    return (left.intentSeq ?? 0) - (right.intentSeq ?? 0)
  })
  return ordered.map((row, index) => ({
    runId: row.runId,
    // A host that did not report a slot still has an order; the index is that order.
    position: row.queuePosition ?? index + 1,
    held: row.queueHeld === true,
    promptPreview: row.promptPreview ?? null,
    origin: row.origin ?? null
  }))
}

/** Whether a queue entry came from the agent rather than the user, so the UI can say whose turn it is. */
export function isAgentQueueEntry(entry: HostQueueEntry): boolean {
  return entry.origin === 'agent'
}

/**
 * What the App knows about a session when it asks the host for the queue. The daemon resolves it to
 * the projection key; the App never has to know that key.
 */
export interface HostQueueRequest {
  sessionId: string
  providerId?: string
  agentProfileId?: string | null
  cwd?: string
}
