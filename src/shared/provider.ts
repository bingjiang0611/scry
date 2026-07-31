import type { RuntimeProvider } from './runtime.js'
import type { McpLiveStatus } from './trace.js'

export type ProviderId = 'claude' | 'codex' | 'qoder' | 'opencode'
export type SessionProviderId = ProviderId | 'legacy_unknown'
export type ProviderCapability = 'skills' | 'mcp' | 'commands' | 'account'
export type CapabilityMode = 'manage' | 'read' | 'none'
export type CapabilityState = 'ready' | 'degraded' | 'unknown' | 'unsupported'

export interface ProviderContext {
  providerId: ProviderId
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
  deleted: Array<'recovery journals' | 'usage' | 'database' | 'attachments' | 'transcripts' | 'catalog'>
  retained: string[]
  failed: Array<{ store: string; error: string }>
}

export interface CapabilityEnvelope<T> {
  providerId: ProviderId
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
}

export interface McpTestResult {
  ok: boolean
  tools?: number
  toolNames?: string[]
  error?: string
}

export interface AccountSnapshot {
  accountLabel?: string
  plan?: string
  usage?: unknown
}

export function capabilityReady<T>(
  context: ProviderContext,
  mode: Exclude<CapabilityMode, 'none'>,
  data: T,
  observedAt = Date.now()
): CapabilityEnvelope<T> {
  return { providerId: context.providerId, cwd: context.cwd, mode, state: 'ready', data, observedAt }
}

export function capabilityUnavailable<T>(
  context: ProviderContext,
  state: Extract<CapabilityState, 'unknown' | 'unsupported'>,
  reason: string
): CapabilityEnvelope<T> {
  return { providerId: context.providerId, cwd: context.cwd, mode: 'none', state, data: null, reason }
}

export function capabilityUnknown<T>(
  context: ProviderContext,
  mode: Exclude<CapabilityMode, 'none'>,
  reason: string
): CapabilityEnvelope<T> {
  return { providerId: context.providerId, cwd: context.cwd, mode, state: 'unknown', data: null, reason }
}
