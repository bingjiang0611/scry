import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentQuestionRequest } from '@shared/runtime'
import { ChatTranscriptTurns } from './chat-view/transcript'
import { Composer } from './chat-view/Composer'
import type { ChatViewProps, SessionChatViewProps } from './chat-view/types'
import { EmptyState, EmptyStateSlot } from './primitives/EmptyState'
import { EmptyStateArtwork } from './primitives/EmptyStateArtwork'
import { DelayedSkeletonRows } from './primitives/Skeleton'
import { REMOTE_SESSION_COPY } from '../constants/remote-copy'
import { UserMessage } from './ChatTurn'
import { WorktreeSetupCard } from './WorktreeSetupCard'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'
import { DelayedLoadingStatus } from './LoadingStatus'
import { HISTORY_WINDOW_COPY, LOADING_COPY, SESSION_EMPTY_COPY } from '../constants/copy'
import { useHistoryAutoload } from '../hooks/useHistoryAutoload'

const NO_PENDING_QUESTIONS: AgentQuestionRequest[] = []
const NO_TURNS: ChatViewProps['turns'] = []
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

export type { ChatViewProps } from './chat-view/types'
export { ChatTranscriptTurns } from './chat-view/transcript'
export { imageFilesFromClipboardData, filterSlashCommands, formatElapsedMs, composerPromptHistory, navigateComposerHistory, composerEnterConfirmsIme } from './chat-view/composer-utils'

export function SessionChatView({ draftStore, draftKey, ...props }: SessionChatViewProps) {
  const readInput = () => draftStore.getSnapshot().get(draftKey)?.input ?? ''
  const input = useSyncExternalStore(draftStore.subscribe, readInput, readInput)
  return <ChatView {...props} input={input} composerScopeKey={draftKey} />
}

