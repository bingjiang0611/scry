import { contextBridge, ipcRenderer } from 'electron'
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
import type { TraceBacklogState, TraceBatch } from '../main/trace-output'
import type {
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
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
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSessionInfo,
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
export type { TraceBacklogState }

const api = {
  rendererReady: (): void => ipcRenderer.send('app:rendererReady'),
  setTheme: (theme: 'dark' | 'light'): Promise<true> => ipcRenderer.invoke('app:setTheme', theme),
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
  workspaceRead: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:read', request),
  workspaceReadKnown: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:readKnown', request),
  workspaceOpenExternal: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:openExternal', request),
  workspaceOpenKnownExternal: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:openKnownExternal', request),
  workspaceWrite: (request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:write', request),
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:create', request),
  workspaceRename: (request: WorkspaceRenameRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:rename', request),
  workspaceMove: (request: WorkspaceMoveRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:move', request),
  workspaceTrash: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:trash', request),
  terminalStart: (request: TerminalStartRequest): Promise<TerminalSessionInfo> => ipcRenderer.invoke('terminal:start', request),
  terminalWrite: (id: string, data: string): Promise<true> => ipcRenderer.invoke('terminal:write', { id, data }),
  terminalResize: (id: string, cols: number, rows: number): Promise<true> => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  terminalReady: (id: string): Promise<true> => ipcRenderer.invoke('terminal:ready', { id }),
  terminalAck: (id: string, bytes: number): Promise<true> => ipcRenderer.invoke('terminal:ack', { id, bytes }),
  terminalClose: (id: string): Promise<true> => ipcRenderer.invoke('terminal:close', { id }),
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
  billingState: (): Promise<BillingGuardianState> => ipcRenderer.invoke('agent:billingState'),
  syncBillingAdmin: (): Promise<BillingSyncResult> => ipcRenderer.invoke('agent:syncBillingAdmin'),
  importBillingFixture: (): Promise<BillingFixtureImportResult> => ipcRenderer.invoke('agent:importBillingFixture'),
  gitDiff: (cwd: string): Promise<DiffFile[]> => ipcRenderer.invoke('agent:gitDiff', cwd),
  // 只拿最近一页：完整历史不作为单个 payload 过 IPC。更早轮次用 loadSessionOlder 取回。
  loadSession: (context: ProviderContext, request?: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSession', context, request),
  loadSessionOlder: (context: ProviderContext, request: SessionHistoryPageRequest): Promise<SessionHistoryPage | null> =>
    ipcRenderer.invoke('agent:loadSessionOlder', context, request),
  deleteSession: (context: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke('agent:deleteSession', context),
  setSessionPinned: (context: SessionRef, pinned: boolean): Promise<boolean> =>
    ipcRenderer.invoke('agent:setSessionPinned', context, pinned),
  setSessionArchived: (context: SessionRef, archived: boolean): Promise<boolean> =>
    ipcRenderer.invoke('agent:setSessionArchived', context, archived),
  deleteArchivedSessions: (): Promise<DeleteArchivedSessionsResult> => ipcRenderer.invoke('agent:deleteArchivedSessions'),
  start: (request: AgentStartRequest): Promise<{ runId: string }> => ipcRenderer.invoke('agent:start', request),
  activeRun: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:activeRun'),
  /** 权威事件快照（忽略 done）：live trace 降级后用它重新对齐，包含终态被跳过的事件。 */
  focusedRunSnapshot: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:focusedRunSnapshot'),
  activeRuns: (): Promise<ActiveRun[]> => ipcRenderer.invoke('agent:activeRuns'),
  focusRun: (runId: string | null): Promise<boolean> => ipcRenderer.invoke('agent:focusRun', runId),
  adoptActiveRun: (runId: string): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:adoptActiveRun', runId),
  answerQuestion: (response: AgentQuestionResponse): Promise<boolean> => ipcRenderer.invoke('agent:answerQuestion', response),
  stop: (runId: string): Promise<boolean> => ipcRenderer.invoke('agent:stop', runId),
  onTrace: (cb: (ev: TraceEvent) => void): (() => void) => {
    // main 合批发数组（性能）→ 这里拆回逐条 cb，渲染侧契约不变（仍是「每事件一次 cb」）。
    // 分发完成后回 ACK：main 用它做有界背压，绝不因此丢弃或重排事件。
    const l = (_: unknown, payload: TraceBatch): void => {
      try {
        for (const ev of payload.events) cb(ev)
      } finally {
        ipcRenderer.invoke('agent:traceAck', { bytes: payload.bytes }).catch(() => {
          // main 已退出或窗口正在销毁时 ACK 失败不影响证据；归档仍是权威来源。
        })
      }
    }
    ipcRenderer.on('agent:trace', l)
    return () => ipcRenderer.removeListener('agent:trace', l)
  },
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
  onStopState: (cb: (state: AgentStopState) => void): (() => void) => {
    const l = (_: unknown, state: AgentStopState): void => cb(state)
    ipcRenderer.on('agent:stopState', l)
    return () => ipcRenderer.removeListener('agent:stopState', l)
  },
  onDataUpdated: (cb: (e: { runId: string }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string }): void => cb(e)
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
  onQuestion: (cb: (request: AgentQuestionRequest) => void): (() => void) => {
    const l = (_: unknown, request: AgentQuestionRequest): void => cb(request)
    ipcRenderer.on('agent:userQuestion', l)
    return () => ipcRenderer.removeListener('agent:userQuestion', l)
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
  }
}

contextBridge.exposeInMainWorld('scry', api)

export type ScryApi = typeof api
