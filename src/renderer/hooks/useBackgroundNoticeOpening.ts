import type { ComponentProps } from 'react'
import type { ConversationSummary } from '@shared/conversation-api'
import type { ProjectMeta } from '../env'
import type { Sidebar } from '../components/Sidebar'
import type { BackgroundNotice } from '../background-notices'
import { useBackgroundNotices } from './useBackgroundNotices'
import { useEventCallback } from './useEventCallback'

/**
 * Background notices plus the action that opens the session or conversation one names.
 * Opening dismisses the notice first. The open handler keeps a stable identity so the
 * memoized Sidebar does not re-render for the callback alone.
 */
export function useBackgroundNoticeOpening({ unreadSessionKeys, unreadRevision, projects, runningRunIds, waitingQuestionRunIds, pickConversation, pickSession }: {
  unreadSessionKeys: ReadonlySet<string>
  unreadRevision: number
  projects: readonly ProjectMeta[]
  runningRunIds: ReadonlySet<string>
  waitingQuestionRunIds: ReadonlySet<string>
  pickConversation: (conversation: ConversationSummary) => void
  pickSession: ComponentProps<typeof Sidebar>['onPick']
}): { notices: BackgroundNotice[]; dismiss: (key: string) => void; open: (notice: BackgroundNotice) => void } {
  const { notices, dismiss } = useBackgroundNotices({ unreadSessionKeys, unreadRevision, projects, runningRunIds, waitingQuestionRunIds })
  const open = useEventCallback((notice: BackgroundNotice): void => {
    dismiss(notice.key)
    if (notice.target.kind === 'conversation') { pickConversation(notice.target.conversation); return }
    const { cwd: sessionCwd, session: noticeSession } = notice.target
    pickSession(sessionCwd, noticeSession.sessionId, noticeSession.providerId, noticeSession.externalSessionId,
      noticeSession.runId && runningRunIds.has(noticeSession.runId) ? noticeSession.runId : undefined,
      noticeSession.agentProfileId, noticeSession.preview, noticeSession.runId)
  })
  return { notices, dismiss, open }
}
