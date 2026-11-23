import type { SubscribeView } from '../../shared/orchestration-subscribe'
import type { OrchestrationEventRow } from './types'

// Which orchestration events a subscribe view receives (`P4-orchestration-protocol.md` §5.2).
const SESSION_VIEW_EVENTS = new Set([
  'session.created',
  'session.renamed',
  'session.pinned',
  'session.unpinned',
  'session.archived',
  'session.restored',
  'session.deleted',
  'session.withdrawn',
  'session.forked',
  'session.discovered',
  'session.imported',
  'turn.began',
  'turn.delivery',
  'run.intent_recorded',
  'run.settled',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.question_opened',
  'run.question_closed'
])

export function matchesViews(event: OrchestrationEventRow, views: ReadonlySet<SubscribeView>, detailSessionKey?: string): boolean {
  if (views.has('activeRuns') && event.type.startsWith('run.')) return true
  if (views.has('sessions') && SESSION_VIEW_EVENTS.has(event.type)) return true
  if (views.has('detail') && detailSessionKey && event.sessionKey === detailSessionKey) return true
  return false
}
