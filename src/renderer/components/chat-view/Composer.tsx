import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatViewProps } from './types'
import { Icon } from '../primitives/Icon'
import { ComposerQueue } from './ComposerQueue'
import { ComposerInput } from './ComposerInput'
import { ComposerControls } from './ComposerControls'
import { providerHasEnded, runStopStatus } from '../../run-stop-status'
import { latestBackgroundWork } from '@shared/background-work'
import { backgroundWorkStatus, pendingQuestionStatus } from '../../background-work-status'
import { SLASH_COMMAND_COPY } from '../../constants/copy'
import { workspaceCopy } from '../../constants/workspace-copy'
import { filterSlashCommands, composerPromptHistory } from './composer-utils'
import { modelPickerOptions } from '../model-picker-options'

export function Composer({
  turns, textareaRef, cwd, recent, agents, selectedAgentId, agentLocked = false,
  hasSelectedSession = false,
  runControls, runControlCatalog, runControlsLoading = false, runControlsReason = null, input, composerScopeKey,
  sendBlockedReason = null, composerError = null, detectionIssue = null, detectionRetrying = false, onRetryDetection,
  submitting = false, sessionLoading = false, sessionCacheVisible = false, sessionEvidenceGap = null, busy,
  queueWhileBusy = true, draftAttachments, queuedPrompts, steerCapability = null, steerEvidenceByMessageId = new Map(),
  steerInFlightMessageIds = new Set(), onSteerQueuedPrompt, editingQueuedId = null, movedQueuedId = null,
  onEditQueuedPrompt, onCancelQueuedPromptEdit, slashOpen: slashRequested, slashLoading, slashCmds, slashReason = null,
  slashSel, pendingQuestions = [], stopStates = {}, traceHealth,
  onInput, onChooseFolder, onUnbindProject = () => {}, onPickRecent, onRemoveRecent, onRetrySlash, onPickSlash,
  onSlashSel, onHideSlash, onSend, onStop, onPasteImages, onPasteClipboardImage, onRemoveDraftAttachment,
  onRemoveQueuedPrompt, onSelectAgent, onAddPiAgent, onRemovePiAgent, onRunModel, onRunEffort, onPermissionMode,
  onRescan, unavailableAgentIds, agentScopeLabel, renderLocationPicker, remoteHost, composerNotice = null, workspaceContext, workspaceSendLabel
}: Omit<ChatViewProps, 'selectedId' | 'scrollRef' | 'onSelect' | 'onOpenDiff' | 'onForkTurn' | 'forkableRunIds' | 'onOpenFile' | 'onAnswerQuestion' | 'focusedTurnRunId' | 'scrollNavigation' | 'onTurnRef' | 'historyWindow'>) {
  const remote = remoteHost != null
  const sessionOwnerLoading = sessionLoading || sessionCacheVisible
  const resettingNewConversation = sessionLoading && !hasSelectedSession
  // New conversation clears the visible session synchronously, while main may still be
  // invalidating Provider context. Do not make the project picker wait for that background
  // work; historical-session loading remains hidden because it already has a session id.
  const showWorkdirPicker = !cwd || (turns.length === 0 && (!agentLocked || resettingNewConversation) && !busy && !submitting && (!sessionOwnerLoading || resettingNewConversation) && !sessionEvidenceGap)
  const slashMatches = filterSlashCommands(input, slashCmds)
  const slashMenuRef = useRef<HTMLDivElement>(null)
  const [composerMenu, setComposerMenu] = useState<'workdir' | 'agent' | 'modelEffort' | null>(null)
  const promptHistory = useMemo(() => composerPromptHistory(turns, queuedPrompts), [turns, queuedPrompts])
  // 编辑中的行不参与自动出队，所以「下一个」是第一条没在编辑中的消息——
  // 高亮必须跟着真实发送顺序走，否则界面在骗人。
  const nextQueuedMessageId = useMemo(
    () => queuedPrompts.find((prompt) => prompt.messageId !== editingQueuedId)?.messageId ?? null,
    [queuedPrompts, editingQueuedId]
  )
  const editingQueuedIndex = editingQueuedId == null
    ? -1
    : queuedPrompts.findIndex((prompt) => prompt.messageId === editingQueuedId)
  // Browse one snapshot until returning to the draft. Remote refreshes, older-page
  // loads and queue dispatch must not invalidate the cursor on a recalled prompt.
  const promptHistoryRef = useRef<{ scopeKey?: string; history: string[]; position: number } | null>(null)
  const historyNavigation = promptHistoryRef.current?.scopeKey === composerScopeKey &&
    promptHistoryRef.current?.history[promptHistoryRef.current.position] === input
    ? promptHistoryRef.current : null
  // Recalling a slash prompt is history navigation, not command completion.
  const slashOpen = slashRequested && !historyNavigation
  const resetPromptHistory = (): void => {
    promptHistoryRef.current = null
  }
  const modelValue = runControls.model
    ? JSON.stringify([runControls.model.providerId ?? null, runControls.model.id])
    : ''
  const selectedModel = runControlCatalog.models.find(
    (option) => JSON.stringify([option.model.providerId ?? null, option.model.id]) === modelValue
  )
  const modelOptions = useMemo(
    () => modelPickerOptions(runControlCatalog.models, runControlsReason, runControlsLoading),
    [runControlCatalog.models, runControlsReason, runControlsLoading]
  )
  const effortOptions = [
    { value: '', label: '默认', description: '使用模型默认推理强度' },
    ...(selectedModel?.efforts ?? []).map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description
    }))
  ]
  const permissionOptions = [
    ...(!runControlCatalog.permissions.some((option) => option.id === runControls.permissionMode)
      ? [{
          value: runControls.permissionMode,
          label: '请选择权限',
          description: '当前 Provider 需要你明确选择一个受支持的权限模式',
          disabled: true
        }]
      : []),
    ...runControlCatalog.permissions.map((option) => ({
      value: option.id,
      label: option.label,
      description: option.description
    }))
  ]
  const queueing = busy && queueWhileBusy
  const sendActionLabel = submitting ? workspaceCopy.starting : queueing ? workspaceCopy.queue : workspaceSendLabel ?? workspaceCopy.send
  const hasDraft = input.trim().length > 0 || draftAttachments.length > 0
  const composerStatus = composerError ?? detectionIssue ?? (hasDraft ? sendBlockedReason : null)

  // 运行状态条数据：当前未完成 turn 的首个事件时间戳（真实字段，不做假数字）
  const inFlightTurn = turns.find((turn) => !turn.done && !turn.error)
  const stopStatus = runStopStatus(
    inFlightTurn ? stopStates[inFlightTurn.runId] : undefined,
    inFlightTurn != null && providerHasEnded(inFlightTurn.items)
  )
  const busyTurn = busy ? inFlightTurn : undefined
  // Only the in-flight turn's own questions block it; another run's question is
  // shown in its own turn, not attributed to this status bar.
  const busyQuestionCount = busyTurn ? pendingQuestions.filter((question) => question.runId === busyTurn.runId).length : 0
  const backgroundStatus = stopStatus.tone === 'running'
    ? pendingQuestionStatus(busyQuestionCount) ?? (busyTurn ? backgroundWorkStatus(latestBackgroundWork(busyTurn.items)) : undefined)
    : undefined
  const runStartedAt = busyTurn?.items[0]?.ts != null ? Date.parse(busyTurn.items[0].ts) : Number.NaN

  useEffect(() => {
    if (!slashOpen) return
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slashMenuRef.current?.contains(target) || textareaRef.current?.contains(target)) return
      onHideSlash()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    return () => document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
  }, [onHideSlash, slashOpen, textareaRef])

  return (
      <div className="composer runtime-composer">
        <div className="composer-shell evidence-composer-shell">
        {slashOpen && (
          <div className="slash-menu" ref={slashMenuRef}>
            <div className="slash-head">
              <span>{SLASH_COMMAND_COPY.heading(remoteHost, slashLoading)}</span>
              {!slashLoading && (remote || slashCmds.length === 0) && (
                <button className="slash-retry" onClick={onRetrySlash} title={SLASH_COMMAND_COPY.refreshTitle(remoteHost)}>
                  <Icon name="refresh" /> {remote ? SLASH_COMMAND_COPY.refresh : SLASH_COMMAND_COPY.retry}
                </button>
              )}
            </div>
            <div className="slash-list" key={input}>
              {slashMatches.map((cmd, index) => (
                <button
                  key={cmd.name}
                  className={`slash-item ${index === slashSel ? 'sel' : ''}`}
                  ref={index === slashSel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                  onMouseEnter={() => onSlashSel(index)}
                  onClick={() => onPickSlash(cmd)}
                >
                  <span className="slash-name">{cmd.name}</span>
                  {cmd.argumentHint && <span className="slash-arg">{cmd.argumentHint}</span>}
                  <span className="slash-desc">{cmd.description}</span>
                </button>
              ))}
              {!slashLoading && slashMatches.length === 0 && (
                <div className="slash-empty">
                  {slashCmds.length === 0
                    ? slashReason ?? SLASH_COMMAND_COPY.empty
                    : SLASH_COMMAND_COPY.noMatches}
                </div>
              )}
            </div>
          </div>
        )}
        <ComposerQueue
          queuedPrompts={queuedPrompts} steerEvidenceByMessageId={steerEvidenceByMessageId}
          steerInFlightMessageIds={steerInFlightMessageIds} steerCapability={steerCapability}
          editingQueuedId={editingQueuedId} movedQueuedId={movedQueuedId}
          onSteerQueuedPrompt={onSteerQueuedPrompt} onEditQueuedPrompt={onEditQueuedPrompt}
          onCancelQueuedPromptEdit={onCancelQueuedPromptEdit} onRemoveQueuedPrompt={onRemoveQueuedPrompt}
          input={input} draftAttachments={draftAttachments} nextQueuedMessageId={nextQueuedMessageId} busy={busy}
        />
        <ComposerInput
          textareaRef={textareaRef} composerMenu={composerMenu} setComposerMenu={setComposerMenu}
          input={input} draftAttachments={draftAttachments} cwd={cwd} recent={recent}
          onChooseFolder={onChooseFolder} onUnbindProject={onUnbindProject} onPickRecent={onPickRecent}
          onRemoveRecent={onRemoveRecent} renderLocationPicker={renderLocationPicker}
          composerNotice={composerNotice} busy={busy} traceHealth={traceHealth} onStop={onStop}
          onCancelQueuedPromptEdit={onCancelQueuedPromptEdit} onInput={onInput}
          onPasteImages={onPasteImages} onPasteClipboardImage={onPasteClipboardImage}
          onRemoveDraftAttachment={onRemoveDraftAttachment} onRetryDetection={onRetryDetection}
          detectionRetrying={detectionRetrying} showWorkdirPicker={showWorkdirPicker}
          sendBlockedReason={sendBlockedReason} composerError={composerError}
          detectionIssue={detectionIssue} sessionLoading={sessionOwnerLoading}
          stopStatus={stopStatus} backgroundStatus={backgroundStatus}
          runStartedAt={runStartedAt} editingQueuedIndex={editingQueuedIndex}
          resetPromptHistory={resetPromptHistory} onSend={onSend} slashOpen={slashOpen}
          slashMatches={slashMatches} slashSel={slashSel} promptHistory={promptHistory}
          historyNavigation={historyNavigation} promptHistoryRef={promptHistoryRef}
          composerScopeKey={composerScopeKey} onHideSlash={onHideSlash} onSlashSel={onSlashSel}
          onPickSlash={onPickSlash}
        />
        <ComposerControls
          agents={agents} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent}
          onAddPiAgent={onAddPiAgent} onRemovePiAgent={onRemovePiAgent} onRescan={onRescan}
          unavailableAgentIds={unavailableAgentIds} agentScopeLabel={agentScopeLabel} agentLocked={agentLocked}
          runControls={runControls} onRunModel={onRunModel} onRunEffort={onRunEffort}
          onPermissionMode={onPermissionMode} composerMenu={composerMenu} setComposerMenu={setComposerMenu}
          modelValue={modelValue} modelOptions={modelOptions} effortOptions={effortOptions}
          permissionOptions={permissionOptions} loading={runControlsLoading}
          composerStatus={composerStatus} submitting={submitting} sessionLoading={sessionOwnerLoading}
          input={input} draftAttachments={draftAttachments} sendBlockedReason={sendBlockedReason}
          sendActionLabel={sendActionLabel} queueing={queueing} resetPromptHistory={resetPromptHistory}
          onSend={onSend} runControlCatalog={runControlCatalog}
        />
        </div>
        {workspaceContext}
        </div>
  )
}
