import { contextBridge, ipcRenderer } from 'electron'
import type { SourceControlApi } from '../shared/source-control'
import type { ConversationApi, ConversationSummary } from '../shared/conversation-api'
import type { BackgroundTaskStopResult, BackgroundWork } from '../shared/background-work'
import type { RecorderContentPage, RecorderContentPageRequest } from '../shared/tool-content'
import type {
  TraceEvent,
  ActiveRun,
  DbStats,
  WorkspaceDiffResult,
  UsageAnalytics,
  UsageAnalyticsRangeDays,
  UsageStats
} from '../shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '../shared/billing'
import type { RendererPerformanceSample } from '../shared/performance'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../shared/llm-performance'
import type {
  AgentDataUpdated,
  AgentForkSessionRequest,
  AgentForkSessionResult,
  AgentInputAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentStartRequest,
  AgentSteerRequest,
  AgentSteerResult,
  AgentStopState,
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
import type { TraceBacklogState, TraceBatch, TraceBatchReceipt } from '../main/trace-output'
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
import type { RemoteStatus, RemotePairingCode, RemoteDevice } from '../shared/remote'
import type { DesktopRemoteAPI, DesktopHostAccess } from '../shared/desktop-remote'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { ScanReport } from '../cli/mcpguard-core'
import { isMcpGuardReport } from '../shared/mcpguard-report'
import type {
  TerminalDataEvent,
  TerminalRecordingErrorEvent,
  TerminalRecordingRequest,
  TerminalRecordingPage,
  TerminalRecordingListRequest,
  TerminalRecordingListPage,
  TerminalExitEvent,
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
  conversations: {
    create: (cwd: string): ReturnType<ConversationApi['create']> => ipcRenderer.invoke('conversation:create', cwd),
    fork: (request: Parameters<ConversationApi['fork']>[0]): ReturnType<ConversationApi['fork']> => ipcRenderer.invoke('conversation:fork', request),
    previewAdoption: (...args: Parameters<ConversationApi['previewAdoption']>): ReturnType<ConversationApi['previewAdoption']> => ipcRenderer.invoke('conversation:previewAdoption', ...args),
    adopt: (source: Parameters<ConversationApi['adopt']>[0], fingerprint: string): ReturnType<ConversationApi['adopt']> => ipcRenderer.invoke('conversation:adopt', source, fingerprint),
    previewDeletion: (id: string): ReturnType<ConversationApi['previewDeletion']> => ipcRenderer.invoke('conversation:previewDeletion', id),
    delete: (id: string, fingerprint: string): ReturnType<ConversationApi['delete']> => ipcRenderer.invoke('conversation:delete', id, fingerprint),
    update: (id: string, revision: number, change: Parameters<ConversationApi['update']>[2]): ReturnType<ConversationApi['update']> => ipcRenderer.invoke('conversation:update', id, revision, change),
    list: (cwd: string): ReturnType<ConversationApi['list']> => ipcRenderer.invoke('conversation:list', cwd),
    read: (id: string, beforeOrdinal?: number): ReturnType<ConversationApi['read']> => ipcRenderer.invoke('conversation:read', id, beforeOrdinal),
    readItem: (id: string, ref: Parameters<ConversationApi['readItem']>[1]): ReturnType<ConversationApi['readItem']> => ipcRenderer.invoke('conversation:readItem', id, ref),
    preview: (id: string, request: Parameters<ConversationApi['preview']>[1]): ReturnType<ConversationApi['preview']> => ipcRenderer.invoke('conversation:preview', id, request),
    send: (request: Parameters<ConversationApi['send']>[0]): ReturnType<ConversationApi['send']> => ipcRenderer.invoke('conversation:send', request)
  } satisfies ConversationApi,
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
  llmPerformanceHistory: (): Promise<LlmPerformanceHistory> =>
    ipcRenderer.invoke('agent:llmPerformanceHistory'),
  llmPerformanceSummary: (): Promise<LlmPerformanceSummary> =>
    ipcRenderer.invoke('agent:llmPerformanceSummary'),
  billingState: (): Promise<BillingGuardianState> => ipcRenderer.invoke('agent:billingState'),
  syncBillingAdmin: (): Promise<BillingSyncResult> => ipcRenderer.invoke('agent:syncBillingAdmin'),
  importBillingFixture: (): Promise<BillingFixtureImportResult> => ipcRenderer.invoke('agent:importBillingFixture'),
  gitDiff: (cwd: string): Promise<WorkspaceDiffResult> => ipcRenderer.invoke('agent:gitDiff', cwd),
  recorderContentPage: (request: RecorderContentPageRequest): Promise<RecorderContentPage> =>
    ipcRenderer.invoke('agent:recorderContentPage', request),
  // 只拿最近一页：完整历史不作为单个 payload 过 IPC。更早轮次用 loadSessionOlder 取回。
  loadSession: (context: ProviderContext, request?: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSession', context, request),
  loadSessionOlder: (context: ProviderContext, request: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSessionOlder', context, request),
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
  start: (request: AgentStartRequest): Promise<{ runId: string; commandStatus?: 'executed' | 'duplicate'; commandSequence?: number }> =>
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
  onBackgroundWork: (cb: (event: { runId: string; work: BackgroundWork }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { runId: string; work: BackgroundWork }): void => cb(value)
    ipcRenderer.on('agent:backgroundWork', listener)
    return () => ipcRenderer.removeListener('agent:backgroundWork', listener)
  },
  onTrace: (cb: (events: TraceEvent[], receipt: TraceBatchReceipt) => void): (() => void) => {
    // The full batch crosses contextBridge once. Credit is returned by the renderer only after its
    // batched React update commits; merely invoking this callback is not proof of consumption.
    const l = (_: unknown, payload: TraceBatch): void => {
      const receipt = { generation: payload.generation, batchId: payload.batchId, bytes: payload.bytes }
      try {
        cb(payload.events, receipt)
      } catch (error) {
        // An exception means the batch was explicitly rejected rather than queued for a React
        // commit. Return only this fenced receipt so one bad consumer cannot deadlock all future
        // live delivery; canonical run/archive evidence remains authoritative.
        void ipcRenderer.invoke('agent:traceAck', receipt).catch(() => {})
        throw error
      }
    }
    ipcRenderer.on('agent:trace', l)
    return () => ipcRenderer.removeListener('agent:trace', l)
  },
  traceAck: (receipt: TraceBatchReceipt): Promise<boolean> => ipcRenderer.invoke('agent:traceAck', receipt),
  onTraceHealth: (cb: (state: TraceBacklogState) => void): (() => void) => {
    const l = (_: unknown, state: TraceBacklogState): void => cb(state)
    ipcRenderer.on('agent:traceHealth', l)
    return () => ipcRenderer.removeListener('agent:traceHealth', l)
  },
  traceResynchronized: (): Promise<true> => ipcRenderer.invoke('agent:traceResynchronized'),
  onTerminalData: (cb: (event: TerminalDataEvent) => void): (() => void) => {
    const listener = (_: unknown, events: TerminalDataEvent[]): void => {
      for (const event of events) cb(event)
    }
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  onTerminalRecordingError: (cb: (event: TerminalRecordingErrorEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalRecordingErrorEvent): void => cb(event)
    ipcRenderer.on('terminal:recordingError', listener)
    return () => ipcRenderer.removeListener('terminal:recordingError', listener)
  },
  onTerminalExit: (cb: (event: TerminalExitEvent) => void): (() => void) => {
    const listener = (_: unknown, event: TerminalExitEvent): void => cb(event)
    ipcRenderer.on('terminal:exit', listener)
    return () => ipcRenderer.removeListener('terminal:exit', listener)
  },
  onTurnDone: (cb: (e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; stopped?: boolean }): void => cb(e)
    ipcRenderer.on('agent:turnDone', l)
    return () => ipcRenderer.removeListener('agent:turnDone', l)
  },
  onUnreadSessions: (cb: (snapshot: SessionAttentionSnapshot) => void): (() => void) => {
    const listener = (_: unknown, snapshot: SessionAttentionSnapshot): void => cb(snapshot)
    ipcRenderer.on('agent:unreadSessions', listener)
    return () => ipcRenderer.removeListener('agent:unreadSessions', listener)
  },
  onStopState: (cb: (state: AgentStopState) => void): (() => void) => {
    const l = (_: unknown, state: AgentStopState): void => cb(state)
    ipcRenderer.on('agent:stopState', l)
    return () => ipcRenderer.removeListener('agent:stopState', l)
  },
  onDataUpdated: (cb: (e: AgentDataUpdated) => void): (() => void) => {
    const l = (_: unknown, e: AgentDataUpdated): void => cb(e)
    ipcRenderer.on('agent:dataUpdated', l)
    return () => ipcRenderer.removeListener('agent:dataUpdated', l)
  },
  onSession: (cb: (e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; pending?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; agentProfileId?: string; pending?: boolean }): void => cb(e)
    ipcRenderer.on('agent:session', l)
    return () => ipcRenderer.removeListener('agent:session', l)
  },
  onFocusedRun: (cb: (run: ActiveRun) => void): (() => void) => {
    const l = (_: unknown, run: ActiveRun): void => cb(run)
    ipcRenderer.on('agent:focusedRun', l)
    return () => ipcRenderer.removeListener('agent:focusedRun', l)
  },
  // A device-initiated (remote) run just wrote an AppSession into the catalog.
  // This is a refresh hint only (no active-run semantics), so the Mac session
  // list shows the phone's conversation live without corrupting local run state.
  onRemoteSessionRecorded: (cb: (e: { cwd: string }) => void): (() => void) => {
    const l = (_: unknown, e: { cwd: string }): void => cb(e)
    ipcRenderer.on('remote:sessionRecorded', l)
    return () => ipcRenderer.removeListener('remote:sessionRecorded', l)
  },
  onQuestion: (cb: (request: AgentQuestionRequest) => void): (() => void) => {
    const l = (_: unknown, request: AgentQuestionRequest): void => cb(request)
    ipcRenderer.on('agent:userQuestion', l)
    return () => ipcRenderer.removeListener('agent:userQuestion', l)
  },
  onQuestionAttention: (cb: (event: { runId: string; pendingCount: number }) => void): (() => void) => {
    const l = (_: unknown, event: { runId: string; pendingCount: number }): void => cb(event)
    ipcRenderer.on('agent:questionAttention', l)
    return () => ipcRenderer.removeListener('agent:questionAttention', l)
  },
  onQuestionClosed: (cb: (event: { runId: string; questionId: string }) => void): (() => void) => {
    const l = (_: unknown, event: { runId: string; questionId: string }): void => cb(event)
    ipcRenderer.on('agent:userQuestionClosed', l)
    return () => ipcRenderer.removeListener('agent:userQuestionClosed', l)
  },
  onError: (cb: (e: { runId: string; message: string; category?: string; hint?: string }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; message: string; category?: string; hint?: string }): void => cb(e)
    ipcRenderer.on('agent:error', l)
    return () => ipcRenderer.removeListener('agent:error', l)
  },
  desktopRemote: {
    workbench: (id, request) => ipcRenderer.invoke('desktopRemote:workbench', id, request),
    list: () => ipcRenderer.invoke('desktopRemote:list'),
    pair: (input) => ipcRenderer.invoke('desktopRemote:pair', input),
    finishPairing: (id) => ipcRenderer.invoke('desktopRemote:finishPairing', id),
    updateSsh: (id, ssh) => ipcRenderer.invoke('desktopRemote:updateSsh', id, ssh),
    connect: (id) => ipcRenderer.invoke('desktopRemote:connect', id),
    disconnect: (id) => ipcRenderer.invoke('desktopRemote:disconnect', id),
    forget: (id) => ipcRenderer.invoke('desktopRemote:forget', id),
    catalog: (id) => ipcRenderer.invoke('desktopRemote:catalog', id),
    providerControls: (id, context) => ipcRenderer.invoke('desktopRemote:providerControls', id, context),
    commands: (id, context) => ipcRenderer.invoke('desktopRemote:commands', id, context),
    sessionAction: (id, context, action) => ipcRenderer.invoke('desktopRemote:sessionAction', id, context, action),
    forkSession: (id, request) => ipcRenderer.invoke('desktopRemote:forkSession', id, request),
    deleteSession: (id, request) => ipcRenderer.invoke('desktopRemote:deleteSession', id, request),
    directories: (id, path, cursor, snapshot) => ipcRenderer.invoke('desktopRemote:directories', id, path, cursor, snapshot),
    selectDirectory: (id, path) => ipcRenderer.invoke('desktopRemote:selectDirectory', id, path),
    history: (id, context, before, snapshot) => ipcRenderer.invoke('desktopRemote:history', id, context, before, snapshot),
    trace: (id, context, runId, knownAttachmentCount?: number) => ipcRenderer.invoke('desktopRemote:trace', id, context, runId, knownAttachmentCount),
    intents: (id) => ipcRenderer.invoke('desktopRemote:intents', id),
    submit: (id, input) => ipcRenderer.invoke('desktopRemote:submit', id, input),
    intentStatus: (id, intentId) => ipcRenderer.invoke('desktopRemote:intentStatus', id, intentId),
    resolveIntent: (id, intentId) => ipcRenderer.invoke('desktopRemote:resolveIntent', id, intentId),
    runStatus: (id, runId) => ipcRenderer.invoke('desktopRemote:runStatus', id, runId),
    liveRun: (id, context) => ipcRenderer.invoke('desktopRemote:liveRun', id, context),
    stop: (id, runId) => ipcRenderer.invoke('desktopRemote:stop', id, runId),
    answer: (id, runId, response) => ipcRenderer.invoke('desktopRemote:answer', id, runId, response),
    files: (id, context, path, cursor) => ipcRenderer.invoke('desktopRemote:files', id, context, path, cursor),
    file: (id, context, path, offset, snapshot) => ipcRenderer.invoke('desktopRemote:file', id, context, path, offset, snapshot)
  } satisfies DesktopRemoteAPI,
  remoteDesktopHostStatus: (): Promise<DesktopHostAccess> => ipcRenderer.invoke('remote:desktop:status'),
  remoteDesktopHostInvite: (): Promise<string> => ipcRenderer.invoke('remote:desktop:invite'),
  remoteDesktopHostDisable: (): Promise<void> => ipcRenderer.invoke('remote:desktop:disable'),
  // Trusted-LOCAL remote-access pairing (Mac's own UI only).
  remoteStatus: (): Promise<RemoteStatus> => ipcRenderer.invoke('remote:status'),
  remoteBeginPairing: (): Promise<RemotePairingCode> => ipcRenderer.invoke('remote:pairing:begin'),
  remoteConfirmPairing: (pairingId: string, expectedPublicKeySHA256: string): Promise<RemoteDevice> =>
    ipcRenderer.invoke('remote:pairing:confirm', pairingId, expectedPublicKeySHA256),
  remoteCancelPairing: (pairingId: string): Promise<void> => ipcRenderer.invoke('remote:pairing:cancel', pairingId),
  remoteRevokeDevice: (deviceId: string): Promise<void> => ipcRenderer.invoke('remote:device:revoke', deviceId)
}

contextBridge.exposeInMainWorld('scry', api)

export type ScryApi = typeof api
