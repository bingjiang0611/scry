import type { ProviderCompatibilityAdvisory } from './provider-compatibility.js'
import { runtimeProviderForProviderId, type RuntimeProvider } from './runtime.js'
import type { McpLiveStatus } from './trace.js'

export type ProviderId = 'claude' | 'codex' | 'qoder' | 'opencode' | 'pi' | 'antigravity'
export type SessionProviderId = ProviderId | 'legacy_unknown'
export type ProviderCapability = 'skills' | 'mcp' | 'commands' | 'account'

export const MCP_LIVE_CHECK_CANCEL: Record<ProviderId, { cancellable: true } | { cancellable: false; reason: string }> = {
  claude: { cancellable: true },
  qoder: { cancellable: true },
  codex: { cancellable: false, reason: 'Codex 的 MCP 检测在共享的 app-server 里运行，不能单独取消' },
  opencode: { cancellable: false, reason: 'OpenCode 的 MCP 检测在共享的 OpenCode server 里运行，不能单独取消' },
  pi: { cancellable: false, reason: 'Pi 没有 MCP 运行状态接口，只读取快照' },
  antigravity: { cancellable: false, reason: 'Antigravity 的 MCP 运行状态仅读取配置快照，不单独发起探活' }
}

export const MCP_CHECK_CANCELLED = '已取消检测；没有取得 MCP 运行状态'
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
              : runtimeProvider === 'antigravity_acp'
                ? 'antigravity'
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
  reason?: 'invalid_request' | 'active_session' | 'user_cancelled' | 'partial_failure' | 'unavailable'
  deleted: Array<'recovery journals' | 'database turn outbox' | 'usage' | 'database' | 'attachments' | 'transcripts' | 'catalog'>
  retained: string[]
  failed: Array<{ store: string; error: string }>
}

export interface DeleteArchivedProgress {
  done: number
  total: number
  failed: number
}

export interface DeleteArchivedSessionsResult {
  ok: boolean
  cancelled?: boolean
  reason?: 'catalog_unavailable' | 'catalog_changed' | 'user_cancelled' | 'partial_failure'
  deleted: number
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
  unavailableReason?: string
  capabilities: Record<ProviderCapability, CapabilityMode>
  accountNote?: string
  health?: ProviderHealth
  compatibility?: ProviderCompatibilityAdvisory
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  pi: 'Pi',
  antigravity: 'Antigravity'
}

export const PROVIDER_TRANSPORTS: Record<ProviderId, string> = {
  claude: 'Claude Agent SDK',
  codex: 'Codex CLI',
  qoder: 'Qoder Agent SDK',
  opencode: 'OpenCode server',
  pi: 'JSONL RPC subprocess',
  antigravity: 'ACP (stdio)'
}

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
