import { lazy, Suspense } from 'react'
import { providerIdForAgentId, runtimeProviderForAgentId } from '@shared/runtime'
import type { AgentModelRef, AgentPermissionMode } from '@shared/runtime'
import { createPortal } from 'react-dom'
import { RightSurfacePanel } from './RightSurfacePanel'
import { OverviewPanel } from './OverviewPanel'
import { WorkspacePanel, workspaceReferenceToken } from './WorkspacePanel'
import { SourceControlPanel } from './SourceControlPanel'
import { AgentsSurface } from './AgentsSurface'
import { TurnDiffReviewPanel } from './TurnDiffReviewPanel'
import { clipboardAttachmentToDraft, fileToDraftAttachment, type ComposerDraftAttachment } from '../composer-drafts'
import { QUEUE_COPY, REMOTE_SESSION_COPY } from '../constants/copy'
import { refreshRemoteCatalog } from '../hooks/useRemoteCatalogs'
import { ChatView } from './ChatView'
import { defaultOption, desktopProviderKey, RemoteFiles } from './DesktopRemote'
import { writeRemoteProviderKey } from '../remote-run-controls'
import { REMOTE_ACCESS_COPY as copy } from '../constants/copy'
import './desktop-remote.css'
import './remote-location.css'
import type { FoundationState } from './RemoteChatFoundation'
import type { ControlsState } from './RemoteChatControls'
import type { PresentationState } from './RemoteChatPresentation'
import type { ExecutionState } from './RemoteChatExecution'
import type { RemoteChatProps } from './RemoteChat'
import { errorText, remoteAgentId, remoteControlsValid } from './RemoteChatShared'

const TerminalSurface = lazy(() => import('./TerminalSurface').then((module) => ({ default: module.TerminalSurface })))

// A conversation that executes on a saved remote Scry desktop. It renders the same
// ChatView as local sessions; only the controller differs. The host owns Provider
// install, credentials, files and archive, so this view never falls back to local
// runtime state: an offline, unknown or forgotten host keeps the draft and blocks send.


export type RemoteChatViewProps = FoundationState & ControlsState & PresentationState & ExecutionState & RemoteChatProps

