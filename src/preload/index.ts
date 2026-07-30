import { contextBridge, ipcRenderer } from 'electron'
import type { TraceEvent, ActiveRun, DbStats, Diagnostics, DiffFile } from '../shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '../shared/billing'
import type {
  AgentInputAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentStartRequest,
  RuntimeProvider
} from '../shared/runtime'
import type {
  AccountSnapshot,
  CapabilityEnvelope,
  McpSnapshot,
  McpTestResult,
  ProviderCommand,
  ProviderContext,
  ProviderDescriptor,
  SessionProviderId,
  SkillMeta
} from '../shared/provider'
import type { DetectedAgent } from '../main/claude-locate'
import type { ParsedTurn } from '../main/normalize'
import type {
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '../shared/workspace'

export interface SessionMeta {
  sessionId: string
  runId?: string
  externalSessionId?: string
  pending?: boolean
  providerId: SessionProviderId
  runtimeProvider?: RuntimeProvider
  mtime: number
  preview: string
  count: number
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
}

const api = {
  rendererReady: (): void => ipcRenderer.send('app:rendererReady'),
  detectFast: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detectFast'),
  detect: (): Promise<DetectedAgent[]> => ipcRenderer.invoke('agent:detect'),
  providerDescriptors: (): Promise<ProviderDescriptor[]> => ipcRenderer.invoke('agent:providerDescriptors'),
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('agent:recentFolders'),
  removeRecentFolder: (dir: string): Promise<string[]> => ipcRenderer.invoke('agent:removeRecentFolder', dir),
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke('agent:chooseFolder'),
  clipboardImage: (): Promise<AgentInputAttachment | null> => ipcRenderer.invoke('agent:clipboardImage'),
  workspaceList: (request: WorkspaceListRequest): Promise<WorkspaceListResult> => ipcRenderer.invoke('workspace:list', request),
  workspaceRead: (request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:read', request),
  workspaceWrite: (request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot> => ipcRenderer.invoke('workspace:write', request),
  workspaceCreate: (request: WorkspaceCreateRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:create', request),
  workspaceRename: (request: WorkspaceRenameRequest): Promise<WorkspaceEntry> => ipcRenderer.invoke('workspace:rename', request),
  workspaceTrash: (request: WorkspacePathRequest): Promise<true> => ipcRenderer.invoke('workspace:trash', request),
  setCwd: (dir: string): Promise<string> => ipcRenderer.invoke('agent:setCwd', dir),
  newSession: (context: ProviderContext): Promise<boolean> => ipcRenderer.invoke('agent:newSession', context),
  listSessions: (context: ProviderContext): Promise<SessionMeta[]> => ipcRenderer.invoke('agent:listSessions', context),
  listProjects: (): Promise<ProjectMeta[]> => ipcRenderer.invoke('agent:listProjects'),
  listSkills: (context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>> => ipcRenderer.invoke('agent:listSkills', context),
  toggleSkill: (context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>> =>
    ipcRenderer.invoke('agent:toggleSkill', { context, name, enabled }),
  mcpSnapshot: (context: ProviderContext, refresh = false): Promise<CapabilityEnvelope<McpSnapshot>> =>
    ipcRenderer.invoke('agent:mcpSnapshot', { context, refresh }),
  mcpGuardScan: (context: ProviderContext): Promise<CapabilityEnvelope<unknown>> => ipcRenderer.invoke('agent:mcpGuardScan', context),
  testMcp: (context: ProviderContext, name: string): Promise<CapabilityEnvelope<McpTestResult>> =>
    ipcRenderer.invoke('agent:testMcp', { context, name }),
  toggleMcp: (context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>> =>
    ipcRenderer.invoke('agent:toggleMcp', { context, name, enabled }),
  listCommands: (context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>> =>
    ipcRenderer.invoke('agent:listCommands', context),
  providerAccount: (context: ProviderContext): Promise<CapabilityEnvelope<AccountSnapshot>> =>
    ipcRenderer.invoke('agent:providerAccount', context),
  usageStats: (context: ProviderContext): Promise<{ cost: number | null; tin: number | null; tout: number | null; turns: number }> =>
    ipcRenderer.invoke('agent:usageStats', context),
  stats: (): Promise<DbStats> => ipcRenderer.invoke('agent:stats'),
  billingState: (): Promise<BillingGuardianState> => ipcRenderer.invoke('agent:billingState'),
  syncBillingAdmin: (): Promise<BillingSyncResult> => ipcRenderer.invoke('agent:syncBillingAdmin'),
  importBillingFixture: (): Promise<BillingFixtureImportResult> => ipcRenderer.invoke('agent:importBillingFixture'),
  gitDiff: (cwd: string): Promise<DiffFile[]> => ipcRenderer.invoke('agent:gitDiff', cwd),
  diagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke('agent:diagnostics'),
  loadSession: (context: ProviderContext): Promise<ParsedTurn[] | null> => ipcRenderer.invoke('agent:loadSession', context),
  deleteSession: (context: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }): Promise<boolean> =>
    ipcRenderer.invoke('agent:deleteSession', context),
  start: (request: AgentStartRequest): Promise<{ runId: string }> => ipcRenderer.invoke('agent:start', request),
  activeRun: (): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:activeRun'),
  activeRuns: (): Promise<ActiveRun[]> => ipcRenderer.invoke('agent:activeRuns'),
  focusRun: (runId: string | null): Promise<boolean> => ipcRenderer.invoke('agent:focusRun', runId),
  adoptActiveRun: (runId: string): Promise<ActiveRun | null> => ipcRenderer.invoke('agent:adoptActiveRun', runId),
  answerQuestion: (response: AgentQuestionResponse): Promise<boolean> => ipcRenderer.invoke('agent:answerQuestion', response),
  stop: (runId: string): Promise<boolean> => ipcRenderer.invoke('agent:stop', runId),
  onTrace: (cb: (ev: TraceEvent) => void): (() => void) => {
    // main 合批发数组（性能）→ 这里拆回逐条 cb，渲染侧契约不变（仍是「每事件一次 cb」）
    const l = (_: unknown, evs: TraceEvent[]): void => {
      for (const ev of evs) cb(ev)
    }
    ipcRenderer.on('agent:trace', l)
    return () => ipcRenderer.removeListener('agent:trace', l)
  },
  onTurnDone: (cb: (e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string }): void => cb(e)
    ipcRenderer.on('agent:turnDone', l)
    return () => ipcRenderer.removeListener('agent:turnDone', l)
  },
  onSession: (cb: (e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; pending?: boolean }) => void): (() => void) => {
    const l = (_: unknown, e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; pending?: boolean }): void => cb(e)
    ipcRenderer.on('agent:session', l)
    return () => ipcRenderer.removeListener('agent:session', l)
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
