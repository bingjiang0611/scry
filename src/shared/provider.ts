import type { ProviderCompatibilityAdvisory } from './provider-compatibility.js'
import { runtimeProviderForProviderId, type RuntimeProvider } from './runtime.js'
import type { McpLiveStatus } from './trace.js'

export type ProviderId = 'claude' | 'codex' | 'qoder' | 'opencode' | 'pi'
export type SessionProviderId = ProviderId | 'legacy_unknown'
export type ProviderCapability = 'skills' | 'mcp' | 'commands' | 'account'
export type CapabilityMode = 'manage' | 'read' | 'none'
export type CapabilityState = 'ready' | 'degraded' | 'unknown' | 'unsupported'
export type DangerCoverage = 'classified' | 'unsupported'

export function providerDangerCoverage(
  providerId?: ProviderId,
  runtimeProvider?: RuntimeProvider
): DangerCoverage | undefined {
  const resolved = providerId ?? (
    runtimeProvider === 'claude_sdk'
      ? 'claude'
      : runtimeProvider === 'codex_cli'
        ? 'codex'
        : runtimeProvider === 'qoder_cli'
          ? 'qoder'
          : runtimeProvider === 'opencode_server'
            ? 'opencode'
            : runtimeProvider === 'pi_rpc'
              ? 'pi'
              : undefined
  )
  if (!resolved) return undefined
  return resolved === 'claude' || resolved === 'qoder' ? 'classified' : 'unsupported'
}

export interface ProviderContext {
  providerId: ProviderId
  agentProfileId?: string
  cwd?: string
  externalSessionId?: string
}

export interface CatalogHealth {
  status: 'ready' | 'degraded' | 'unavailable'
  source: 'primary' | 'backup' | 'empty'
  reason?: string
}

export interface DeleteSessionResult {
  ok: boolean
  cancelled?: boolean
  reason?: 'invalid_request' | 'active_session' | 'user_cancelled' | 'partial_failure'
  deleted: Array<'recovery journals' | 'database turn outbox' | 'usage' | 'database' | 'attachments' | 'transcripts' | 'catalog'>
  retained: string[]
  failed: Array<{ store: string; error: string }>
}

export interface DeleteArchivedSessionsResult {
  ok: boolean
  cancelled?: boolean
  reason?: 'catalog_unavailable' | 'user_cancelled' | 'partial_failure'
  /** 已完整删除的会话数。 */
  deleted: number
  /** 未删除成功的会话；preview 用于在 UI 里指名，reason 沿用单条删除的原因码。 */
  failures: Array<{ preview: string; reason: NonNullable<DeleteSessionResult['reason']> }>
}

export interface CapabilityEnvelope<T> {
  providerId: ProviderId
  agentProfileId?: string
  cwd?: string
  mode: CapabilityMode
  state: CapabilityState
  data: T | null
  reason?: string
  observedAt?: number
}

export interface ProviderHealth {
  state: 'ready' | 'degraded' | 'unavailable' | 'unknown'
  transport: string
  protocolVersion?: string
  cwd?: string
  pid?: number
  lastOkAt?: number
  lastErrorAt?: number
  lastError?: string
  restarts?: number
}

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  runtimeProvider: RuntimeProvider
  transport: string
  available: boolean
  path?: string
  version?: string
  disabledReason?: string
  /**
   * Provider 本身无法被描述时的原因（adapter 未注册、describe 抛错等）。
   * 与 `disabledReason`（用户主动禁用）语义不同，不得合并。
   */
  unavailableReason?: string
  capabilities: Record<ProviderCapability, CapabilityMode>
  health?: ProviderHealth
  /** CLI 版本兼容性建议（声明性策略，非实测）；缺省表示未评估。 */
  compatibility?: ProviderCompatibilityAdvisory
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  pi: 'Pi'
}

export const PROVIDER_TRANSPORTS: Record<ProviderId, string> = {
  claude: 'Claude Agent SDK',
  codex: 'Codex CLI',
  qoder: 'Qoder Agent SDK',
  opencode: 'OpenCode server',
  pi: 'JSONL RPC subprocess'
}

/**
 * Provider 级的影子快照。
 *
 * 一个已配置却无法描述的 Provider 必须继续出现在列表里并带上原因：直接消失会
 * 让用户以为自己没装过它，这是用沉默冒充事实。能力全部标 `none`、health 标
 * `unavailable`，没有任何字段会被读成「正常但为空」。
 */
export function unavailableProviderDescriptor(args: {
  id: ProviderId
  reason: string
  label?: string
  runtimeProvider?: RuntimeProvider
  transport?: string
  path?: string
  version?: string
}): ProviderDescriptor {
  const transport = args.transport ?? PROVIDER_TRANSPORTS[args.id]
  return {
    id: args.id,
    label: args.label ?? PROVIDER_LABELS[args.id],
    runtimeProvider: args.runtimeProvider ?? runtimeProviderForProviderId(args.id),
    transport,
    available: false,
    unavailableReason: args.reason,
    ...(args.path ? { path: args.path } : {}),
    ...(args.version ? { version: args.version } : {}),
    capabilities: { skills: 'none', mcp: 'none', commands: 'none', account: 'none' },
    health: { state: 'unavailable', transport, lastError: args.reason, lastErrorAt: Date.now() }
  }
}


export interface SkillMeta {
  name: string
  dir: string
  scope: string
  description: string
  enabled: boolean
}

export interface McpMeta {
  targetId?: string
  name: string
  scope: string
  transport: string
  detail: string
  enabled: boolean
}

export interface ProviderCommand {
  name: string
  description: string
  argumentHint?: string
  source?: 'builtin' | 'skill' | 'mcp' | 'custom'
}

export interface McpSnapshot {
  configured: McpMeta[]
  runtime: McpLiveStatus[] | null
  operations?: {
    /** 精确 targetId；只有 Provider 原生 OAuth 流程可由 Scry 驱动时才列入。 */
    authenticate: string[]
  }
}

export interface McpTestResult {
  ok: boolean
  tools?: number
  toolNames?: string[]
  error?: string
}

export interface McpAuthResult {
  ok: boolean
  status: 'authenticated' | 'authenticated-unverified' | 'failed'
  error?: string
}

export function capabilityReady<T>(
  context: ProviderContext,
  mode: Exclude<CapabilityMode, 'none'>,
  data: T,
  observedAt = Date.now()
): CapabilityEnvelope<T> {
  return {
    providerId: context.providerId,
    ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
    cwd: context.cwd,
    mode,
    state: 'ready',
    data,
    observedAt
  }
}

export function capabilityUnavailable<T>(
  context: ProviderContext,
  state: Extract<CapabilityState, 'unknown' | 'unsupported'>,
  reason: string
): CapabilityEnvelope<T> {
  return {
    providerId: context.providerId,
    ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
    cwd: context.cwd,
    mode: 'none',
    state,
    data: null,
    reason
  }
}

export function capabilityUnknown<T>(
  context: ProviderContext,
  mode: Exclude<CapabilityMode, 'none'>,
  reason: string
): CapabilityEnvelope<T> {
  return {
    providerId: context.providerId,
    ...(context.agentProfileId ? { agentProfileId: context.agentProfileId } : {}),
    cwd: context.cwd,
    mode,
    state: 'unknown',
    data: null,
    reason
  }
}