export function RemoteChatView(props: RemoteChatViewProps) {
  const { api, workbench, fileRequest, setFileRequest, setWorkspaceDirty, dispatchSurface, connected, host, catalog, setProviderSelection, sessionId, setSessionId, controls, providerControlsError, setProviderControlsRevision, selected, setSelected, historyEvidence, historyLoading, activeRun, setError, pollFresh, submitting, generation, provider, providerId, context, draftKey, input, draftAttachments, releaseAttachments, updateDraft, queueKey, queue, editingMessageId, setEditingMessageId, movedMessageId, setMovedMessageId, slashCmds, slashReason, slashLoading, setSlashRevision, slashSel, setSlashSel, setSlashHidden, slashOpen, controlProvider, updateControls, runControlCatalog, validPermissionMode, displayTurns, chatNavigation, openTurnInChat, runActive, controlRunId, sessionArchived, sendBlockedReason, submit, stop, answer, loadOlderHistory, agents, unavailableAgentIds, selectedAgentId, notice, diffReview, workspaceAvailable, upgradeWorkbench, connectionId, cwd, queueStore, onDraftInput, scrollRef, textareaRef, renderLocationPicker, onSessionAdopted, surface } = props
  return (
    <>
      <ChatView
        turns={displayTurns}
        selectedId={selected?.id ?? null}
        scrollRef={scrollRef}
        focusedTurnRunId={chatNavigation.focusedTurnRunId}
        textareaRef={textareaRef}
        cwd={cwd}
        workspaceRoots={[cwd]}
        recent={[]}
        agents={agents}
        selectedAgentId={selectedAgentId}
        agentLocked={Boolean(sessionId) || runActive || submitting}
        hasSelectedSession={Boolean(sessionId)}
        runControls={controls}
        runControlCatalog={runControlCatalog}
        runControlsReason={provider && runControlCatalog.models.length === 0 ? `${host} 未提供模型列表；使用 Provider 默认模型` : null}
        input={input}
        composerScopeKey={draftKey}
        sendBlockedReason={sendBlockedReason}
        submitting={submitting}
        sessionLoading={historyLoading && displayTurns.length === 0}
        sessionEvidenceGap={sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
          ? { status: 'unavailable', detail: historyEvidence.reason ?? `${host} 未提供这条会话的归档` }
          : null}
        busy={pollFresh && runActive && Boolean(controlRunId)}
        draftAttachments={draftAttachments}
        queuedPrompts={queue.prompts}
        editingQueuedId={editingMessageId}
        movedQueuedId={movedMessageId}
        onEditQueuedPrompt={(messageId) => {
          const prompt = queue.prompts.find(candidate => candidate.messageId === messageId)
          if (!prompt) return
          if (queue.claimed === messageId) { setError(QUEUE_COPY.editClaimed); return }
          setError(null)
          setEditingMessageId(messageId)
          setMovedMessageId(null)
          updateDraft(draftKey, () => ({ input: prompt.text, attachments: [] }))
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        onCancelQueuedPromptEdit={() => {
          setEditingMessageId(null)
          updateDraft(draftKey, () => ({ input: '', attachments: [] }))
          window.setTimeout(() => textareaRef.current?.focus(), 0)
        }}
        queueWhileBusy
        slashOpen={slashOpen}
        slashLoading={slashLoading}
        slashCmds={slashCmds}
        slashReason={slashReason}
        slashSel={slashSel}
        pendingQuestions={activeRun?.pendingQuestions}
        historyWindow={historyEvidence?.hasOlder && historyEvidence.before !== undefined && sessionId
          ? { sessionId, offset: 0, totalTurns: displayTurns.length, hasOlder: true, completeness: 'partial' }
          : null}
        onLoadOlderTurns={connected ? () => { void loadOlderHistory() } : undefined}
        onSelect={setSelected}
        onForkTurn={catalog?.sessionFork && provider?.forkSession && connected && !sessionArchived ? async (turn) => {
          const id = providerIdForAgentId(provider.id)
          const boundary = turn.forkTurnId ?? turn.providerTurnId
          if (!sessionId || !turn.providerTurnId || !boundary) throw new Error(REMOTE_SESSION_COPY.forkBoundaryMissing)
          if (!id) throw new Error(REMOTE_SESSION_COPY.forkUnsupported)
          const sourceGeneration = generation.current
          const forked = await api.forkSession(connectionId, {
            providerId: id, agentProfileId: provider.agentProfileId, cwd, sourceSessionId: sessionId,
            sourceRunId: turn.runId, sourceProviderTurnId: turn.providerTurnId, sourceForkTurnId: boundary,
            model: controls.model, permissionMode: validPermissionMode as AgentPermissionMode | undefined
          }).catch(reason => { throw new Error(errorText(reason)) })
          await refreshRemoteCatalog(connectionId)
          if (generation.current !== sourceGeneration) return
          setSessionId(forked.externalSessionId)
          onSessionAdopted(forked.externalSessionId, provider)
        } : undefined}
        onOpenDiff={() => dispatchSurface({ type: 'open', kind: 'diff' })}
        onOpenFile={(target) => {
          setFileRequest({ ...target, id: Date.now() })
          dispatchSurface({ type: 'open', kind: 'files' })
        }}
        onAnswerQuestion={answer}
        onInput={(value) => onDraftInput(draftKey, value)}
        onChooseFolder={() => {}}
        onPickRecent={() => {}}
        onRemoveRecent={() => {}}
        onRetrySlash={() => setSlashRevision(revision => revision + 1)}
        onPickSlash={(cmd) => {
          onDraftInput(draftKey, `/${cmd.name.replace(/^\/+/, '')} `)
          setSlashHidden(true)
          textareaRef.current?.focus()
        }}
        onSlashSel={setSlashSel}
        onHideSlash={() => setSlashHidden(true)}
        onSend={() => { void submit() }}
        onStop={() => { void stop() }}
        onPasteImages={(files) => {
          void Promise.all(files.map((file, index) => fileToDraftAttachment(file, index))).then((next) => {
            const attachments = next.filter((attachment): attachment is ComposerDraftAttachment => attachment != null)
            if (attachments.length) updateDraft(draftKey, (draft) => ({ ...draft, attachments: [...draft.attachments, ...attachments] }))
          }).catch((reason) => setError(errorText(reason)))
        }}
        onPasteClipboardImage={() => {
          void window.scry.clipboardImage().then((attachment) => {
            if (attachment) updateDraft(draftKey, (draft) => ({ ...draft, attachments: [...draft.attachments, clipboardAttachmentToDraft(attachment)] }))
          }).catch((reason) => setError(errorText(reason)))
        }}
        onRemoveDraftAttachment={(id) => {
          const removed = draftAttachments.filter(attachment => attachment.id === id)
          updateDraft(draftKey, (draft) => ({ ...draft, attachments: draft.attachments.filter(attachment => attachment.id !== id) }))
          releaseAttachments(removed)
        }}
        onRemoveQueuedPrompt={(messageId) => {
          if (queue.writeUnknown && queue.claimed === messageId) setError(null)
          queueStore.remove(queueKey, messageId)
        }}
        onSelectAgent={(agentId) => {
          const next = catalog?.providers.find((item) => remoteAgentId(item) === agentId)
          if (next?.available) {
            const key = desktopProviderKey(next)
            setProviderSelection(key)
            writeRemoteProviderKey(connectionId, key)
          }
        }}
        unavailableAgentIds={unavailableAgentIds}
        agentScopeLabel={`${host} 上的 Agent`}
        onRunModel={(model: AgentModelRef | undefined) => {
          const option = controlProvider?.models?.find((item) => item.id === model?.id && (item.providerId ?? '') === (model?.providerId ?? ''))
          updateControls({ ...controls, model, effort: defaultOption(option?.efforts ?? controlProvider?.efforts) })
        }}
        onRunEffort={(effort) => updateControls({ ...controls, effort })}
        onPermissionMode={(permissionMode) => updateControls({ ...controls, permissionMode })}
        renderLocationPicker={renderLocationPicker}
        remoteHost={host}
        composerNotice={notice ?? (providerControlsError || (controlProvider && !controlProvider.available)
          ? { tone: 'blocked', text: copy.providerControlsUnavailable(host), action: { label: copy.retryProviderControls, onClick: () => setProviderControlsRevision(value => value + 1) } }
          : !controlProvider && provider && connected
            ? { tone: 'blocked', text: copy.loadingProviderControls }
            : controlProvider && !remoteControlsValid(controlProvider, controls)
              ? { tone: 'blocked', text: copy.providerControlsChanged }
              : catalog?.providerDiscovery !== 2 && controlProvider
                ? { tone: 'blocked', text: copy.legacyProviderControls }
                : null)}
      />
      {surface.target && createPortal(
        <RightSurfacePanel
          openIds={surface.state.openIds}
          activeId={surface.state.activeId}
          maximized={surface.state.maximized}
          retainTerminal={surface.retainTerminal}
          onOpen={(kind) => dispatchSurface({ type: 'open', kind })}
          onActivate={(kind) => dispatchSurface({ type: 'activate', kind })}
          onClose={(kind) => dispatchSurface({ type: 'close', kind })}
          onHide={() => surface.onAction({ type: 'hide' })}
          onToggleMaximized={() => surface.onAction({ type: 'toggle-maximized' })}
          contents={{
            overview: sessionId && historyEvidence?.status === 'unavailable' && displayTurns.length === 0
              ? <div className="surface-unavailable"><b>会话证据不可用</b><span>{historyEvidence.reason ?? `${host} 未提供这条会话的归档`}</span></div>
              : <OverviewPanel
                  turns={displayTurns} sessionId={sessionId} selected={selected}
                  runtimeProvider={runtimeProviderForAgentId(providerId)} usage={null} stats={null}
                  busy={pollFresh && runActive} onSelect={setSelected} onOpenTurn={openTurnInChat}
                />,
            files: workspaceAvailable
              ? catalog?.workbench === 1
                ? <WorkspacePanel cwd={cwd} api={workbench.workspace} openRequest={fileRequest}
                    onClose={() => dispatchSurface({ type: 'close', kind: 'files' })}
                    onDirtyChange={(dirty) => { setWorkspaceDirty(dirty); surface.onDirtyChange?.(dirty) }}
                    onAddReference={(entry) => onDraftInput(draftKey, `${input}${input && !input.endsWith(' ') ? ' ' : ''}${workspaceReferenceToken(entry)} `)} />
                : <RemoteFiles api={api} connectionId={connectionId} context={context} onClose={() => dispatchSurface({ type: 'close', kind: 'files' })} />
              : <div className="surface-unavailable"><b>文件不可用</b><span>{sendBlockedReason ?? '当前上下文不可读取文件。'}</span></div>,
            'source-control': catalog?.workbench === 1 ? <SourceControlPanel cwd={cwd} api={workbench.sourceControl} active={surface.state.visible && surface.state.activeId === 'source-control'} /> : upgradeWorkbench,
            terminal: catalog?.workbench === 1 ? <Suspense fallback={<div className="surface-unavailable">正在加载终端…</div>}><TerminalSurface cwd={cwd} scopeId={surface.scopeId} api={workbench.terminal} machineLabel={host} active={surface.state.visible && surface.state.activeId === 'terminal'} /></Suspense> : upgradeWorkbench,
            agents: <AgentsSurface turns={displayTurns} busy={pollFresh && runActive} />,
            diff: diffReview ? <TurnDiffReviewPanel review={diffReview} onClose={() => dispatchSurface({ type: 'close', kind: 'diff' })} />
              : <div className="surface-unavailable"><b>本会话还没有可审阅的改动</b><span>某一轮产生 Git 净改动后，这里会显示真实会话改动。</span></div>
          }}
        />, surface.target
      )}
    </>
  )
}
