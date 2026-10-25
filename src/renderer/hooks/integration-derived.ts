import { INTEGRATION_COPY } from '../constants/integration-copy'
import type { CapabilityEnvelope, McpSnapshot, ProviderContext, ProviderId } from '@shared/provider'
import type { ProviderCompatibilityAdvisory } from '@shared/provider-compatibility'
import type { McpLiveStatus, TraceEvent } from '@shared/trace'
import { providerIdForAgentId, type AgentRunControlCatalog, type AgentRunControls } from '@shared/runtime'
import type { DetectedAgent, McpMeta } from '../env'
import type { McpStatus } from '../format'
import { modelKey, parseStoredRunControls } from './integration-controls'

export async function authoritativeRefreshAfterToggle<T>(
  result: CapabilityEnvelope<boolean>,
  refresh: () => Promise<T>
): Promise<T | null> {
  return result.data === true ? refresh() : null
}

export function applyDataUpdatedEffects(effects: {
  loadStats: () => void
  loadBillingState: () => void
  loadAnalytics: () => void
  analyticsActive: boolean
}): void {
  effects.loadStats()
  effects.loadBillingState()
  // Analytics is a comparatively expensive, optional SQLite projection. Keep it fresh once the
  // user has opened the surface, but do not query it during every chat-only application launch.
  if (effects.analyticsActive) effects.loadAnalytics()
}

export function mergeMcpLiveSnapshot(
  current: McpLiveStatus[],
  runtime: McpLiveStatus[] | null | undefined,
  clearUnknownRuntime = false
): McpLiveStatus[] {
  return runtime ?? (clearUnknownRuntime ? [] : current)
}

export function reconcileMcpAuthStatus(
  current: Record<string, McpStatus>,
  configured: McpMeta[],
  runtime: McpLiveStatus[]
): Record<string, McpStatus> {
  const configuredByTarget = new Map(configured.map((item) => [item.targetId ?? item.name, item]))
  const runtimeByName = new Map(runtime.map((item) => [item.name, item]))
  return Object.fromEntries(Object.entries(current).flatMap(([targetId, state]) => {
    const target = configuredByTarget.get(targetId)
    if (!target) return []
    const live = runtimeByName.get(target.name)
    if (state.authenticating || live?.status !== 'connected') return [[targetId, state]]
    const next = { ...state }
    delete next.authOk
    delete next.authError
    return [[targetId, next]]
  }))
}

export function mcpAuthVerificationError(snapshot: McpSnapshot, targetId: string): string | undefined {
  const target = snapshot.configured.find((item) => (item.targetId ?? item.name) === targetId)
  const live = target && snapshot.runtime?.find((item) => item.name === target.name)
  return live?.status === 'connected' ? undefined : INTEGRATION_COPY.mcpVerification(live?.status)
}

export function shouldResetRunControlCatalog(currentAgentId: string, nextAgentId: string): boolean {
  return currentAgentId !== nextAgentId
}

/**
 * Provider CLI 版本兼容性提示。它是 advisory：只解释判定依据，不阻断发送，也不改写
 * Provider 的真实能力。status 为 supported 或 unknown 时不提示——unknown 表示没有
 * 可用判定依据，编一句警告会把「不知道」伪装成「有问题」。
 */
export function providerCompatibilityNotice(agent: { name: string; compatibility?: ProviderCompatibilityAdvisory } | null | undefined): string | null {
  const advisory = agent?.compatibility
  if (!advisory || advisory.status === 'supported' || advisory.status === 'unknown') return null
  return INTEGRATION_COPY.compatibility(agent?.name, advisory.observedVersion, advisory.reason, advisory.recommendedRange)
}

export function runControlSendBlockedReason(
  providerId: ProviderId,
  capability: CapabilityEnvelope<AgentRunControlCatalog> | null,
  loading: boolean,
  controls: AgentRunControls
): string | null {
  const usesProviderDefaults =
    controls.permissionMode === 'default' &&
    controls.model == null &&
    controls.effort == null
  // Pi has no default approval mode. A cold catalog temporarily resets the selection to
  // default, even when full_access is saved; never send that placeholder to the adapter.
  if (providerId !== 'pi' && usesProviderDefaults && capability === null && loading) return null

  const selectedModel = controls.model && capability?.data
    ? capability.data.models.find((option) => modelKey(option.model) === modelKey(controls.model!))
    : undefined
  const selectionIsKnown = capability?.data != null &&
    (controls.model == null || selectedModel != null) &&
    (controls.effort == null || selectedModel?.efforts.some((option) => option.id === controls.effort) === true) &&
    capability.data.permissions.some((option) => option.id === controls.permissionMode)
  const cachedCatalog = capability?.state === 'unknown' &&
    capability.reason?.includes(INTEGRATION_COPY.cachedCatalogMarker) === true
  if (cachedCatalog && selectionIsKnown) return null
  if (capability?.data != null && !selectionIsKnown) {
    return cachedCatalog
      ? INTEGRATION_COPY.cachedSelectionMissing
      : INTEGRATION_COPY.selectionUnsupported
  }
  return !capability || capability.data == null ||
    (capability.state !== 'ready' && capability.state !== 'degraded')
    ? capability?.reason ?? INTEGRATION_COPY.permissionUnconfirmed
    : null
}

export function requestRunControlsForSelectedProvider<T>(
  providerId: ProviderId,
  cwd: string | null,
  request: (context: ProviderContext) => Promise<T>,
  agentProfileId?: string
): Promise<T> {
  return request({ providerId, ...(agentProfileId ? { agentProfileId } : {}), cwd: cwd ?? undefined })
}

export function reconcileSelectedAgentId(current: string, detected: DetectedAgent[]): string {
  if (detected.length === 0) return current
  const available = (agent: DetectedAgent): boolean => agent.health?.state !== 'unavailable'
  const currentProviderId = providerIdForAgentId(current)
  const sameProviderFallback = currentProviderId
    ? detected.find((agent) => providerIdForAgentId(agent.id) === currentProviderId && available(agent))
    : undefined
  const selected = detected.find((agent) => agent.id === current)
  if (!selected) return sameProviderFallback?.id ?? detected.find(available)?.id ?? detected[0].id
  if (available(selected)) return current
  // 不跨 Provider 静默切换；但同一 Provider 的可用 Profile 应替代失效 Profile。
  return sameProviderFallback?.id ?? current
}

export type SessionModelSelection = Pick<AgentRunControls, 'model' | 'effort'>

export function recordedSessionModel(turns: { items: TraceEvent[] }[]): SessionModelSelection | undefined {
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = turns[turnIndex].items
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const event = items[index]
      if (event.kind !== 'harness' || event.stage !== 'runtime:controls') continue
      const controls = parseStoredRunControls(event.input)
      return controls ? { model: controls.model, effort: controls.effort } : undefined
    }
  }
  return undefined
}
export const SESSION_MODELS_KEY = 'scry:session-models:v1'

export function parseSessionModels(raw: string | null): Map<string, SessionModelSelection> {
  if (!raw) return new Map()
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows)) return new Map()
    return new Map(rows.flatMap((row) => {
      if (!Array.isArray(row) || typeof row[0] !== 'string') return []
      const controls = parseStoredRunControls(row[1])
      return controls ? [[row[0], { model: controls.model, effort: controls.effort }]] : []
    }))
  } catch {
    return new Map()
  }
}
