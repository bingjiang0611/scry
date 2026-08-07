import type {
  AccountSnapshot,
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
  AgentInputAttachment,
  AgentModelRef,
  AgentPermissionMode,
  AgentQuestionRequest,
  AgentQuestionResponse,
  AgentRunControlCatalog,
  RuntimeProvider
} from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import type { CodexHookInspection, CodexHookTrustGrant } from '../codex-hook-trust'

export interface ProviderRunResult {
  externalSessionId?: string
  providerTurnId?: string
  stopped?: boolean
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted'
  mcp?: McpSnapshot
}

export interface ProviderRunHandle {
  promise: Promise<ProviderRunResult>
  interrupt: () => void
  getExternalSessionId: () => string | undefined
  getProviderTurnId?: () => string | undefined
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
  resume?: string
  attachments: AgentInputAttachment[]
  model?: AgentModelRef
  effort?: string
  permissionMode?: AgentPermissionMode
  bypassHookTrust?: boolean
  codexHookTrust?: CodexHookTrustGrant[]
  managedRecorder?: boolean
  mcpExecution?: AuthorizedMcpExecution
  emit: (event: TraceEvent) => void
  onExternalSessionId?: (sessionId: string) => void
  requestUserInput?: (request: AgentQuestionRequest, signal: AbortSignal) => Promise<AgentQuestionResponse>
}

export interface SkillsFacet {
  list(context: ProviderContext): Promise<CapabilityEnvelope<SkillMeta[]>>
  setEnabled?(
    context: ProviderContext,
    name: string,
    enabled: boolean
  ): Promise<CapabilityEnvelope<boolean>>
}

export interface McpFacet {
  snapshot(
    context: ProviderContext,
    refresh?: boolean,
    execution?: AuthorizedMcpExecution
  ): Promise<CapabilityEnvelope<McpSnapshot>>
  setEnabled?(
    context: ProviderContext,
    name: string,
    enabled: boolean
  ): Promise<CapabilityEnvelope<boolean>>
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

export interface AccountFacet {
  read(context: ProviderContext): Promise<CapabilityEnvelope<AccountSnapshot>>
}

export interface HookTrustFacet {
  inspect(context: ProviderContext): Promise<CodexHookInspection>
}

export interface RunControlsFacet {
  read(context: ProviderContext): Promise<CapabilityEnvelope<AgentRunControlCatalog>>
}

export interface ProviderAdapter {
  readonly id: ProviderId
  readonly runtimeProvider: RuntimeProvider
  describe(): Promise<ProviderDescriptor>
  run(request: ProviderRunRequest): ProviderRunHandle
  readonly skills?: SkillsFacet
  readonly mcp?: McpFacet
  readonly commands?: CommandsFacet
  readonly account?: AccountFacet
  readonly hookTrust?: HookTrustFacet
  readonly runControls?: RunControlsFacet
  dispose?(): Promise<void> | void
}
