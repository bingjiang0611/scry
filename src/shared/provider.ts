import type { RuntimeProvider } from './runtime.js'
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
  capabilities: Record<ProviderCapability, CapabilityMode>
  health?: ProviderHealth
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
