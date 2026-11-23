import type { ReactNode, RefObject } from 'react'
import type { TraceEvent, SlashCmd, TurnDiffSnapshot } from '@shared/trace'
import type {
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentSteerCapability,
  AgentRunControls,
  AgentStopState
} from '@shared/runtime'
import type { DetectedAgent } from '../../env'
import type { Turn } from '../../format'
import type { DraftAttachment, QueuedPrompt } from '../../App'
import type { WorkspaceFileTarget } from '../../workspace-links'
import type { SessionHistoryWindow, TraceLiveHealth } from '../../hooks/useAgentSession'
import type { ComposerDraftStore } from '../../composer-drafts'
import type { RendererSteerEvidence } from '../../steer'
import type { StopRequest } from '../../run-stop-status'
import type { WorkspacePrepareProgress } from '@shared/workspace-selection'
import type { AgentInputAttachment } from '@shared/runtime'

export interface WorkspaceSetupState {
  progress: WorkspacePrepareProgress
  prompt?: string
  attachments?: AgentInputAttachment[]
  cancelling?: boolean
  onCancel?: () => void
}

export interface ChatViewProps {
  turns: Turn[]
  selectedId: string | null
  scrollRef: RefObject<HTMLDivElement>
  textareaRef: RefObject<HTMLTextAreaElement>
  cwd: string | null
  workspaceRoots?: readonly string[]
  recent: string[]
  agents: DetectedAgent[]
  selectedAgentId: string
  agentLocked?: boolean
  hasSelectedSession?: boolean
  runControls: AgentRunControls
  runControlCatalog: AgentRunControlCatalog
  runControlsLoading?: boolean
  runControlsReason?: string | null
  input: string
  composerScopeKey?: string
  sendBlockedReason?: string | null
  showSendBlockedReason?: boolean
  composerError?: string | null
  detectionIssue?: string | null
  detectionRetrying?: boolean
  onRetryDetection?: () => void
  submitting?: boolean
  sessionLoading?: boolean
  transcriptPending?: boolean
  sessionCacheVisible?: boolean
  sessionEvidenceGap?: { status: 'unavailable' | 'empty' | 'error'; detail: string; title?: string; retry?: () => void; retrying?: boolean } | null
  emptyState?: { title: string; detail: string; status?: 'new-side-chat' | 'pending-first-send' } | null
  busy: boolean
  queueWhileBusy?: boolean
  draftAttachments: DraftAttachment[]
  queuedPrompts: QueuedPrompt[]
  steerCapability?: AgentSteerCapability | null
  steerEvidenceByMessageId?: ReadonlyMap<string, RendererSteerEvidence>
  steerInFlightMessageIds?: ReadonlySet<string>
  onSteerQueuedPrompt?: (messageId: string) => void
  editingQueuedId?: string | null
  movedQueuedId?: string | null
  onEditQueuedPrompt?: (messageId: string) => void
  onCancelQueuedPromptEdit?: () => void
  slashOpen: boolean
  slashLoading: boolean
  slashCmds: SlashCmd[]
  slashReason?: string | null
  slashSel: number
  pendingQuestions?: AgentQuestionRequest[]
  stopStates?: Readonly<Record<string, AgentStopState>>
  stopRequest?: StopRequest
  historyWindow?: SessionHistoryWindow | null
  historyOlderLoading?: boolean
  onLoadOlderTurns?: () => void
  traceHealth?: TraceLiveHealth
  focusedTurnRunId?: string | null
  scrollNavigation?: { active: RefObject<boolean>; cancel: () => void }
  onTurnRef?: (runId: string, el: HTMLDivElement | null) => void
  onSelect: (event: TraceEvent) => void
  onOpenDiff?: (turn: Turn, turnDiff: TurnDiffSnapshot, initialPath?: string) => void
  onForkTurn?: (turn: Turn) => Promise<void>
  forkableRunIds?: ReadonlySet<string>
  onOpenFile?: (target: WorkspaceFileTarget) => void
  onAnswerQuestion?: (response: AgentQuestionResponse) => Promise<void>
  onInput: (value: string) => void
  onChooseFolder: () => void
  onUnbindProject?: () => void
  onPickRecent: (cwd: string) => void
  onRemoveRecent: (cwd: string) => void
  onRetrySlash: () => void
  onPickSlash: (cmd: SlashCmd) => void
  onSlashSel: (index: number | ((index: number) => number)) => void
  onHideSlash: () => void
  onSend: () => void
  onStop: () => void
  onPasteImages: (files: File[]) => void
  onPasteClipboardImage: () => void
  onRemoveDraftAttachment: (id: string) => void
  onRemoveQueuedPrompt: (messageId: string) => void
  onSelectAgent: (agentId: string) => void
  onOpenRunControls?: (menu: RunControlMenu) => void
  onAddPiAgent?: () => void
  onRemovePiAgent?: (id: string) => void
  onRunModel: (model: AgentModelRef | undefined) => void
  onRunEffort: (effort: string | undefined) => void
  onPermissionMode: (mode: AgentPermissionMode) => void
  onRescan?: () => void
  agentsScanning?: boolean
  agentsScanFailed?: boolean
  unavailableAgentIds?: ReadonlySet<string>
  agentScopeLabel?: string
  workspaceContext?: ReactNode
  workspaceSendLabel?: string
  workspaceSetup?: WorkspaceSetupState | null
  renderLocationPicker?: (menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode
  remoteHost?: string
  composerNotice?: { text: string; tone: 'blocked' | 'error' | 'info'; action?: { label: string; onClick: () => void; disabled?: boolean } } | null
}

export type RunControlMenu = 'agent' | 'modelEffort' | 'permission'

export type SessionChatViewProps = Omit<ChatViewProps, 'input'> & {
  draftStore: ComposerDraftStore
  draftKey: string
}
