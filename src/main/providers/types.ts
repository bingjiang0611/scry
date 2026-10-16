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
  AgentSteerInput,
  AgentSteerResult,
  RuntimeProvider
} from '../../shared/runtime'
import type { TraceEvent } from '../../shared/trace'
import type { ParsedTurn } from '../normalize'
import type { BackgroundTaskStopResult } from '../../shared/background-work'
import type { CodexHookInspection, CodexHookTrustGrant } from '../codex-hook-trust'
import type { OpenCodeProjectPluginAuthorization } from '../opencode-plugin-trust'

/** Main-owned history body. This is not a renderer-supplied prompt override. */
export interface ProviderHistoricalContext {
  text: string
  contentHash: string
}

/**
 * Input acceptance is independent of execution success and conversation coverage.
 * textHash covers outgoing text only, not images, Skill metadata, or run controls.
 * contextHash=null means no imported history, not an empty-history hash.
 */
export type ProviderInputReceipt = { contextHash: string | null } & (
  | { status: 'not_sent'; reason: string }
  | { status: 'unknown'; textHash: string; reason: string }
  | {
      status: 'accepted'
      textHash: string
      nativeSessionId: string
      providerTurnId?: string
      source: 'claude_sdk_success_result' | 'codex_turn_start_response' | 'pi_persisted_session_entry'
    }
)

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
  stopBackgroundTask?: (taskId: string) => Promise<BackgroundTaskStopResult>
  /** Present only for native non-interrupting, active-run message admission. */
  steer?: (input: AgentSteerInput) => Promise<AgentSteerResult>
  /**
   * forceKill 实际会杀掉什么。必填：只有 adapter 能证明硬杀仅限于本 run 时
   * 才能写 run_scoped；复用 client/server 的 transport 必须写 shared_transport，
   * 自动停止升级会据此拒绝发出会波及其他 run 的硬杀。
   */
  forceKillScope: AgentForceKillScope
  getExternalSessionId: () => string | undefined
  getProviderTurnId?: () => string | undefined
  getForkTurnId?: () => string | undefined
  /**
   * Live snapshot, not permission to settle a conversation before run/archive convergence.
   * Remains readable after rejection; a rejected promise does not prove not_sent.
   */
  getInputReceipt?: () => ProviderInputReceipt | undefined
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
  /** Original input for native command / Skill dispatch, without historical context. */
  prompt: string
  historicalContext?: ProviderHistoricalContext
  /** Main opt-in for native receipts on first / history-free inputs as well. */
  trackInputReceipt?: true
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
  /** Frozen by preview and revalidated at the adapter's actual transport boundary. */
  expectedContinuationKey?: string
  /** Frozen plain-text input contract; reject native rewrites before dispatch. */
  expectedInputTextHash?: string
  mcpExecution?: AuthorizedMcpExecution
  emit: (event: TraceEvent) => void
  /**
   * 把 Provider 原样发来的消息写进双流事件日志。只有真正拥有原生事件流的 adapter 才会
   * 调用它；没有调用就表示该 Provider 这一轮没有可观测的原生流，而不是流是空的。
   */
  recordNative?: (type: string, payload: unknown) => void
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
  openCodePluginTrust?: OpenCodeProjectPluginAuthorization
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
  /**
   * Stable identity of the actual transport/auth home used by run(). The key is
   * opaque and may be conservative (a credential refresh can require fresh
   * confirmation); it must never be inferred from a display label or model.
   */
  continuationKey?(context: ProviderContext): Promise<string> | string
  describe(): Promise<ProviderDescriptor>
  run(request: ProviderRunRequest): ProviderRunHandle
  /** Opt in after history wire input and native receipts (including ordinary input) are implemented. */
  readonly historicalContext?: true
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
