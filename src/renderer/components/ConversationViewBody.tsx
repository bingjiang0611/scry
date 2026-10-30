import { type Dispatch, type MutableRefObject, type SetStateAction, useState } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { ConversationForkRequest, ConversationMetadataChange, ConversationPage, ConversationSummary } from '@shared/conversation-api'
import type { ComposerDraft, ComposerDraftStore, ComposerPendingSubmission } from '../composer-drafts'
import { pendingRecovery, type PendingResolution } from '../composer-pending'
import { CONVERSATION_COPY } from '../constants/conversation-copy'
import { SIDE_CHAT_COPY } from '../constants/side-chat-copy'
import type { Turn } from '../format'
import type { TraceLiveHealth } from '../hooks/useAgentSession-helpers'
import type { ConversationHostChatProps } from '../conversation-chat-props'
import { SessionChatView } from './ChatView'
import { ConversationDeleteDialog } from './ConversationDeleteDialog'
import { PendingSubmissionDialog } from './PendingSubmissionDialog'
import { SessionRenameDialog } from './SessionRename'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function ConversationViewBody({
  conversation, embedded, draftKey, page, before, input, missing, working, managing, pending, pendingHealth, onCheckPending, onResendPending, forkAttempt, renaming, deleting, activeRunId, inherited, firstHandoff, limitation, drafts, live, forkableRunIds, forkUnsupported, error, notice, refreshButton, chatProps, setError, setNotice, setBefore, showLatest, updateMetadata, setRenaming, setDeleting, send, fork, refresh, onOpenConversation, mounted, changedRef, setReload, draftStore, turns, blockedReason, setInput, addPastedImages, addClipboardImage, removeDraftAttachment, liveHealth
}: {
  conversation: ConversationSummary; embedded?: boolean; draftKey: string; page?: ConversationPage; before?: number; input: string
  missing: ConversationPage['turns']; working: boolean; managing: boolean
  pending?: ComposerPendingSubmission; pendingHealth?: PendingResolution
  onCheckPending: () => void; onResendPending: () => void
  forkAttempt?: ConversationForkRequest; renaming: boolean; deleting: boolean
  activeRunId?: string; inherited?: boolean; firstHandoff?: boolean; limitation: string
  drafts: ReadonlyMap<string, ComposerDraft>; draftStore: ComposerDraftStore; turns: Turn[]; blockedReason: string | null; setInput: (value: string) => void; live?: ActiveRun; forkableRunIds: ReadonlySet<string>
  addPastedImages: (files: File[]) => Promise<void>; addClipboardImage: () => Promise<void>; removeDraftAttachment: (id: string) => void
  /** Side chats have no native fork; the action is hidden instead of failing on click. */
  forkUnsupported: boolean
  error?: string; notice?: string; refreshButton: MutableRefObject<HTMLButtonElement | null>
  chatProps: ConversationHostChatProps; setError: Dispatch<SetStateAction<string | undefined>>
  setNotice: Dispatch<SetStateAction<string | undefined>>; setBefore: Dispatch<SetStateAction<number | undefined>>
  showLatest: () => void; updateMetadata: (change: ConversationMetadataChange) => Promise<void>; setRenaming: (value: boolean) => void; setDeleting: (value: boolean) => void
  send: () => Promise<void>
  fork: (turn?: Turn, original?: ConversationForkRequest) => Promise<void>; refresh: () => Promise<ConversationPage | undefined>; onOpenConversation: (conversation: ConversationSummary) => void
  setReload: Dispatch<SetStateAction<number>>; mounted: MutableRefObject<boolean>; changedRef: MutableRefObject<() => void>
  /** 这个 run 自己的 live 流健康度：降级/缺口必须显示，不能把截断当完整。 */
  liveHealth?: TraceLiveHealth
}) {
  // Recovery copy comes from the durable receipt, never from a local guess.
  const recoveryState = pending ? pendingRecovery(pending, pendingHealth) : undefined
  const [inspectingPending, setInspectingPending] = useState(false)
  const recovery = recoveryState ? {
    state: recoveryState.state,
    explanation: recoveryState.state === 'not_sent' ? SIDE_CHAT_COPY.pendingStates.notSent
      : `${SIDE_CHAT_COPY.pendingStates.unresolved}${recoveryState.reason ? `（${recoveryState.reason}）` : ''}`
  } : undefined
  return <main className="unified-conversation conversation-chat" aria-label="对话" data-conversation-id={conversation.id}>
    <div className={embedded ? 'conversation-toolbar conversation-toolbar-embedded' : 'conversation-toolbar'}>
      {!embedded && <strong className="conversation-title" title={conversation.cwd}>{page?.summary.title ?? conversation.title}</strong>}
      <button ref={refreshButton} className="btn" onClick={() => { setError(undefined); setReload(value => value + 1) }}>刷新状态</button>
      <details className="conversation-options"><summary>对话选项</summary><div className="unified-management">
        <button className="btn" aria-label="重命名统一对话" disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => setRenaming(true)}>重命名</button>
        <button className="btn" aria-label={page?.summary.pinnedAt ? '取消置顶统一对话' : '置顶统一对话'} disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'pin', pinned: !page?.summary.pinnedAt }).catch(error => setError(message(error))) }}>{page?.summary.pinnedAt ? '取消置顶' : '置顶'}</button>
        <button className="btn" aria-label={page?.summary.archivedAt ? '恢复统一对话' : '存档统一对话'} disabled={!page || managing || working || Boolean((page?.summary.blockedReason && page.summary.fork?.status !== 'not_sent') || page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'archive', archived: !page?.summary.archivedAt }).catch(error => setError(message(error))) }}>{page?.summary.archivedAt ? '恢复' : '存档'}</button>
        {page?.summary.archivedAt && (page.summary.deletion?.status !== 'complete' || page.summary.deletion.retainedCopies) && <button className="btn" aria-label="删除统一对话" disabled={managing || working || Boolean(activeRunId)} onClick={() => setDeleting(true)}>{page.summary.deletion?.status === 'complete' ? '核对保留副本…' : page.summary.deletion ? '继续清理…' : '删除副本…'}</button>}
        <p>{limitation}</p>
        {forkUnsupported
          ? <p>{CONVERSATION_COPY.forkUnsupported}</p>
          : <p>从轮次创建原生分支不发送消息，也不回退文件。共享历史仅供查看；再次从这些轮次分支，请回到源对话。</p>}
        {inherited && <p>旧原生会话未记录可验证的接续身份。迁入保留已捕获的文字，不证明恢复了旧原生上下文。</p>}
      </div></details>
    </div>
    {(page?.nextBeforeOrdinal !== undefined || before !== undefined) && <nav className="unified-pagination" aria-label="历史分页">
      <button className="btn" disabled={page?.nextBeforeOrdinal === undefined} onClick={() => setBefore(page?.nextBeforeOrdinal)}>更早记录</button>
      <span>每页最多 40 轮</span><button className="btn" disabled={before === undefined} onClick={showLatest}>最近记录</button>
    </nav>}
    {missing.map(turn => <p className="conversation-history-notice" role="status" key={turn.runId}>第 {turn.ordinal} 轮：{turn.unavailableReason ?? '正在等待运行记录'}{turn.delivery.status === 'unknown' || turn.delivery.status === 'not_sent' ? `；${turn.delivery.reason}` : ''}</p>)}
    {page?.summary.deletion && <div className="conversation-history-notice" role="status">
      {page.summary.deletion.status === 'complete' ? page.summary.deletion.retainedCopies ? '逻辑对话已删除；上次保留的共享副本可重新核对' : '对话副本已删除' : '删除未完成'}，正文不可用。草稿仍保留。
      {input && <button className="btn" onClick={() => { void window.scry.copyText(input).then(() => setNotice('已复制保留的草稿。')).catch(error => setError(message(error))) }}>复制保留的草稿</button>}
      {page.summary.deletion.result && <details><summary>删除回执与保留范围</summary>
        <ul>{page.summary.deletion.result.retained.map(item => <li key={item}>{item}</li>)}</ul>
        {page.summary.deletion.result.failed.map((failure, index) => <p key={index}>{failure.store}: {failure.error}</p>)}
      </details>}
    </div>}
    {page?.summary.fork?.status === 'accepted' && !page.summary.deletion && <div className="conversation-history-notice" role="status">
      创建分支不会发送消息或回退文件。分支点之前的历史为共享只读副本。
      <button className="btn" disabled={working} onClick={() => {
        void window.scry.conversations.read(page.summary.fork!.sourceConversationId).then(source => {
          if (mounted.current) onOpenConversation(source.summary)
        }).catch(error => { if (mounted.current) setError(message(error)) })
      }}>打开源对话</button>
    </div>}
    <SessionChatView {...chatProps}
      draftStore={draftStore} draftKey={draftKey} turns={turns} cwd={conversation.cwd} workspaceRoots={[conversation.cwd]}
      agentLocked={!page || working || Boolean(pending || forkAttempt || blockedReason || activeRunId)} hasSelectedSession
      onInput={setInput} onSend={() => { void send() }} submitting={working} sessionLoading={!page} sessionCacheVisible={false} sessionEvidenceGap={null}
      busy={Boolean(activeRunId)} queueWhileBusy={false}
      sendBlockedReason={blockedReason ?? (forkAttempt ? '请先核对原分支请求' : pending ? SIDE_CHAT_COPY.pendingBlocksSend : chatProps.sendBlockedReason)} composerError={error ?? null}
      emptyState={conversation.sideChat
        ? pending
          // An unresolved first send is not a fresh, never-sent side chat: say so.
          ? { status: 'pending-first-send' as const, title: SIDE_CHAT_COPY.pendingFirstSendTitle,
            detail: SIDE_CHAT_COPY.pendingFirstSendDetail }
          : { status: 'new-side-chat' as const, title: SIDE_CHAT_COPY.emptyTitle, detail: SIDE_CHAT_COPY.emptyDetail }
        : null}
      onPasteImages={files => { void addPastedImages(files) }} onPasteClipboardImage={() => { void addClipboardImage() }}
      onRemoveDraftAttachment={removeDraftAttachment}
      composerNotice={blockedReason && !activeRunId ? { text: blockedReason, tone: 'blocked' } : notice ? { text: notice, tone: 'blocked' } : firstHandoff ? { text: '旧 Agent 的接续身份无法验证。文字历史已保留，将在新上下文继续。', tone: 'blocked' } : null}
      draftAttachments={drafts.get(draftKey)?.attachments ?? []} queuedPrompts={[]} steerCapability={null} onSteerQueuedPrompt={undefined}
      slashOpen={false} slashCmds={[]} slashLoading={false} historyWindow={null} onLoadOlderTurns={undefined}
      pendingQuestions={live?.pendingQuestions ?? []} stopStates={live?.stopState ? { [live.runId]: live.stopState } : {}}
      traceHealth={liveHealth} forkableRunIds={forkableRunIds} onForkTurn={!forkUnsupported && !working && !pending && !forkAttempt && !blockedReason ? turn => fork(turn) : undefined} renderLocationPicker={chatProps.renderLocationPicker}
      agentScopeLabel={chatProps.agentScopeLabel ?? '切换只影响下一条消息；发送时自动补齐缺失历史'}
      onAnswerQuestion={async response => { if (!await window.scry.answerQuestion(response)) throw new Error('问题已关闭或不再属于本轮'); await refresh() }}
      onStop={() => {
        if (activeRunId) void window.scry.stop(activeRunId).then(requested => setNotice(requested ? '已请求停止，等待本轮结束。' : '运行已结束或无法停止，请刷新状态。')).catch(error => setError(message(error)))
      }}
    />
    {forkAttempt && <div className="conversation-recovery" role="status"><button className="btn" disabled={working} onClick={() => { void fork(undefined, forkAttempt) }}>核对 / 继续原分支</button></div>}
    {recovery && <div className="conversation-recovery" role="status" data-pending-state={recovery.state}>
      <p>{recovery.explanation}</p>
      <button type="button" className="btn" data-pending-inspect={recovery.state}
        onClick={() => setInspectingPending(true)}>{SIDE_CHAT_COPY.pendingInspect}</button>
      <button className="btn" disabled={working} onClick={onCheckPending}>{SIDE_CHAT_COPY.pendingCheck}</button>
      {recovery.state === 'not_sent' && <button className="btn" disabled={working} onClick={onResendPending}>{SIDE_CHAT_COPY.pendingResend}</button>}
    </div>}
    {pending && recovery && inspectingPending && <PendingSubmissionDialog pending={pending} state={recovery.state}
      onClose={() => setInspectingPending(false)} />}
    {renaming && page && <SessionRenameDialog title={page.summary.title} onClose={() => setRenaming(false)} onSave={title => updateMetadata({ kind: 'rename', title })} />}
    {deleting && page && <ConversationDeleteDialog id={conversation.id} onChanged={() => { changedRef.current(); void refresh().catch(error => setError(message(error))) }} onClose={attempted => {
      setDeleting(false)
      if (attempted) requestAnimationFrame(() => refreshButton.current?.focus())
    }} />}
  </main>
}
