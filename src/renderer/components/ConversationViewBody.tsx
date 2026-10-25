import { type ComponentProps, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ActiveRun } from '@shared/trace'
import type { ConversationForkRequest, ConversationMetadataChange, ConversationPage, ConversationSendRequest, ConversationSummary } from '@shared/conversation-api'
import type { ComposerDraft, ComposerDraftStore } from '../composer-drafts'
import type { Turn } from '../format'
import { SessionChatView } from './ChatView'
import { ConversationDeleteDialog } from './ConversationDeleteDialog'
import { SessionRenameDialog } from './SessionRename'

const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function ConversationViewBody({
  conversation, draftKey, page, before, input, missing, working, managing, attempt, forkAttempt, attemptReadback, renaming, deleting, activeRunId, inherited, firstHandoff, limitation, drafts, live, forkableRunIds, error, notice, refreshButton, chatProps, setError, setNotice, setBefore, showLatest, updateMetadata, setRenaming, setDeleting, setAttempt, send, fork, refresh, onOpenConversation, mounted, changedRef, setReload, draftStore, turns, blockedReason, setInput
}: {
  conversation: ConversationSummary; draftKey: string; page?: ConversationPage; before?: number; input: string
  missing: ConversationPage['turns']; working: boolean; managing: boolean
  attempt?: { request: ConversationSendRequest; attachments: Array<{ id: string; previewUrl: string }> }
  forkAttempt?: ConversationForkRequest; attemptReadback: boolean; renaming: boolean; deleting: boolean
  activeRunId?: string; inherited?: boolean; firstHandoff?: boolean; limitation: string
  drafts: ReadonlyMap<string, ComposerDraft>; draftStore: ComposerDraftStore; turns: Turn[]; blockedReason: string | null; setInput: (value: string) => void; live?: ActiveRun; forkableRunIds: ReadonlySet<string>
  error?: string; notice?: string; refreshButton: MutableRefObject<HTMLButtonElement | null>
  chatProps: ComponentProps<typeof SessionChatView>; setError: Dispatch<SetStateAction<string | undefined>>
  setNotice: Dispatch<SetStateAction<string | undefined>>; setBefore: Dispatch<SetStateAction<number | undefined>>
  showLatest: () => void; updateMetadata: (change: ConversationMetadataChange) => Promise<void>; setRenaming: (value: boolean) => void; setDeleting: (value: boolean) => void
  setAttempt: Dispatch<SetStateAction<{ request: ConversationSendRequest; attachments: Array<{ id: string; previewUrl: string }> } | undefined>>
  send: (original?: { request: ConversationSendRequest; attachments: Array<{ id: string; previewUrl: string }> }) => Promise<void>
  fork: (turn?: Turn, original?: ConversationForkRequest) => Promise<void>; refresh: () => Promise<ConversationPage | undefined>; onOpenConversation: (conversation: ConversationSummary) => void
  setReload: Dispatch<SetStateAction<number>>; mounted: MutableRefObject<boolean>; changedRef: MutableRefObject<() => void>
}) {
  return <main className="unified-conversation conversation-chat" aria-label="对话" data-conversation-id={conversation.id}>
    <div className="conversation-toolbar">
      <strong className="conversation-title" title={conversation.cwd}>{page?.summary.title ?? conversation.title}</strong>
      <button ref={refreshButton} className="btn" onClick={() => { setError(undefined); setReload(value => value + 1) }}>刷新状态</button>
      <details className="conversation-options"><summary>对话选项</summary><div className="unified-management">
        <button className="btn" aria-label="重命名统一对话" disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => setRenaming(true)}>重命名</button>
        <button className="btn" aria-label={page?.summary.pinnedAt ? '取消置顶统一对话' : '置顶统一对话'} disabled={!page || managing || working || Boolean(page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'pin', pinned: !page?.summary.pinnedAt }).catch(error => setError(message(error))) }}>{page?.summary.pinnedAt ? '取消置顶' : '置顶'}</button>
        <button className="btn" aria-label={page?.summary.archivedAt ? '恢复统一对话' : '存档统一对话'} disabled={!page || managing || working || Boolean((page?.summary.blockedReason && page.summary.fork?.status !== 'not_sent') || page?.summary.deletion)} onClick={() => { void updateMetadata({ kind: 'archive', archived: !page?.summary.archivedAt }).catch(error => setError(message(error))) }}>{page?.summary.archivedAt ? '恢复' : '存档'}</button>
        {page?.summary.archivedAt && (page.summary.deletion?.status !== 'complete' || page.summary.deletion.retainedCopies) && <button className="btn" aria-label="删除统一对话" disabled={managing || working || Boolean(activeRunId)} onClick={() => setDeleting(true)}>{page.summary.deletion?.status === 'complete' ? '核对保留副本…' : page.summary.deletion ? '继续清理…' : '删除副本…'}</button>}
        <p>{limitation}</p>
        <p>从轮次创建原生分支不发送消息，也不回退文件。共享历史仅供查看；再次从这些轮次分支，请回到源对话。</p>
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
      agentLocked={!page || working || Boolean(attempt || forkAttempt || blockedReason || activeRunId)} hasSelectedSession
      onInput={setInput} onSend={() => { void send() }} submitting={working} sessionLoading={!page} sessionCacheVisible={false} sessionEvidenceGap={null}
      busy={Boolean(activeRunId)} queueWhileBusy={false}
      sendBlockedReason={blockedReason ?? (forkAttempt ? '请先核对原分支请求' : attempt ? '请先核对原发送状态' : chatProps.sendBlockedReason)} composerError={error ?? null}
      composerNotice={blockedReason && !activeRunId ? { text: blockedReason, tone: 'blocked' } : notice ? { text: notice, tone: 'blocked' } : firstHandoff ? { text: '旧 Agent 的接续身份无法验证。文字历史已保留，将在新上下文继续。', tone: 'blocked' } : null}
      draftAttachments={drafts.get(draftKey)?.attachments ?? []} queuedPrompts={[]} steerCapability={null} onSteerQueuedPrompt={undefined}
      slashOpen={false} slashCmds={[]} slashLoading={false} historyWindow={null} onLoadOlderTurns={undefined}
      pendingQuestions={live?.pendingQuestions ?? []} stopStates={live?.stopState ? { [live.runId]: live.stopState } : {}}
      traceHealth={undefined} forkableRunIds={forkableRunIds} onForkTurn={!working && !attempt && !forkAttempt && !blockedReason ? turn => fork(turn) : undefined} renderLocationPicker={undefined}
      agentScopeLabel="切换只影响下一条消息；发送时自动补齐缺失历史"
      onAnswerQuestion={async response => { if (!await window.scry.answerQuestion(response)) throw new Error('问题已关闭或不再属于本轮'); await refresh() }}
      onStop={() => {
        if (activeRunId) void window.scry.stop(activeRunId).then(requested => setNotice(requested ? '已请求停止，等待本轮结束。' : '运行已结束或无法停止，请刷新状态。')).catch(error => setError(message(error)))
      }}
    />
    {forkAttempt && <div className="conversation-recovery" role="status"><button className="btn" disabled={working} onClick={() => { void fork(undefined, forkAttempt) }}>核对 / 继续原分支</button></div>}
    {attempt && <div className="conversation-recovery" role="status">
      <button className="btn" disabled={working} onClick={() => { void send(attempt) }}>核对 / 继续原发送</button>
      {attemptReadback && !page?.summary.blockedReason && <button className="btn" disabled={working} onClick={() => { setAttempt(undefined); setError(undefined); setNotice('已解除界面锁定。再次发送是新请求，可能重复执行；请先核对聊天记录。') }}>保留草稿，解除锁定</button>}
    </div>}
    {renaming && page && <SessionRenameDialog title={page.summary.title} onClose={() => setRenaming(false)} onSave={title => updateMetadata({ kind: 'rename', title })} />}
    {deleting && page && <ConversationDeleteDialog id={conversation.id} onChanged={() => { changedRef.current(); void refresh().catch(error => setError(message(error))) }} onClose={attempted => {
      setDeleting(false)
      if (attempted) requestAnimationFrame(() => refreshButton.current?.focus())
    }} />}
  </main>
}
