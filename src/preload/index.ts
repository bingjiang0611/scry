import { contextBridge, ipcRenderer } from 'electron'
import { eventApi } from './event-api'
import { remoteApi } from './remote-api'
import { conversationsApi } from './conversations'
import { runTracesApi } from './run-traces'
import type { GitDiffScope, WorkspaceDiffSnapshotResult } from '../shared/workspace-diff'
import type { DiffCommitPage, DiffCommitPageRequest, DiffCommitSnapshot, DiffCommitSnapshotRequest } from '../shared/diff-history'
import type { SourceControlApi } from '../shared/source-control'
import type { WorkspaceSelectionApi } from '../shared/workspace-selection'
import type { ConversationSummary } from '../shared/conversation-api'
import type { BackgroundTaskStopResult } from '../shared/background-work'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { RecorderContentPage, RecorderContentPageRequest } from '../shared/tool-content'
import type {
  ActiveRun,
  DbStats,
  TraceEvent,
  WorkspaceDiffResult,
  UsageAnalytics,
  UsageAnalyticsRangeDays,
  UsageStats
} from '../shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '../shared/billing'
import type { RendererPerformanceSample } from '../shared/performance'
import type { RendererRestartRecord } from '../shared/renderer-restart'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../shared/llm-performance'
import type {
  AgentForkSessionRequest,
  AgentForkSessionResult,
  AgentInputAttachment,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentStartRequest,
  AgentStartResult,
  AgentSteerRequest,
  AgentSteerResult,
  RuntimeProvider
} from '../shared/runtime'
import type {
  CatalogHealth,
  CapabilityEnvelope,
  DeleteArchivedSessionsResult,
  DeleteSessionResult,
  McpAuthResult,
  McpSnapshot,
  McpTestResult,
  ProviderCommand,
  ProviderContext,
  ProviderDescriptor,
  SessionProviderId,
  SkillMeta
} from '../shared/provider'
import type { DetectedAgent as LocatedAgent } from '../main/claude-locate'
import type {
  LoadedSessionTurn,
  SessionHistoryPage,
  SessionHistoryPageRequest
} from '../main/session-history'
import type { TraceBacklogState, TraceBatchReceipt } from '../main/trace-output'
import type {
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceFilePage,
  WorkspaceFilePageRequest,
  WorkspaceFileSnapshot,
  WorkspaceFileOpenTarget,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspaceMoveRequest,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace'
import type { ScanReport } from '../cli/mcpguard-core'
import { isMcpGuardReport } from '../shared/mcpguard-report'
import type {
  TerminalRecordingRequest,
  TerminalRecordingPage,
  TerminalRecordingListRequest,
  TerminalRecordingListPage,
  TerminalSessionDescriptor,
  TerminalSessionInfo,
  TerminalAttachInfo,
  TerminalStartRequest
} from '../shared/terminal'

export interface SessionMeta {
  sessionId: string
  runId?: string
  lastRunOutcome?: import('../shared/turn-record').AgentTurnRecord['status']
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
  /** Execution cwd when grouped beneath a different project root. */
  cwd?: string
  pinnedAt?: number
  archivedAt?: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
  /** Logical conversations group native aliases without changing raw catalogs. */
  conversations?: ConversationSummary[]
  pinnedAt?: number
}

/** 定位单条会话：置顶 / 存档只需要这几个字段。 */
export interface SessionRef {
  providerId: SessionProviderId
  agentProfileId?: string
  cwd: string
  externalSessionId: string
}

export type DetectedAgent = LocatedAgent & {
  agentProfileId?: string
  runtimeProvider?: RuntimeProvider
  transport?: string
  capabilities?: ProviderDescriptor['capabilities']
  health?: ProviderDescriptor['health']
  /** Provider 已装但 adapter 不可用时的原因。 */
  unavailableReason?: string
  /** CLI 版本兼容性判定；它是提示，不阻断发送。 */
  compatibility?: ProviderDescriptor['compatibility']
}

export type ParsedTurn = LoadedSessionTurn
export type { SessionHistoryPage, SessionHistoryPageRequest }
export type { TraceBacklogState, TraceBatchReceipt }

const sourceControl: SourceControlApi = {
  read: cwd => ipcRenderer.invoke('sourceControl:read', cwd),
  diff: request => ipcRenderer.invoke('sourceControl:diff', request),
  mutate: request => ipcRenderer.invoke('sourceControl:mutate', request),
  operations: request => ipcRenderer.invoke('sourceControl:operations', request),
  reconcile: request => ipcRenderer.invoke('sourceControl:reconcile', request),
  acknowledge: request => ipcRenderer.invoke('sourceControl:acknowledge', request),
  pullRequests: request => ipcRenderer.invoke('sourceControl:pullRequests', request),
  pullRequest: request => ipcRenderer.invoke('sourceControl:pullRequest', request),
  saveCommitDraft: request => ipcRenderer.invoke('sourceControl:saveCommitDraft', request),
  loadCommitDraft: request => ipcRenderer.invoke('sourceControl:loadCommitDraft', request),
  saveDraft: request => ipcRenderer.invoke('sourceControl:saveDraft', request),
  loadDraft: request => ipcRenderer.invoke('sourceControl:loadDraft', request)
}

const api = {
  rendererReady: (): void => ipcRenderer.send('app:rendererReady'),
  setTheme: (theme: 'dark' | 'light'): Promise<true> => ipcRenderer.invoke('app:setTheme', theme),
  copyText: (text: string): Promise<true> => ipcRenderer.invoke('app:copyText', text),
  performanceDiagnosticsEnabled: (): Promise<boolean> => ipcRenderer.invoke('app:performanceDiagnosticsEnabled'),
  rendererRestart: (): Promise<RendererRestartRecord | null> => ipcRenderer.invoke('app:rendererRestart'),
  reportRendererPerformance: (sample: RendererPerformanceSample): Promise<boolean> =>
    ipcRenderer.invoke('app:reportRendererPerformance', sample),
  detectFast: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detectFast'),
  detect: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detect'),
  addPiProfile: (): Promise<DetectedAgent | null> => ipcRenderer.invoke('agent:addPiProfile'),
  removePiProfile: (id: string): Promise<true> => ipcRenderer.invoke('agent:removePiProfile', id),
  providerDescriptors: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke('agent:providerDescriptors'),
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('agent:recentFolders'),
  removeRecentFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('agent:removeRecentFolder', dir),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('agent:chooseFolder'),
  clipboardImage: (): Promise<AgentInputAttachment | null> => ipcRenderer.invoke('agent:clipboardImage'),
  sourceControl,
  workspaceSelection: {
    read: request => ipcRenderer.invoke('workspaceSelection:read', request),
    inspectStart: request => ipcRenderer.invoke('workspaceSelection:inspectStart', request),
    validateBranch: request => ipcRenderer.invoke('workspaceSelection:validateBranch', request)
  } satisfies WorkspaceSelectionApi,
  conversations: conversationsApi,
  workspaceList: (request: WorkspaceListRequest): Promise<WorkspaceListResult> => ipcRenderer.invoke('workspace:list', request),
  workspaceResolveFile: (request: WorkspacePathRequest): Promise<WorkspaceFileOpenTarget> => ipcRenderer.invoke('workspace:resolveFile', request),
  workspaceRead: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:read', request),
  workspaceReadPage: (request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage> => ipcRenderer.invoke('workspace:readPage', request),
  workspaceReadKnown: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:readKnown', request),
  workspaceReadPageKnown: (request: WorkspaceFilePageRequest): Promise<WorkspaceFilePage> => ipcRenderer.invoke('workspace:readPageKnown', request),
  workspaceOpenExternal: (request: WorkspacePathRequest): Promise<boolean> => ipcRenderer.invoke('workspace:openExternal', request),
  workspaceOpenKnownExternal: (request: WorkspacePathRequest): Promise<boolean> => ipcRenderer.invoke('workspace:openKnownExternal', request),
  workspaceWrite: (request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:write', request),
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:create', request),
  workspaceRename: (request: WorkspaceRenameRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:rename', request),
  workspaceMove: (request: WorkspaceMoveRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:move', request),
  workspaceTrash: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:trash', request),
  terminalStart: (request: TerminalStartRequest): Promise<TerminalSessionInfo> => ipcRenderer.invoke('terminal:start', request),
  terminalActive: (): Promise<TerminalSessionDescriptor[]> => ipcRenderer.invoke('terminal:active'),
  terminalAttach: (id: string): Promise<TerminalAttachInfo> => ipcRenderer.invoke('terminal:attach', { id }),
  terminalWrite: (id: string, ownershipEpoch: number, data: string): Promise<boolean> => ipcRenderer.invoke('terminal:write', { id, ownershipEpoch, data }),
  terminalResize: (id: string, ownershipEpoch: number, cols: number, rows: number): Promise<boolean> => ipcRenderer.invoke('terminal:resize', { id, ownershipEpoch, cols, rows }),
  terminalReady: (id: string, ownershipEpoch: number): Promise<boolean> => ipcRenderer.invoke('terminal:ready', { id, ownershipEpoch }),
  terminalAck: (id: string, ownershipEpoch: number, bytes: number): Promise<boolean> => ipcRenderer.invoke('terminal:ack', { id, ownershipEpoch, bytes }),
  terminalClose: (id: string, ownershipEpoch: number): Promise<boolean> => ipcRenderer.invoke('terminal:close', { id, ownershipEpoch }),
  terminalRecordingList: (request: TerminalRecordingListRequest = {}): Promise<TerminalRecordingListPage> => ipcRenderer.invoke('terminal:recordingList', request),
  terminalRecordingRead: (request: TerminalRecordingRequest): Promise<TerminalRecordingPage> => ipcRenderer.invoke('terminal:recordingRead', request),
  terminalRecordingDelete: (id: string): Promise<true> => ipcRenderer.invoke('terminal:recordingDelete', { id }),
  setCwd: (dir: string | null): Promise<string | null> => ipcRenderer.invoke('agent:setCwd', dir),
  newSession: (context: ProviderContext): Promise<boolean> => ipcRenderer.invoke('agent:newSession', context),
  forkSession: (request: AgentForkSessionRequest): Promise<AgentForkSessionResult> => ipcRenderer.invoke('agent:forkSession', request),
  invalidateProviderContext: (context: ProviderContext): Promise<true> => ipcRenderer.invoke('agent:invalidateProviderContext', context),
  listSessions: (context: ProviderContext): Promise<SessionMeta[]> => ipcRenderer.invoke('agent:listSessions', context),
  listProjects: (): Promise<ProjectMeta[]> => ipcRenderer.invoke('agent:listProjects'),
  setProjectPinned: (cwd: string, pinned: boolean): Promise<boolean> => ipcRenderer.invoke('agent:setProjectPinned', cwd, pinned),
  renameProject: (cwd: string, name: string): Promise<boolean> => ipcRenderer.invoke('agent:renameProject', cwd, name),
  removeProject: (cwd: string): Promise<true> => ipcRenderer.invoke('agent:removeProject', cwd),
  revealProject: (cwd: string): Promise<true> => ipcRenderer.invoke('agent:revealProject', cwd),
  listArchivedSessions: (): Promise<ProjectMeta[]> => ipcRenderer.invoke('agent:listArchivedSessions'),
  catalogHealth: (): Promise<CatalogHealth> => ipcRenderer.invoke('agent:catalogHealth'),
  listSkills: (context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> => ipcRenderer.invoke('agent:listSkills', context),
  mcpSnapshot: (context: ProviderContext, refresh = false): Promise<CapabilityEnvelope<McpSnapshot>> =>
    ipcRenderer.invoke('agent:mcpSnapshot', { context, refresh }),
  mcpGuardScan: async (context: ProviderContext): Promise<CapabilityEnvelope<ScanReport>> => {
    const envelope = await ipcRenderer.invoke('agent:mcpGuardScan', context) as CapabilityEnvelope<unknown>
    if (envelope.data !== null && !isMcpGuardReport(envelope.data)) throw new Error('main 返回了无效的 mcpguard 报告')
    return envelope as CapabilityEnvelope<ScanReport>
  },
  testMcp: (context: ProviderContext, targetId: string): Promise<CapabilityEnvelope<McpTestResult>> =>
    ipcRenderer.invoke('agent:testMcp', { context, targetId }),
  reauthenticateMcp: (context: ProviderContext, targetId: string): Promise<CapabilityEnvelope<McpAuthResult>> =>
    ipcRenderer.invoke('agent:reauthenticateMcp', { context, targetId }),
  listCommands: (context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> =>
    ipcRenderer.invoke('agent:listCommands', context),
  runControls: (context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>> =>
    ipcRenderer.invoke('agent:runControls', context),
  usageStats: (context: ProviderContext): Promise<UsageStats> =>
    ipcRenderer.invoke('agent:usageStats', context),
  stats: (): Promise<DbStats> => ipcRenderer.invoke('agent:stats'),
  usageAnalytics: (rangeDays: UsageAnalyticsRangeDays): Promise<UsageAnalytics> =>
    ipcRenderer.invoke('agent:usageAnalytics', rangeDays),
  usageCredits: (rangeDays: UsageAnalyticsRangeDays): Promise<UsageAnalytics> =>
    ipcRenderer.invoke('agent:usageCredits', rangeDays),
  llmPerformanceHistory: (): Promise<LlmPerformanceHistory> =>
    ipcRenderer.invoke('agent:llmPerformanceHistory'),
  llmPerformanceSummary: (): Promise<LlmPerformanceSummary> =>
    ipcRenderer.invoke('agent:llmPerformanceSummary'),
  billingState: (): Promise<BillingGuardianState> => ipcRenderer.invoke('agent:billingState'),
  syncBillingAdmin: (): Promise<BillingSyncResult> => ipcRenderer.invoke('agent:syncBillingAdmin'),
  importBillingFixture: (): Promise<BillingFixtureImportResult> => ipcRenderer.invoke('agent:importBillingFixture'),
  gitDiff: (cwd: string): Promise<WorkspaceDiffResult> => ipcRenderer.invoke('agent:gitDiff', cwd),
  gitDiffSnapshot: (cwd: string, scope: GitDiffScope = 'workspace'): Promise<WorkspaceDiffSnapshotResult> => ipcRenderer.invoke('agent:gitDiffSnapshot', cwd, scope),
  gitDiffCommits: (request: DiffCommitPageRequest): Promise<DiffCommitPage> => ipcRenderer.invoke('agent:gitDiffCommits', request),
  gitCommitDiffSnapshot: (request: DiffCommitSnapshotRequest): Promise<DiffCommitSnapshot> => ipcRenderer.invoke('agent:gitCommitDiffSnapshot', request),
  recorderContentPage: (request: RecorderContentPageRequest): Promise<RecorderContentPage> =>
    ipcRenderer.invoke('agent:recorderContentPage', request),
  // 只拿最近一页：完整历史不作为单个 payload 过 IPC。更早轮次用 loadSessionOlder 取回。
  loadSession: (context: ProviderContext, request?: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSession', context, request),
  loadSessionOlder: (context: ProviderContext, request: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSessionOlder', context, request),
  // 只补一轮的终态证据（result / session_diff）：总览的用量、成本只认这份证据。
  turnTerminalEvidence: (context: ProviderContext, runId: string): Promise<TraceEvent[]> =>
    ipcRenderer.invoke('agent:turnTerminalEvidence', context, runId),
  deleteSession: (context: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke('agent:deleteSession', context),
  renameSession: (context: SessionRef, title: string): Promise<boolean> =>
    ipcRenderer.invoke('agent:renameSession', context, title),
  setSessionPinned: (context: SessionRef, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('agent:setSessionPinned', context, pinned),
  setSessionArchived: (context: SessionRef, archived: boolean): Promise<boolean> =>
    ipcRenderer.invoke('agent:setSessionArchived', context, archived),
  deleteArchivedSessions: (): Promise<DeleteArchivedSessionsResult> => ipcRenderer.invoke('agent:deleteArchivedSessions'),
  /** commandStatus='duplicate' 表示这条 commandId 已被受理过，runId 是第一次的那个。 */
  start: (request: AgentStartRequest): Promise<AgentStartResult & { commandStatus?: 'executed' | 'duplicate'; commandSequence?: number }> =>
    ipcRenderer.invoke('agent:start', request),
  activeRun: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:activeRun'),
  unreadSessions: (): Promise<SessionAttentionSnapshot> => ipcRenderer.invoke('agent:unreadSessions'),
  /** 权威事件快照（忽略 done）：live trace 降级后用它重新对齐，包含终态被跳过的事件。 */
  focusedRunSnapshot: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:focusedRunSnapshot'),
  activeRuns: (): Promise<ActiveRun[]> => ipcRenderer.invoke('agent:activeRuns'),
  focusRun: (runId: string | null): Promise<boolean> => ipcRenderer.invoke('agent:focusRun', runId),
  adoptActiveRun: (runId: string): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:adoptActiveRun', runId),
  answerQuestion: (response: AgentQuestionResponse): Promise<boolean> => ipcRenderer.invoke('agent:answerQuestion', response),
  stop: (runId: string): Promise<boolean> => ipcRenderer.invoke('agent:stop', runId),
  steer: (request: AgentSteerRequest): Promise<AgentSteerResult> => ipcRenderer.invoke('agent:steer', request),
  stopBackgroundTask: (request: { runId: string; taskId: string }): Promise<BackgroundTaskStopResult> => ipcRenderer.invoke('agent:stopBackgroundTask', request),
  ...eventApi,
  ...remoteApi,
  ...runTracesApi
}

contextBridge.exposeInMainWorld('scry', api)

export type ScryApi = typeof api