export function ChatView(props: ChatViewProps) {
  const {
    turns,
    composerScopeKey,
    selectedId,
    scrollRef,
    cwd,
    workspaceRoots = cwd ? [cwd] : [],
    hasSelectedSession = false,
    sessionLoading = false,
    transcriptPending = false,
    sessionCacheVisible = false,
    sessionEvidenceGap = null,
    emptyState = null,
    busy,
    queuedPrompts,
    pendingQuestions = NO_PENDING_QUESTIONS,
    historyWindow = null,
    historyOlderLoading = false,
    onLoadOlderTurns,
    focusedTurnRunId = null,
    onTurnRef,
    onSelect,
    onOpenDiff,
    onForkTurn,
    forkableRunIds,
    onOpenFile,
    onAnswerQuestion,
    workspaceSetup = null,
    remoteHost
  } = props
  const remote = remoteHost != null
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? null
  const displayedTurns = !sessionLoading || sessionCacheVisible ? turns : NO_TURNS
  const hasPendingTurnForSetup = Boolean(workspaceSetup && displayedTurns.some(turn => turn.pendingStart))
  const ownerReady = !sessionLoading && !sessionCacheVisible
  const transcriptLoading = sessionLoading || (transcriptPending && displayedTurns.length === 0)
  const liveRunId = ownerReady && busy ? turns.find(turn => !turn.done && !turn.error)?.runId ?? null : null
  const lastLive = useRef<{ scope: string | undefined; runId: string | null }>({ scope: composerScopeKey, runId: null })
  const completedLiveRunId = ownerReady && lastLive.current.scope === composerScopeKey ? lastLive.current.runId : null
  const liveArrivalResetKey = useMemo(() => ({ scope: composerScopeKey, ready: ownerReady }), [composerScopeKey, ownerReady])
  useBrowserLayoutEffect(() => {
    if (!ownerReady || lastLive.current.scope !== composerScopeKey) lastLive.current = { scope: composerScopeKey, runId: liveRunId }
    else if (liveRunId) lastLive.current.runId = liveRunId
  }, [ownerReady, composerScopeKey, liveRunId])
  useHistoryAutoload({
    scrollRef,
    turnsLength: displayedTurns.length,
    hasOlder: historyWindow?.hasOlder ?? false,
    loading: historyOlderLoading,
    onLoadOlder: onLoadOlderTurns
  })
  const transcriptEmpty = turns.length !== 0 || workspaceSetup != null || historyWindow?.hasOlder ? null
    : sessionEvidenceGap?.status === 'error' && (!transcriptLoading || sessionEvidenceGap.retrying)
      ? <EmptyState size="page" status="error" picture="alert" title={sessionEvidenceGap.title ?? SESSION_EMPTY_COPY.readFailed}
          description={sessionEvidenceGap.title ? sessionEvidenceGap.detail : SESSION_EMPTY_COPY.readFailedDetail} announcement="alert"
          actions={sessionEvidenceGap.retry ? [{ label: REMOTE_SESSION_COPY.readHistoryAgain, onClick: sessionEvidenceGap.retry,
            intent: 'secondary', busy: sessionEvidenceGap.retrying, icon: 'refresh' }] : undefined} />
      : transcriptLoading ? null
        : sessionEvidenceGap && sessionEvidenceGap.status !== 'error'
          ? <EmptyState size="page" status={sessionEvidenceGap.status} picture="message"
              title={sessionEvidenceGap.status === 'empty' ? SESSION_EMPTY_COPY.archiveEmpty : SESSION_EMPTY_COPY.readUnavailable}
              description={sessionEvidenceGap.status === 'unavailable' ? SESSION_EMPTY_COPY.readUnavailableDetail : undefined} />
          : hasSelectedSession
            ? emptyState
              ? <EmptyState size={emptyState.status === 'pending-first-send' ? 'page' : 'card'} status={emptyState.status ?? 'new-side-chat'}
                  picture="message" title={emptyState.status === 'pending-first-send' ? emptyState.title : SESSION_EMPTY_COPY.sideChat}
                  description={emptyState.status === 'pending-first-send' ? emptyState.detail : undefined} />
              : <EmptyState size="page" status="pending-evidence" picture="message" title={SESSION_EMPTY_COPY.waiting}
                  description={SESSION_EMPTY_COPY.waitingDetail(remoteHost)} />
            : <EmptyState size="page" className={`unbound-empty${cwd ? ' bound' : ''}`} title={SESSION_EMPTY_COPY.firstTitle}
                description={workspaceName ? SESSION_EMPTY_COPY.firstBoundDetail(workspaceName) : SESSION_EMPTY_COPY.firstDetail}
                picture={<EmptyStateArtwork scene="conversation" />} />
  return (
    <>
      <WorkspaceFileLinkProvider workspaces={workspaceRoots} onOpen={onOpenFile}>
        <div className="body chat-body" data-screen-label="对话 · 真实 Turn transcript">
          <div className="chat chat-transcript" ref={scrollRef} tabIndex={-1} aria-label="执行时间线" aria-busy={transcriptLoading && !sessionCacheVisible} data-history-autoload="scroll" data-history-source={sessionCacheVisible ? 'preview' : 'authoritative'}>
            <EmptyStateSlot empty={transcriptEmpty} className="chat-state-slot">
            {!sessionLoading && historyWindow?.hasOlder && (
              <div className="history-window-note" role="note" aria-label={HISTORY_WINDOW_COPY.rangeLabel} aria-busy={historyOlderLoading}>
                <span className="history-window-range">
                  {remote
                    ? HISTORY_WINDOW_COPY.rangeRemote(turns.length, remoteHost ?? '')
                    : HISTORY_WINDOW_COPY.rangeLocal(historyWindow.totalTurns - historyWindow.offset, historyWindow.totalTurns)}
                </span>
                <button type="button" className="history-window-more" onClick={() => onLoadOlderTurns?.()} disabled={historyOlderLoading || !onLoadOlderTurns}>{historyOlderLoading ? HISTORY_WINDOW_COPY.loadingShort : HISTORY_WINDOW_COPY.loadOlder}</button>
              </div>
            )}
            {!sessionLoading && historyWindow?.pagedOlder && !historyWindow.hasOlder && turns.length > 0 && (
              <p className="history-window-start" role="note">{HISTORY_WINDOW_COPY.exhausted(historyWindow.totalTurns)}</p>
            )}
            {(transcriptLoading || sessionCacheVisible) && (
              sessionCacheVisible
                ? <DelayedLoadingStatus loading className="is-quiet" title={LOADING_COPY.sessionHistoryVerifying} detail={LOADING_COPY.sessionHistoryVerifyingDetail} />
                : !sessionEvidenceGap?.retrying && <DelayedSkeletonRows loading rows={4} label={LOADING_COPY.sessionHistory} />
            )}
            <div className="chat-transcript-content">
              <ChatTranscriptTurns turns={displayedTurns} selectedId={selectedId} focusedTurnRunId={focusedTurnRunId} onTurnRef={onTurnRef} onSelect={onSelect} onOpenDiff={onOpenDiff} forkableRunIds={forkableRunIds} onForkTurn={!sessionLoading && !busy && queuedPrompts.length === 0 && pendingQuestions.length === 0 ? onForkTurn : undefined} pendingQuestions={pendingQuestions} onAnswerQuestion={onAnswerQuestion} remote={remote}
                liveRunId={liveRunId} completedLiveRunId={completedLiveRunId} liveArrivalResetKey={liveArrivalResetKey} workspaceSetup={workspaceSetup} />
              {workspaceSetup && !hasPendingTurnForSetup && (
                <div className="turn transcript-turn worktree-setup-turn" role="article">
                  {(workspaceSetup.prompt || (workspaceSetup.attachments && workspaceSetup.attachments.length > 0)) && (
                    <UserMessage text={workspaceSetup.prompt ?? ''} attachments={workspaceSetup.attachments} />
                  )}
                  <WorktreeSetupCard
                    progress={workspaceSetup.progress}
                    cancelling={workspaceSetup.cancelling}
                    onCancel={workspaceSetup.onCancel}
                  />
                </div>
              )}
            </div>
            </EmptyStateSlot>
          </div>
        </div>
      </WorkspaceFileLinkProvider>
      <Composer {...props} pendingQuestions={pendingQuestions} />
    </>
  )
}
