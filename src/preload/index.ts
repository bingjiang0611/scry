import { contextBridge, ipcRenderer } from 'electron'
import type { BackgroundTaskStopResult, BackgroundWork } from '../shared/background-work'
import type { RecorderContentPage, RecorderContentPageRequest } from '../shared/tool-content'
import type {
  TraceEvent,
  ActiveRun,
  DbStats,
  DiffFile,
  UsageAnalytics,
  UsageAnalyticsRangeDays,
  UsageStats
} from '../shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '../shared/billing'
import type { RendererPerformanceSample } from '../shared/performance'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../shared/llm-performance'
import type {
  AgentForkSessionRequest,
  AgentForkSessionResult,
  AgentInputAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  AgentStartRequest,
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
}

export type ParsedTurn = LoadedSessionTurn
export type { SessionHistoryPage, SessionHistoryPageRequest }
export type { TraceBacklogState, TraceBatchReceipt }

const api = {
  rendererReady: (): void => ipcRenderer.send('app:rendererReady'),
  setTheme: (theme: 'dark' | 'light'): Promise<true> => ipcRenderer.invoke('app:setTheme', theme),
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
  gitDiff: (cwd: string): Promise<DiffFile[]> => ipcRenderer.invoke('agent:gitDiff', cwd),
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
  start: (request: AgentStartRequest): Promise<{ runId: string }> => ipcRenderer.invoke('agent:start', request),
  activeRun: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:activeRun'),
  unreadSessions: (): Promise<SessionAttentionSnapshot> => ipcRenderer.invoke('agent:unreadSessions'),
  /** 权威事件快照（忽略 done）：live trace 降级后用它重新对齐，包含终态被跳过的事件。 */
  focusedRunSnapshot: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:focusedRunSnapshot'),
  activeRuns: (): Promise<ActiveRun[]> => ipcRenderer.invoke('agent:activeRuns'),
  focusRun: (runId: string | null): Promise<boolean> => ipcRenderer.invoke('agent:focusRun', runId),
  adoptActiveRun: (runId: string): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:adoptActiveRun', runId),
  answerQuestion: (response: AgentQuestionResponse): Promise<boolean> => ipcRenderer.invoke('agent:answerQuestion', response),
  stop: (runId: string): Promise<boolean> => ipcRenderer.invoke('agent:stop', runId),
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
  onDataUpdated: (cb: (e: { runId: string; kind?: 'turn_recorded' | 'session_deleted' }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; kind?: 'turn_recorded' | 'session_deleted' }): void => cb(e)
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
