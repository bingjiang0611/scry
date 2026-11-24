import type { ConversationSummary } from '@shared/conversation-api'
import { conversationAttentionKey, sessionAttentionKey } from '@shared/session-attention'
import type { ProjectMeta, SessionMeta } from './env'
import { activityGroupOf } from './sidebar-activity'

/**
 * Background notices: a short note in the sidebar when a session the user is not looking
 * at newly needs a reply, fails, or finishes. The source is main's unread marking; the
 * notice only restates the sidebar's activity grouping and adds no evidence of its own.
 * History lives in the sidebar's activity view, which keeps every unread result.
 */
export type BackgroundNoticeKind = 'attention' | 'failed' | 'interrupted' | 'cancelled' | 'completed' | 'updated'

export type BackgroundNoticeTarget =
  | { kind: 'session'; cwd: string; session: SessionMeta }
  | { kind: 'conversation'; conversation: ConversationSummary }

export interface BackgroundNotice {
  /** The session's attention key; one notice per session. */
  key: string
  kind: BackgroundNoticeKind
  title: string
  projectName: string
  target: BackgroundNoticeTarget
}

/** Visible at once; a newer notice pushes out the oldest. */
export const MAX_VISIBLE_NOTICES = 3
/** Time an informational notice stays while the window is focused and not hovered. */
export const NOTICE_DURATION_MS = 10_000
/** How long an unread key may wait for its session's catalog entry to catch up. */
export const NOTICE_RESOLVE_WINDOW_MS = 30_000

/** Needs-a-reply, failed and interrupted results wait for the user; the rest leave after a while. */
export function isStickyNotice(kind: BackgroundNoticeKind): boolean {
  return kind === 'attention' || kind === 'failed' || kind === 'interrupted'
}

type Outcome = SessionMeta['lastRunOutcome']

/**
 * The notice for an unread session, using the sidebar's own grouping so the two never
 * disagree. A run that is still active has nothing to report yet; an unread result with
 * no recorded outcome is "new result", never "completed".
 */
export function noticeKind(evidence: { active: boolean; blocked: boolean; outcome?: Outcome }): BackgroundNoticeKind | undefined {
  const group = activityGroupOf({ ...evidence, unread: true })
  if (group === 'attention') return 'attention'
  if (group === 'completed') return 'completed'
  if (group !== 'updates') return undefined
  const { outcome } = evidence
  return outcome === 'failed' || outcome === 'cancelled' || outcome === 'interrupted' ? outcome : 'updated'
}

export function addedKeys(previous: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
  return [...next].filter((key) => !previous.has(key))
}

/**
 * Finds the local conversation or session an unread key belongs to. Side chats, archived
 * entries and remote sessions have no notice: they are not rows the user can open from here.
 */
export function resolveNotice(
  key: string,
  projects: readonly ProjectMeta[],
  runningRunIds: ReadonlySet<string>,
  waitingQuestionRunIds: ReadonlySet<string>
): BackgroundNotice | undefined {
  const waiting = (runId?: string): boolean => Boolean(runId && waitingQuestionRunIds.has(runId))
  for (const project of projects) {
    for (const conversation of project.conversations ?? []) {
      if (conversation.sideChat || conversation.archivedAt || conversationAttentionKey(conversation.id) !== key) continue
      const active = Boolean(conversation.activeRunId)
      // Same blocking rule as the sidebar's conversation rows.
      const blocked = waiting(conversation.activeRunId) || Boolean(conversation.deletion) ||
        (conversation.fork !== undefined && conversation.fork.status !== 'accepted') ||
        (!active && conversation.blockedReason !== undefined)
      const kind = noticeKind({ active, blocked, outcome: conversation.lastRunOutcome })
      return kind && { key, kind, title: conversation.title, projectName: project.name, target: { kind: 'conversation', conversation } }
    }
    for (const session of project.sessions) {
      if (session.archivedAt) continue
      const cwd = session.cwd ?? project.cwd
      const sessionKey = sessionAttentionKey({ providerId: session.providerId, agentProfileId: session.agentProfileId, cwd,
        sessionId: session.externalSessionId ?? session.sessionId })
      if (sessionKey !== key) continue
      const kind = noticeKind({ active: Boolean(session.runId && runningRunIds.has(session.runId)), blocked: waiting(session.runId),
        outcome: session.lastRunOutcome })
      return kind && { key, kind, title: session.preview, projectName: project.name, target: { kind: 'session', cwd, session } }
    }
  }
  return undefined
}

/** Newest first, one per session, at most MAX_VISIBLE_NOTICES. */
export function pushNotices(current: readonly BackgroundNotice[], added: readonly BackgroundNotice[]): BackgroundNotice[] {
  const keys = new Set(added.map((notice) => notice.key))
  return [...added].reverse().concat(current.filter((notice) => !keys.has(notice.key))).slice(0, MAX_VISIBLE_NOTICES)
}

export interface NoticeTracker {
  /** The unread set last seen; null until the first snapshot, which is only a baseline. */
  baseline: ReadonlySet<string> | null
  /** Newly unread keys whose catalog entry has not caught up yet, with the time first seen. */
  pending: Map<string, number>
}

/**
 * Advances the tracker with the current unread set and catalog and returns the notices that
 * became resolvable. Results already unread at the first snapshot make no notice; a newly
 * unread key is retried while the catalog catches up, for at most NOTICE_RESOLVE_WINDOW_MS,
 * and dropped once the session is read.
 */
export function trackUnread(tracker: NoticeTracker, input: {
  unread: ReadonlySet<string>
  projects: readonly ProjectMeta[]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  now: number
}): BackgroundNotice[] {
  const previous = tracker.baseline
  tracker.baseline = input.unread
  if (previous) for (const key of addedKeys(previous, input.unread)) tracker.pending.set(key, input.now)
  const resolved: BackgroundNotice[] = []
  for (const [key, since] of tracker.pending) {
    if (!input.unread.has(key) || input.now - since > NOTICE_RESOLVE_WINDOW_MS) { tracker.pending.delete(key); continue }
    const notice = resolveNotice(key, input.projects, input.runningRunIds, input.waitingQuestionRunIds)
    if (!notice) continue
    tracker.pending.delete(key)
    resolved.push(notice)
  }
  return resolved
}
