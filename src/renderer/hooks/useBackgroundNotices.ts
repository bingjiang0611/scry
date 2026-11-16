import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../env'
import { pushNotices, trackUnread, type BackgroundNotice, type NoticeTracker } from '../background-notices'

/**
 * Turns new unread marks into background notices. The first snapshot is the baseline: results
 * that were already unread when the window opened stay in the sidebar and make no notice.
 * A newly unread key whose catalog entry has not caught up yet (still running, not listed)
 * is retried as the catalog changes, for a bounded time. Reading a session removes its notice.
 */
export function useBackgroundNotices({ unreadSessionKeys, unreadRevision, projects, runningRunIds, waitingQuestionRunIds }: {
  unreadSessionKeys: ReadonlySet<string>
  /** -1 until main's first unread snapshot has arrived. */
  unreadRevision: number
  projects: readonly ProjectMeta[]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
}): { notices: BackgroundNotice[]; dismiss: (key: string) => void } {
  const [notices, setNotices] = useState<BackgroundNotice[]>([])
  const tracker = useRef<NoticeTracker>({ baseline: null, pending: new Map() })
  useEffect(() => {
    if (unreadRevision < 0) return
    const resolved = trackUnread(tracker.current, { unread: unreadSessionKeys, projects, runningRunIds, waitingQuestionRunIds, now: Date.now() })
    setNotices((current) => {
      const kept = current.filter((notice) => unreadSessionKeys.has(notice.key))
      if (resolved.length === 0) return kept.length === current.length ? current : kept
      return pushNotices(kept, resolved)
    })
  }, [unreadRevision, unreadSessionKeys, projects, runningRunIds, waitingQuestionRunIds])
  const dismiss = useCallback((key: string): void => {
    setNotices((current) => current.filter((notice) => notice.key !== key))
  }, [])
  return { notices, dismiss }
}
