import type {
  CapabilityEnvelope,
  McpAuthResult,
  McpSnapshot,
  McpTestResult,
  ProviderCommand,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
  SkillMeta
} from '../../shared/provider'
import type {
  AgentForceKillScope,
  AgentForkLastTurn,
  AgentForkSessionRequest,
  AgentInputAttachment,
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  RuntimeProvider
} from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import type { ParsedTurn } from '../normalize'
import type { CodexHookInspection, CodexHookTrustGrant } from '../codex-hook-trust'
import type { OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'

export interface ProviderRunResult {
  externalSessionId?: string
  providerTurnId?: string
  forkTurnId?: string
  stopped?: boolean
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  recordingFailure?: { message: string }
  mcp?: McpSnapshot
}

export interface ProviderRunHandle {
  promise: Promise<ProviderRunResult>
  interrupt: () => void
  forceKill: () => void
  /**
   * forceKill 实际会杀掉什么。必填：只有 adapter 能证明硬杀仅限于本 run 时
   * 才能写 run_scoped；复用 client/server 的 transport 必须写 shared_transport，
   * 自动停止升级会据此拒绝发出会波及其他 run 的硬杀。
   */
  forceKillScope: AgentForceKillScope
  getExternalSessionId: () => string | undefined
  getProviderTurnId?: () => string | undefined
  getForkTurnId?: () => string | undefined
  getRecordingFailure?: () => { message: string } | undefined
}

export interface AuthorizedMcpExecution {
  cwd: string
  fingerprint: string
  targets: Array<{
    targetId: string
    name: string
    enabled: boolean
    config: Record<string, unknown>
  }>
  env: NodeJS.ProcessEnv
}

export interface McpAuthLoopback {
  redirectUri: string
  waitForCallback(): Promise<string>
  close(): void
}

export interface McpAuthInteraction {
  openExternal(url: string): Promise<void>
  prepareLoopbackCallback(): Promise<McpAuthLoopback>
}

export interface ProviderRunRequest {
  runId: string
  prompt: string
  cwd?: string
  agentProfileId?: string
  resume?: string
  attachments: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode?: AgentPermissionMode
  bypassHookTrust?: boolean
  codexHookTrust?: CodexHookTrustGrant[]
  openCodePluginTrust?: OpenCodeProjectPluginAuthorization
  managedRecorder?: boolean
  managedRecorderIdentity?: { runId: string; promptHash: string }
  mcpExecution?: AuthorizedMcpExecution
  emit: (event: TraceEvent) => void
  onExternalSessionId?: (sessionId: string) => void
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
}

export interface ProviderForkLastTurnRequest extends AgentForkLastTurn {
  sourceSessionId: string
  originalPrompt: string
  cwd?: string
  agentProfileId?: string
  model?: AgentModelRef
  permissionMode?: AgentPermissionMode
  codexHookTrust?: CodexHookTrustGrant[]
  openCodePluginTrust?: OpenCodeProjectPluginAuthorization
  mcpExecution?: AuthorizedMcpExecution
}

export interface ForkLastTurnFacet {
  fork(request: ProviderForkLastTurnRequest): Promise<{ externalSessionId?: string }>
}

export interface ProviderForkSessionRequest extends AgentForkSessionRequest {
  codexHookTrust?: CodexHookTrustGrant[]
  mcpExecution?: AuthorizedMcpExecution
}

export interface ForkSessionFacet {
  fork(request: ProviderForkSessionRequest): Promise<{ externalSessionId?: string }>
}

export interface SkillsFacet {
  list(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>>
}

export interface McpFacet {
  snapshot(
    context: ProviderContext,
    refresh?: boolean,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpSnapshot>>
  test?(
    context: ProviderContext,
    name: string,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpTestResult>>
  reauthenticate?(
    context: ProviderContext,
    targetId: string,
    execution: AuthorizedMcpExecution | undefined,
    interaction: McpAuthInteraction
  ): Promise<CapabilityEnvelope<McpAuthResult>>
}

export interface CommandsFacet {
  list(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>>
}

export interface HookTrustFacet {
  inspect(context: ProviderContext): Promise<CodexHookInspection>
}

export interface RunControlsFacet {
  read(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>>
}

export interface SessionEvidenceFacet {
  enrich(context: ProviderContext, turns: ParsedTurn[]): Promise<ParsedTurn[]>
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly runtimeProvider: RuntimeProvider
  describe(): Promise<ProviderDescriptor>
  run(request: ProviderRunRequest): ProviderRunHandle
  readonly forkLastTurn?: ForkLastTurnFacet
  readonly forkSession?: ForkSessionFacet
  readonly skills?: SkillsFacet
  readonly mcp?: McpFacet
  readonly commands?: CommandsFacet
  readonly hookTrust?: HookTrustFacet
  readonly runControls?: RunControlsFacet
  readonly sessionEvidence?: SessionEvidenceFacet
  invalidateContext?(context: ProviderContext): Promise<void> | void
  dispose?(): Promise<void> | void
}
