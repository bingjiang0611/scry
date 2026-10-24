import { useSyncExternalStore } from 'react'
import type { AgentQuestionRequest } from '@shared/runtime'
import { ChatTranscriptTurns } from './chat-view/transcript'
import { Composer } from './chat-view/Composer'
import type { ChatViewProps, SessionChatViewProps } from './chat-view/types'
import { Icon } from './primitives/Icon'
import { WorkspaceFileLinkProvider } from './MarkdownImpl'

const NO_PENDING_QUESTIONS: AgentQuestionRequest[] = []

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
    selectedId,
    scrollRef,
    cwd,
    workspaceRoots = cwd ? [cwd] : [],
    hasSelectedSession = false,
    sessionLoading = false,
    sessionCacheVisible = false,
    sessionEvidenceGap = null,
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
    remoteHost
  } = props
  const remote = remoteHost != null
  const workspaceName = cwd?.split('/').filter(Boolean).at(-1) ?? null
  return (
    <>
      <WorkspaceFileLinkProvider workspaces={workspaceRoots} onOpen={onOpenFile}>
        <div className="body chat-body" data-screen-label="对话 · 真实 Turn transcript">
          <div className="chat chat-transcript" ref={scrollRef} aria-label="执行时间线" aria-busy={sessionLoading}>
            {sessionLoading && hasSelectedSession && (
              <div className="chat-session-evidence-gap" role="status" data-status="loading">
                <b>{sessionCacheVisible ? '正在更新最近会话缓存' : '正在加载会话历史'}</b>
                <span>{sessionCacheVisible ? '先展示上次读取的最近一页；核对完成前不能发送或分叉。' : remote ? `正在读取 ${remoteHost} 的归档，请稍候。` : '正在读取本机归档，请稍候。'}</span>
              </div>
            )}
            {turns.length === 0 && !sessionLoading && sessionEvidenceGap && (
              <div className="chat-session-evidence-gap" role="status" data-status={sessionEvidenceGap.status}>
                <b>{sessionEvidenceGap.status === 'error' ? '会话历史加载失败' : sessionEvidenceGap.status === 'unavailable' ? (remote ? `这条会话没有可读的 ${remoteHost} 证据` : '这条会话没有可读的本机证据') : '这条会话的归档里没有轮次'}</b>
                <span>{sessionEvidenceGap.detail}</span>
                <span>{sessionEvidenceGap.status === 'error' ? '这不代表历史为空。请重新点击侧边栏中的会话加载。' : '会话仍在列表里；Provider 侧可能还有历史，但 Scry 没有可校验的归档可展示。'}</span>
              </div>
            )}
            {turns.length === 0 && !sessionLoading && !sessionEvidenceGap && hasSelectedSession && (
              <div className="chat-session-evidence-gap" role="status" data-status="empty">
                <b>这条会话暂时没有可显示的轮次</b>
                <span>{remote ? `会话已选中；正在等待 ${remoteHost} 的归档或运行事件，不会将它当作新会话。` : '会话已选中；正在等待本机归档或运行事件，不会将它当作新会话。'}</span>
              </div>
            )}
            {turns.length === 0 && !sessionLoading && !sessionEvidenceGap && !hasSelectedSession && (
              <div className={`unbound-empty welcome-field ${cwd ? 'bound' : ''}`}>
                <header className="welcome-heading welcome-heading-minimal"><span className="welcome-hero-icon" aria-hidden="true"><Icon name="terminal" /></span><h1>{workspaceName ? <>今天想在 <span>{workspaceName}</span> 中构建什么？</> : '今天想构建什么？'}</h1></header>
              </div>
            )}
            {!sessionLoading && historyWindow?.hasOlder && (
              <div className="history-window-note" role="note" aria-label="历史轮次范围">
                {remote ? <span>时间线已加载最近 <b>{turns.length}</b> 轮·更早轮次仍在 {remoteHost} 的归档中，未丢弃</span> : <span>时间线已加载最近 <b>{historyWindow.totalTurns - historyWindow.offset}</b> / {historyWindow.totalTurns} 轮·更早轮次仍在本机归档中，未丢弃</span>}
                <button type="button" className="history-window-more" onClick={() => onLoadOlderTurns?.()} disabled={historyOlderLoading || !onLoadOlderTurns}>{historyOlderLoading ? '加载中…' : '加载更早轮次'}</button>
              </div>
            )}
            {(!sessionLoading || sessionCacheVisible) && <ChatTranscriptTurns turns={turns} selectedId={selectedId} focusedTurnRunId={focusedTurnRunId} onTurnRef={onTurnRef} onSelect={onSelect} onOpenDiff={onOpenDiff} forkableRunIds={forkableRunIds} onForkTurn={!sessionLoading && !busy && queuedPrompts.length === 0 && pendingQuestions.length === 0 ? onForkTurn : undefined} pendingQuestions={pendingQuestions} onAnswerQuestion={onAnswerQuestion} remote={remote} />}
          </div>
        </div>
      </WorkspaceFileLinkProvider>
      <Composer {...props} pendingQuestions={pendingQuestions} />
    </>
  )
}
