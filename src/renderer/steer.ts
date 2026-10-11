import type { AgentSteerCapability, AgentSteerEvidence } from '@shared/runtime'
import type { TraceEvent } from '@shared/trace'

export type RendererSteerStatus = AgentSteerEvidence['status']

export interface QueuedSteerState {
  status: RendererSteerStatus
  message?: string
  providerTurnId?: string
}

export function newSteerMessageId(): string {
  return crypto.randomUUID()
}

export function latestSteerCapability(items: readonly TraceEvent[]): AgentSteerCapability | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const capability = items[index].steerCapability
    if (capability) return capability
  }
  return undefined
}

export function latestSteerEvidence(items: readonly TraceEvent[]): Map<string, AgentSteerEvidence & { eventId: string }> {
  const latest = new Map<string, AgentSteerEvidence & { eventId: string }>()
  for (const event of items) {
    if (!event.steer) continue
    latest.set(event.steer.messageId, { ...event.steer, eventId: event.id })
  }
  return latest
}

export function latestSteerEvidenceForTurns(turns: readonly { items: readonly TraceEvent[] }[]): Map<string, AgentSteerEvidence & { eventId: string }> {
  const latest = new Map<string, AgentSteerEvidence & { eventId: string }>()
  for (const turn of turns) {
    for (const [messageId, evidence] of latestSteerEvidence(turn.items)) latest.set(messageId, evidence)
  }
  return latest
}

export function steerStateForMessage(
  local: QueuedSteerState | undefined,
  evidence: AgentSteerEvidence | undefined
): QueuedSteerState | undefined {
  // Authoritative native admission can reconcile a lost IPC response. It may only
  // remove the item, never make it eligible for another ordinary/Steer dispatch.
  if (evidence?.status === 'accepted') return { status: 'accepted', providerTurnId: evidence.providerTurnId }
  // In particular an old rejected trace cannot overwrite a new pending retry.
  if (local?.status === 'pending' || local?.status === 'unknown') return local
  if (local) return local
  if (evidence) return {
    status: evidence.status,
    ...(evidence.message ? { message: evidence.message } : {}),
    ...(evidence.providerTurnId ? { providerTurnId: evidence.providerTurnId } : {})
  }
  return local
}

export function isSteerDrainBlocked(state: QueuedSteerState | undefined): boolean {
  return state?.status === 'pending' || state?.status === 'unknown' || state?.status === 'accepted'
}

export function isSteerRemovalBlocked(state: QueuedSteerState | undefined): boolean {
  return isSteerDrainBlocked(state)
}

export function retainProtectedSteerPrompts<T extends { messageId: string; steer?: QueuedSteerState }>(
  queue: readonly T[],
  evidence: ReadonlyMap<string, AgentSteerEvidence>,
  inFlightIds: ReadonlySet<string>
): T[] {
  return queue.filter(prompt => inFlightIds.has(prompt.messageId) ||
    isSteerRemovalBlocked(steerStateForMessage(prompt.steer, evidence.get(prompt.messageId))))
}

export function removeQueuedPromptByMessageId<T extends { messageId: string }>(queue: readonly T[], messageId: string): T[] {
  const index = queue.findIndex((prompt) => prompt.messageId === messageId)
  if (index < 0) return [...queue]
  return [...queue.slice(0, index), ...queue.slice(index + 1)]
}

export function updateQueuedPromptByMessageId<T extends { messageId: string }>(
  queues: ReadonlyMap<string, readonly T[]>,
  messageId: string,
  update: (prompt: T) => T | null
): ReadonlyMap<string, T[]> {
  let changed = false
  const next = new Map<string, T[]>()
  for (const [key, queue] of queues) {
    const updated = queue.flatMap((prompt) => {
      if (prompt.messageId !== messageId) return [prompt]
      const replacement = update(prompt)
      if (replacement === prompt) return [prompt]
      changed = true
      return replacement ? [replacement] : []
    })
    if (updated.length > 0) next.set(key, updated)
  }
  return changed ? next : queues as ReadonlyMap<string, T[]>
}

export function activeSteerIdentityMatches(input: {
  request: { providerId: string; agentProfileId?: string; cwd?: string; expectedExternalSessionId: string }
  active: { providerId?: string; agentProfileId?: string; cwd?: string; externalSessionId?: string; sessionId?: string }
}): boolean {
  const { request, active } = input
  const activeSession = active.externalSessionId ?? active.sessionId
  // A missing identity is not proof that this is the same run. Refuse admission
  // instead of guessing from the currently selected Provider or workspace.
  if (!active.providerId || !activeSession || active.cwd == null) return false
  return request.providerId === active.providerId &&
    (request.agentProfileId ?? null) === (active.agentProfileId ?? null) &&
    (request.cwd ?? null) === active.cwd &&
    request.expectedExternalSessionId === activeSession
}
