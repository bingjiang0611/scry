import type { ComponentProps, Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import type { useAgentSession } from './hooks/useAgentSession'
import type { useIntegrations } from './hooks/useIntegrations'
import type { useChatNavigation } from './hooks/useChatNavigation'
import type { ComposerDraftStore } from './composer-drafts'
import type { DraftAttachment, QueuedPrompt, SessionEvidenceGap } from './app-model'
import type { useWorkspaceState } from './hooks/useWorkspaceState'
import type { Turn } from './format'
import type { SlashCmd } from '@shared/trace'
import { LOCAL_MACHINE } from './components/LocationPicker'
import { SessionChatView } from './components/ChatView'

export interface AppChatPropsContext {
  draftStore: ComposerDraftStore
  workspaceContext?: ReactNode
  workspaceSendLabel?: string
  workspaceBlockedReason?: string
  draftKey: string
  session: ReturnType<typeof useAgentSession>
  scrollRef: RefObject<HTMLDivElement>
  taRef: RefObject<HTMLTextAreaElement>
  cwd: string | null
  workspaceRoots: string[]
  recent: ReturnType<typeof useWorkspaceState>['recent']
  integrations: ReturnType<typeof useIntegrations>
  switchingAgent: boolean
  composerSubmitting: boolean
  sessionLoading: boolean
  activeSessionId: string | null
  sendBlockedReason: string | null | undefined
  composerError: string | null
  providerSendBlockedReason: string | null
  providerCompatibilityIssue: string | null | undefined
  sessionCacheVisible: boolean
  activeEvidenceGap: SessionEvidenceGap | null
  draftAttachments: DraftAttachment[]
  queuedPrompts: QueuedPrompt[]
  steerCapability: import('@shared/runtime').AgentSteerCapability | null
  steerEvidenceByMessageId: ReadonlyMap<string, import('@shared/runtime').AgentSteerEvidence & { eventId: string }>
  editingQueuedPromptId: string | null
  movedQueuedPromptId: string | null
  slashOpen: boolean
  slashLoading: boolean
  slashCmds: SlashCmd[]
  slashReason: string | null
  slashSel: number
  focusedTurnRunId: string | null
  chatNavigation: ReturnType<typeof useChatNavigation>
  addPastedImages: (files: File[]) => Promise<void>
  addClipboardImage: () => Promise<void>
  pickSlash: (cmd: SlashCmd) => void
  send: () => Promise<void>
  stopRun: () => Promise<void>
  loadOlderTurns: () => Promise<void>
  historyOlderLoading: boolean
  openTurnDiffReview: (turn: { runId: string; userText: string }, diff: import('@shared/trace').TurnDiffSnapshot, path?: string) => void
  forkConversationTurn: (turn: Turn) => Promise<void>
  openWorkspaceFile: (target: import('./workspace-links').WorkspaceFileTarget) => void
  selectChatAgent: (id: string) => void
  setInput: Dispatch<SetStateAction<string>>
  setComposerError: Dispatch<SetStateAction<string | null>>
  setSlashHidden: Dispatch<SetStateAction<boolean>>
  setSlashSel: Dispatch<SetStateAction<number>>
  chooseFolder: ReturnType<typeof useWorkspaceState>['chooseFolder']
  unbindProject: () => Promise<void>
  pickRecent: (cwd: string) => Promise<void>
  removeRecentFolder: ReturnType<typeof useWorkspaceState>['removeRecentFolder']
  renderLocationPicker: (current: import('./components/LocationPicker').ExecutionLocation) => (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => JSX.Element
  retrySlash: () => void
  steerInFlightRef: ReadonlySet<string>
  steerQueuedPrompt: (id: string) => void
  editQueuedPrompt: (id: string) => void
  cancelQueuedPromptEdit: () => void
  removeDraftAttachment: (id: string) => void
  removeQueuedPrompt: (id: string) => void
  slashHidden: boolean
}

export function createAppChatProps(context: AppChatPropsContext): ComponentProps<typeof SessionChatView> {
  const { workspaceContext, workspaceSendLabel, workspaceBlockedReason, draftStore, draftKey, session, scrollRef, taRef, cwd, workspaceRoots, recent, integrations, switchingAgent,
    composerSubmitting, sessionLoading, activeSessionId, sendBlockedReason, composerError, providerSendBlockedReason,
    providerCompatibilityIssue, sessionCacheVisible, activeEvidenceGap, draftAttachments, queuedPrompts, steerCapability,
    steerEvidenceByMessageId, editingQueuedPromptId, movedQueuedPromptId, slashOpen, slashLoading,
    slashCmds, slashReason, slashSel, focusedTurnRunId, chatNavigation, addPastedImages, addClipboardImage, pickSlash, send,
    stopRun, loadOlderTurns, historyOlderLoading, openTurnDiffReview, forkConversationTurn, openWorkspaceFile, selectChatAgent,
    setInput, setComposerError, setSlashHidden, setSlashSel, chooseFolder, unbindProject, pickRecent, removeRecentFolder,
    renderLocationPicker, retrySlash, steerInFlightRef, steerQueuedPrompt, editQueuedPrompt, cancelQueuedPromptEdit,
    removeDraftAttachment, removeQueuedPrompt, slashHidden } = context

  const chatProps: ComponentProps<typeof SessionChatView> = {
    draftStore,
    draftKey,
    turns: session.turns,
    selectedId: session.selected?.id ?? null,
    scrollRef,
    textareaRef: taRef,
    cwd,
    workspaceRoots,
    recent,
    agents: integrations.agents,
    selectedAgentId: integrations.selectedId,
    agentLocked: switchingAgent || composerSubmitting || session.busy || sessionLoading,
    hasSelectedSession: activeSessionId != null,
    runControls: integrations.runControls,
    runControlCatalog: integrations.runControlCatalog,
    runControlsLoading: integrations.runControlsLoading,
    runControlsReason: integrations.runControlCapability?.reason,
    workspaceContext, workspaceSendLabel,
    sendBlockedReason: sendBlockedReason ?? workspaceBlockedReason,
    composerError,
    detectionIssue: integrations.agentsScanError ?? providerSendBlockedReason ?? providerCompatibilityIssue,
    detectionRetrying: integrations.detectionRetrying,
    onRetryDetection: () => { setComposerError(null); integrations.retryDetection() },
    submitting: composerSubmitting || switchingAgent,
    sessionLoading,
    sessionCacheVisible,
    sessionEvidenceGap: activeEvidenceGap,
    busy: session.busy,
    draftAttachments,
    queuedPrompts,
    steerCapability,
    steerEvidenceByMessageId,
    steerInFlightMessageIds: steerInFlightRef,
    onSteerQueuedPrompt: steerQueuedPrompt,
    editingQueuedId: editingQueuedPromptId,
    movedQueuedId: movedQueuedPromptId,
    onEditQueuedPrompt: editQueuedPrompt,
    onCancelQueuedPromptEdit: cancelQueuedPromptEdit,
    slashOpen,
    slashLoading,
    slashCmds,
    slashReason,
    slashSel,
    pendingQuestions: session.pendingQuestions,
    stopStates: session.stopStates,
    historyWindow: session.historyWindow,
    historyOlderLoading,
    onLoadOlderTurns: () => { void loadOlderTurns() },
    traceHealth: session.traceHealth,
    focusedTurnRunId,
    scrollNavigation: chatNavigation,
    onSelect: session.setSelected,
    onOpenDiff: openTurnDiffReview,
    onForkTurn: forkConversationTurn,
    onOpenFile: openWorkspaceFile,
    onAnswerQuestion: session.answerQuestion,
    onInput: value => {
      setInput(value)
      if (composerError !== null) setComposerError(null)
      if (slashHidden) setSlashHidden(false)
    },
    onChooseFolder: chooseFolder,
    onUnbindProject: unbindProject,
    onPickRecent: pickRecent,
    onRemoveRecent: removeRecentFolder,
    renderLocationPicker: renderLocationPicker({ machineId: LOCAL_MACHINE, cwd }),
    onRetrySlash: retrySlash,
    onPickSlash: pickSlash,
    onSlashSel: setSlashSel,
    onHideSlash: () => setSlashHidden(true),
    onSend: async () => {
      if (workspaceBlockedReason) { setComposerError(workspaceBlockedReason); return }
      await send()
    },
    onStop: stopRun,
    onPasteImages: addPastedImages,
    onPasteClipboardImage: addClipboardImage,
    onRemoveDraftAttachment: removeDraftAttachment,
    onRemoveQueuedPrompt: removeQueuedPrompt,
    onSelectAgent: selectChatAgent,
    onAddPiAgent: integrations.addPiProfile,
    onRemovePiAgent: integrations.removePiProfile,
    onRunModel: integrations.setRunModel,
    onRunEffort: integrations.setRunEffort,
    onPermissionMode: integrations.setPermissionMode,
    onRescan: integrations.rescan
  }
  return chatProps
}
