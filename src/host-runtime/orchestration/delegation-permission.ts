import type { AgentPermissionMode } from '../../shared/runtime-types'

export type FirstSliceProvider = 'claude' | 'qoder' | 'codex'

const SUPPORTED_MODES: Readonly<Record<FirstSliceProvider, readonly AgentPermissionMode[]>> = {
  claude: ['default', 'auto_accept_edits', 'auto_review', 'full_access'],
  qoder: ['default', 'auto_accept_edits', 'auto_review', 'full_access'],
  codex: ['default', 'auto_review', 'full_access']
}

function isFirstSliceProvider(provider: string): provider is FirstSliceProvider {
  return provider === 'claude' || provider === 'qoder' || provider === 'codex'
}

/**
 * Same-provider partial order (P6 security §S1.2):
 * - Claude / Qoder: default <= auto_accept_edits, default <= auto_review, both <= full_access;
 *   auto_accept_edits and auto_review are mutually incomparable.
 * - Codex: total order default <= auto_review <= full_access (auto_accept_edits unsupported).
 */
export function isPermissionModeAtMost(
  provider: FirstSliceProvider,
  child: AgentPermissionMode,
  parent: AgentPermissionMode
): boolean {
  const supported = SUPPORTED_MODES[provider]
  if (!supported.includes(child) || !supported.includes(parent)) return false
  if (child === parent) return true
  if (child === 'default') return true
  if (parent === 'full_access') return true
  return false
}

export interface ResolveDelegatedPermissionInput {
  provider: string
  targetProvider?: string
  parentMode: AgentPermissionMode
  requestedMode?: AgentPermissionMode
  sessionFullAccessEnabled: boolean
}

export type ResolveDelegatedPermissionResult =
  | { ok: true; mode: AgentPermissionMode; source: 'inherited' | 'requested' }
  | {
      ok: false
      code:
        | 'provider_unavailable'
        | 'capability_denied'
        | 'permission_mode_escalation_denied'
        | 'full_access_not_enabled'
      reason: string
      allowedModes: AgentPermissionMode[]
    }

export function allowedModesForParent(
  provider: FirstSliceProvider,
  parentMode: AgentPermissionMode,
  sessionFullAccessEnabled: boolean
): AgentPermissionMode[] {
  return SUPPORTED_MODES[provider].filter((mode) => {
    if (!isPermissionModeAtMost(provider, mode, parentMode)) return false
    if (mode === 'full_access' && !sessionFullAccessEnabled) return false
    return true
  })
}

export function resolveDelegatedPermissionMode(
  input: ResolveDelegatedPermissionInput
): ResolveDelegatedPermissionResult {
  if (!isFirstSliceProvider(input.provider)) {
    return {
      ok: false,
      code: 'provider_unavailable',
      reason: `Provider "${input.provider}" does not support multi-agent delegation in this slice`,
      allowedModes: []
    }
  }
  if (input.targetProvider && input.targetProvider !== input.provider) {
    return {
      ok: false,
      code: 'capability_denied',
      reason: 'Cross-provider delegation is not enabled in the first slice',
      allowedModes: allowedModesForParent(input.provider, input.parentMode, input.sessionFullAccessEnabled)
    }
  }
  const allowedModes = allowedModesForParent(input.provider, input.parentMode, input.sessionFullAccessEnabled)
  const effective: AgentPermissionMode = input.requestedMode ?? input.parentMode
  const source: 'inherited' | 'requested' = input.requestedMode === undefined ? 'inherited' : 'requested'

  if (!isPermissionModeAtMost(input.provider, effective, input.parentMode)) {
    return {
      ok: false,
      code: 'permission_mode_escalation_denied',
      reason: `Requested mode "${effective}" is not <= parent mode "${input.parentMode}" for ${input.provider}`,
      allowedModes
    }
  }
  if (effective === 'full_access' && !input.sessionFullAccessEnabled) {
    return {
      ok: false,
      code: 'full_access_not_enabled',
      reason: 'Session switch "allow delegated full_access" is off; explicitly request a narrower mode or enable it in the local App',
      allowedModes
    }
  }
  return { ok: true, mode: effective, source }
}

export interface DelegationCapabilitiesDescription {
  provider: string
  supported: boolean
  parentMode: AgentPermissionMode
  availableModes: AgentPermissionMode[]
  unavailableModes: Array<{ mode: AgentPermissionMode; reason: string }>
}

export function describeDelegationCapabilities(input: {
  provider: string
  parentMode: AgentPermissionMode
  sessionFullAccessEnabled: boolean
}): DelegationCapabilitiesDescription {
  if (!isFirstSliceProvider(input.provider)) {
    return {
      provider: input.provider,
      supported: false,
      parentMode: input.parentMode,
      availableModes: [],
      unavailableModes: []
    }
  }
  const availableModes: AgentPermissionMode[] = []
  const unavailableModes: Array<{ mode: AgentPermissionMode; reason: string }> = []
  for (const mode of SUPPORTED_MODES[input.provider]) {
    const check = resolveDelegatedPermissionMode({
      provider: input.provider,
      parentMode: input.parentMode,
      requestedMode: mode,
      sessionFullAccessEnabled: input.sessionFullAccessEnabled
    })
    if (check.ok) availableModes.push(mode)
    else unavailableModes.push({ mode, reason: check.code })
  }
  return {
    provider: input.provider,
    supported: true,
    parentMode: input.parentMode,
    availableModes,
    unavailableModes
  }
}
