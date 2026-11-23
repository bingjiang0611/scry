import type { AgentSteerCapability, AgentSteerEvidence } from '@shared/runtime'
import type { TraceEvent } from '@shared/trace'

export type RendererSteerStatus = AgentSteerEvidence['status']

export type RendererSteerEvidence = AgentSteerEvidence & { eventId: string; runEnded?: boolean }

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

export function latestSteerEvidence(items: readonly TraceEvent[]): Map<string, RendererSteerEvidence> {
  const latest = new Map<string, RendererSteerEvidence>()
  for (const event of items) {
    if (!event.steer) continue
    latest.set(event.steer.messageId, { ...event.steer, eventId: event.id })
  }
  return latest
}

export function latestSteerEvidenceForTurns(turns: readonly { items: readonly TraceEvent[]; done?: boolean }[]): Map<string, RendererSteerEvidence> {
  const latest = new Map<string, RendererSteerEvidence>()
  for (const turn of turns) {
    for (const [messageId, evidence] of latestSteerEvidence(turn.items)) {
      latest.set(messageId, { ...evidence, runEnded: turn.done === true })
    }
  }
  return latest
}

export function steerStateForMessage(
  local: QueuedSteerState | undefined,
  evidence: AgentSteerEvidence | undefined
): QueuedSteerState | undefined {
  if (evidence?.status === 'accepted') return { status: 'accepted', providerTurnId: evidence.providerTurnId }
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

export function canDismissUnknownSteer(state: QueuedSteerState | undefined, evidence: RendererSteerEvidence | undefined): boolean {
  return state?.status === 'unknown' && evidence?.status === 'unknown' && evidence.runEnded === true
}

export function isSteerRemovalBlocked(state: QueuedSteerState | undefined, evidence?: RendererSteerEvidence): boolean {
  return isSteerDrainBlocked(state) && !canDismissUnknownSteer(state, evidence)
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
  if (!active.providerId || !activeSession || active.cwd == null) return false
  return request.providerId === active.providerId &&
    (request.agentProfileId ?? null) === (active.agentProfileId ?? null) &&
    (request.cwd ?? null) === active.cwd &&
    request.expectedExternalSessionId === activeSession
}
