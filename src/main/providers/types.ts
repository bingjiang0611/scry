import type {
  AccountSnapshot,
  CapabilityEnvelope,
  McpSnapshot,
  McpTestResult,
  ProviderCommand,
  ProviderContext,
  ProviderDescriptor,
  ProviderId,
  SkillMeta
} from '../../shared/provider'
import type { AgentInputAttachment, AgentQuestionRequest, AgentQuestionResponse, RuntimeProvider } from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'

export interface ProviderRunResult {
  externalSessionId?: string
  stopped?: boolean
  mcp?: McpSnapshot
}

export interface ProviderRunHandle {
  promise: Promise<ProviderRunResult>
  interrupt: () => void
  getExternalSessionId: () => string | undefined
}

export interface ProviderRunRequest {
  runId: string
  prompt: string
  cwd?: string
  resume?: string
  attachments: AgentInputAttachment[]
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
  snapshot(context: ProviderContext, refresh?: boolean): Promise<CapabilityEnvelope<McpSnapshot>>
  setEnabled?(
    context: ProviderContext,
    name: string,
    enabled: boolean
  ): Promise<CapabilityEnvelope<boolean>>
  test?(context: ProviderContext, name: string): Promise<CapabilityEnvelope<McpTestResult>>
}

export interface CommandsFacet {
  list(context: ProviderContext): Promise<CapabilityEnvelope<ProviderCommand[]>>
}

export interface AccountFacet {
  read(context: ProviderContext): Promise<CapabilityEnvelope<AccountSnapshot>>
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
  dispose?(): Promise<void> | void
}
