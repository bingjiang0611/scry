import type { TraceEvent, ActiveRun, DbStats, Diagnostics, DiffFile } from '@shared/trace'
import type { BillingFixtureImportResult, BillingGuardianState, BillingSyncResult } from '@shared/billing'
import type {
  AgentInputAttachment,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentStartRequest,
  RuntimeProvider
} from '@shared/runtime'
import type {
  AccountSnapshot,
  CapabilityEnvelope,
  McpMeta,
  McpSnapshot,
  McpTestResult,
  ProviderCommand,
  ProviderContext,
  ProviderDescriptor,
  SessionProviderId,
  SkillMeta
} from '@shared/provider'
import type { McpGuardReport } from './components/McpTrustPanel'
import type {
  WorkspaceCreateRequest,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
  WorkspaceListRequest,
  WorkspaceListResult,
  WorkspacePathRequest,
  WorkspaceRenameRequest,
  WorkspaceWriteRequest
} from '@shared/workspace'

export interface DetectedAgent {
  id: string
  name: string
  bin: string
  path: string
  version?: string
  runtimeProvider?: RuntimeProvider
  transport?: string
  capabilities?: ProviderDescriptor['capabilities']
  health?: ProviderDescriptor['health']
}

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

export interface ParsedTurn {
  runId?: string
  userText: string
  attachments?: AgentInputAttachment[]
  items: TraceEvent[]
  done?: boolean
  error?: string
  errorHint?: string
}

export interface ProjectMeta {
  cwd: string
  name: string
  mtime: number
  sessions: SessionMeta[]
}

export type { McpMeta, SkillMeta }

declare global {
  interface Window {
    scry: {
      rendererReady?(): void
      detectFast?(): Promise<DetectedAgent[]>
      detect(): Promise<DetectedAgent[]>
      providerDescriptors(): Promise<ProviderDescriptor[]>
      recentFolders(): Promise<string[]>
      removeRecentFolder(dir: string): Promise<string[]>
      chooseFolder(): Promise<string | null>
      clipboardImage(): Promise<AgentInputAttachment | null>
      workspaceList(request: WorkspaceListRequest): Promise<WorkspaceListResult>
      workspaceRead(request: WorkspacePathRequest): Promise<WorkspaceFileSnapshot>
      workspaceWrite(request: WorkspaceWriteRequest): Promise<WorkspaceFileSnapshot>
      workspaceCreate(request: WorkspaceCreateRequest): Promise<WorkspaceEntry>
      workspaceRename(request: WorkspaceRenameRequest): Promise<WorkspaceEntry>
      workspaceTrash(request: WorkspacePathRequest): Promise<true>
      setCwd(dir: string): Promise<string>
      newSession(context: ProviderContext): Promise<boolean>
      listSessions(context: ProviderContext): Promise<SessionMeta[]>
      listProjects(): Promise<ProjectMeta[]>
      listSkills(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>>
      toggleSkill(context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>>
      mcpSnapshot(context: ProviderContext, refresh?: boolean): Promise<CapabilityEnvelope<McpSnapshot>>
      mcpGuardScan(context: ProviderContext): Promise<CapabilityEnvelope<McpGuardReport>>
      testMcp(context: ProviderContext, name: string): Promise<CapabilityEnvelope<McpTestResult>>
      toggleMcp(context: ProviderContext, name: string, enabled: boolean): Promise<CapabilityEnvelope<boolean>>
      listCommands(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>>
      providerAccount(context: ProviderContext): Promise<CapabilityEnvelope<AccountSnapshot>>
      usageStats(context: ProviderContext): Promise<{ cost: number | null; tin: number | null; tout: number | null; turns: number }>
      stats(): Promise<DbStats>
      billingState(): Promise<BillingGuardianState>
      syncBillingAdmin(): Promise<BillingSyncResult>
      importBillingFixture(): Promise<BillingFixtureImportResult>
      gitDiff(cwd: string): Promise<DiffFile[]>
      diagnostics(): Promise<Diagnostics>
      loadSession(context: ProviderContext): Promise<ParsedTurn[] | null>
      deleteSession(context: Omit<ProviderContext, 'providerId'> & { providerId: SessionProviderId }): Promise<boolean>
      start(request: AgentStartRequest): Promise<{ runId: string }>
      activeRun(): Promise<ActiveRun | null>
      activeRuns(): Promise<ActiveRun[]>
      focusRun(runId: string | null): Promise<boolean>
      adoptActiveRun(runId: string): Promise<ActiveRun | null>
      answerQuestion(response: AgentQuestionResponse): Promise<boolean>
      stop(runId: string): Promise<boolean>
      onTrace(cb: (ev: TraceEvent) => void): () => void
      onTurnDone(cb: (e: { runId: string; sessionId?: string; externalSessionId?: string; providerId?: string; stopped?: boolean }) => void): () => void
      onSession(cb: (e: { runId: string; sessionId: string; previousSessionId?: string; externalSessionId?: string; providerId?: string; pending?: boolean }) => void): () => void
      onQuestion(cb: (request: AgentQuestionRequest) => void): () => void
      onQuestionClosed(cb: (event: { runId: string; questionId: string }) => void): () => void
      onError(cb: (e: { runId: string; message: string; category?: string; hint?: string }) => void): () => void
    }
  }
}

export {}
