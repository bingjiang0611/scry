import { createHash } from 'node:crypto'
import type { Conversation } from '../shared/conversation'
import type { ConversationDeletionPreview, ConversationDeletionTarget } from '../shared/conversation-api'
import type { AppSession } from './app-store'

// Archive/SQLite storage is scoped by provider/cwd/session, not profile. A
// reference from another profile must therefore retain the physical evidence.
function footprint(conversation: Conversation, bindingId: string): Set<string> {
  const binding = conversation.bindings.find(item => item.id === bindingId)!
  return new Set([
    ...(binding.nativeSessionId ? [binding.nativeSessionId] : []),
    ...conversation.turns.filter(turn => turn.bindingId === bindingId)
      .flatMap(turn => [turn.runId, ...(turn.archive ? [turn.archive.sessionId] : [])])
  ])
}

export function planConversationDeletion(conversation: Conversation, others: Conversation[], catalog: AppSession[] = []): ConversationDeletionPreview {
  if (!conversation.archivedAt) throw new Error('请先存档统一对话，再预览删除')
  if (conversation.turns.some(turn => turn.origin === 'dispatch' && (turn.delivery.status === 'pending' || turn.delivery.status === 'unknown'))) {
    throw new Error('投递仍未收敛，不能删除其归属和恢复证据')
  }
  for (const other of others) {
    if (other.id === conversation.id || other.cwd !== conversation.cwd || other.deletion?.status === 'complete') continue
    if (other.turns.some(turn => {
      if (turn.origin !== 'dispatch') return false
      const binding = other.bindings.find(binding => binding.id === turn.bindingId)!
      return conversation.bindings.some(target => target.providerId === binding.providerId) &&
        (turn.delivery.status === 'unknown' || (turn.delivery.status === 'pending' && !binding.nativeSessionId))
    })) throw new Error('同一 Provider 的物理存储仍有未确认投递，不能证明删除范围安全')
  }
  const targets = new Map<string, ConversationDeletionTarget>()
  for (const binding of conversation.bindings) {
    const aliases = footprint(conversation, binding.id)
    const sharedWith = others.filter(other => other.id !== conversation.id && other.cwd === conversation.cwd && other.deletion?.status !== 'complete' &&
      other.bindings.some(candidate => candidate.providerId === binding.providerId && [...footprint(other, candidate.id)].some(id => aliases.has(id))))
      .map(other => other.id)
    for (const session of catalog) {
      if (session.cwd === conversation.cwd && session.providerId === binding.providerId && session.agentProfileId !== binding.agentProfileId &&
        (aliases.has(session.externalSessionId ?? session.sessionId) || aliases.has(session.sessionId))) {
        sharedWith.push(`profile:${session.agentProfileId ?? 'default'}`)
      }
    }
    const turns = conversation.turns.filter(turn => turn.bindingId === binding.id)
    // Native scope first: it resolves DB ownership before provisional/archive
    // aliases are removed. Alias passes do not claim runs owned by another ID.
    const ids = new Set([
      ...(binding.nativeSessionId ? [binding.nativeSessionId] : []),
      ...turns.flatMap(turn => [turn.archive?.sessionId ?? turn.runId])
    ])
    for (const externalSessionId of ids) {
      const key = JSON.stringify([binding.providerId, binding.agentProfileId ?? null, externalSessionId])
      const previous = targets.get(key)
      const runIds = binding.nativeSessionId === externalSessionId ? turns.map(turn => turn.runId) :
        !binding.nativeSessionId ? turns.filter(turn => (turn.archive?.sessionId ?? turn.runId) === externalSessionId).map(turn => turn.runId) : []
      targets.set(key, { providerId: binding.providerId, agentProfileId: binding.agentProfileId, externalSessionId,
        runIds: [...new Set([...(previous?.runIds ?? []), ...runIds])],
        sharedWith: [...new Set([...(previous?.sharedWith ?? []), ...sharedWith])].sort() })
    }
  }
  const sharedWith = [...new Set([...targets.values()].flatMap(target => target.sharedWith))].sort()
  // Until deletion has per-run reference accounting, retain the whole native
  // evidence group when any part is shared. The preview makes this explicit.
  if (sharedWith.length) for (const target of targets.values()) target.sharedWith = sharedWith
  const plan = { conversationId: conversation.id, revision: conversation.revision, targets: [...targets.values()] }
  return { ...plan, fingerprint: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
}

/** Route IDs using SQLite's authoritative session scope, not the display/native alias. */
export function resolveConversationDeletionRuns(preview: ConversationDeletionPreview, resolve: (target: ConversationDeletionTarget) => {
  status: 'ready' | 'not_present' | 'unavailable'
  runIds: string[]
  conflicts: string[]
  error?: string
}, others: Conversation[] = [], catalog: AppSession[] = []): ConversationDeletionPreview {
  const owners = new Map<string, number>()
  const targets = preview.targets.map((target, index) => {
    if (target.sharedWith.length) return { ...target, runIds: [...target.runIds] }
    const resolved = resolve(target)
    if (resolved.status === 'unavailable' || resolved.conflicts.length) throw new Error(`无法核对删除 runId 归属：${resolved.error ?? resolved.conflicts.join(', ')}`)
    for (const runId of resolved.runIds) {
      if (owners.has(runId)) throw new Error('同一 runId 存在多个物理归属，拒绝删除')
      owners.set(runId, index)
    }
    return { ...target, runIds: [...resolved.runIds] }
  })
  preview.targets.forEach((target, index) => {
    for (const runId of target.runIds) {
      const owner = owners.get(runId) ?? index
      if (!targets[owner].runIds.includes(runId)) targets[owner].runIds.push(runId)
    }
  })
  const shared = new Set(targets.flatMap(target => target.sharedWith))
  for (const target of targets) {
    target.runIds.sort()
    for (const other of others) {
      if (other.id !== preview.conversationId && other.deletion?.status !== 'complete' && other.turns.some(turn => target.runIds.includes(turn.runId) &&
        other.bindings.some(binding => binding.id === turn.bindingId && binding.providerId === target.providerId))) shared.add(other.id)
    }
    for (const session of catalog) {
      if (session.providerId === target.providerId && session.agentProfileId !== target.agentProfileId && session.runId && target.runIds.includes(session.runId)) shared.add(`profile:${session.agentProfileId ?? 'default'}`)
    }
  }
  if (shared.size) for (const target of targets) target.sharedWith = [...shared].sort()
  const plan = { conversationId: preview.conversationId, revision: preview.revision, targets }
  return { ...plan, fingerprint: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
}
