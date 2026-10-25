import { ipcRenderer } from 'electron'
import type { DetectedAgent, ProjectMeta, SessionMeta, SessionRef } from './index'
import type { BackgroundTaskStopResult, BackgroundWork } from '../shared/background-work'
import type { RecorderContentPage, RecorderContentPageRequest } from '../shared/tool-content'
import type { TraceEvent, ActiveRun, DbStats, WorkspaceDiffResult, UsageAnalytics, UsageAnalyticsRangeDays, UsageStats } from '../shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '../shared/billing'
import type { LlmPerformanceHistory, LlmPerformanceSummary } from '../shared/llm-performance'
import type { AgentForkSessionRequest, AgentForkSessionResult, AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, AgentRunControlCatalog, AgentStartRequest, AgentSteerRequest, AgentSteerResult, AgentStopState, AgentDataUpdated } from '../shared/runtime'
import type { CatalogHealth, CapabilityEnvelope, DeleteArchivedSessionsResult, DeleteSessionResult, McpAuthResult, McpSnapshot, McpTestResult, ProviderCommand, ProviderContext, ProviderDescriptor, SessionProviderId, SkillMeta } from '../shared/provider'
import type { SessionHistoryPage, SessionHistoryPageRequest } from '../main/session-history'
import type { TraceBacklogState, TraceBatch, TraceBatchReceipt } from '../main/trace-output'
import type { SessionAttentionSnapshot } from '../shared/session-attention'
import type { ScanReport } from '../cli/mcpguard-core'
import { isMcpGuardReport } from '../shared/mcpguard-report'

export const agentApi = {
  detectFast: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detectFast'),
  detect: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detect'),
  addPiProfile: (): Promise<DetectedAgent | null> => ipcRenderer.invoke('agent:addPiProfile'),
  removePiProfile: (id: string): Promise<true> => ipcRenderer.invoke('agent:removePiProfile', id),
  providerDescriptors: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke('agent:providerDescriptors'),
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('agent:recentFolders'),
  removeRecentFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('agent:removeRecentFolder', dir),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('agent:chooseFolder'),
  clipboardImage: (): Promise<AgentInputAttachment | null> => ipcRenderer.invoke('agent:clipboardImage'),
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
}
