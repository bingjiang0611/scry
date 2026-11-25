import type { BillingProvider } from './billing.js'
import type { ProviderId } from './provider.js'

export type UsageAgentId = ProviderId

export const USAGE_AGENT_LABELS: Record<UsageAgentId, string> = {
  pi: 'Pi',
  claude: 'Claude',
  codex: 'Codex',
  qoder: 'Qoder',
  opencode: 'OpenCode',
  antigravity: 'Antigravity'
}

const AGENT_ORDER: UsageAgentId[] = ['pi', 'claude', 'codex', 'qoder', 'opencode', 'antigravity']

export function usageAgentOrder<T extends UsageAgentId>(agents: Iterable<T>): T[] {
  const seen = new Set(agents)
  return AGENT_ORDER.filter((agent): agent is T => seen.has(agent as T))
}

const RUNTIME_AGENTS: Record<string, UsageAgentId> = {
  pi_rpc: 'pi',
  claude_sdk: 'claude',
  codex_cli: 'codex',
  qoder_cli: 'qoder',
  opencode_server: 'opencode',
  antigravity_acp: 'antigravity'
}

// Billing providers that name an agent rather than an upstream gateway. Every
// other provider string (cc-switch, custom-gateway, openrouter, …) can only be
// reached through Pi, whose billing provider is the upstream name.
const VENDOR_AGENTS: Record<string, UsageAgentId> = {
  anthropic: 'claude',
  'claude-code': 'claude',
  codex: 'codex',
  qoder: 'qoder',
  opencode: 'opencode',
  antigravity: 'antigravity'
}

// A vendor name is not a gateway: "Claude · anthropic" would repeat Q2's mistake.
const VENDOR_GATEWAYS: Record<UsageAgentId, ReadonlySet<string>> = {
  pi: new Set(),
  claude: new Set(['anthropic', 'claude-code']),
  codex: new Set(['openai', 'codex']),
  qoder: new Set(['qoder']),
  opencode: new Set(['opencode']),
  antigravity: new Set(['antigravity'])
}

const gatewayOf = (value: string | null | undefined, agent?: UsageAgentId): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === 'unknown') return undefined
  if (agent && VENDOR_GATEWAYS[agent].has(trimmed)) return undefined
  return trimmed
}

export interface UsageIdentity {
  agent: UsageAgentId
  gateway?: string
}

export function agentForRuntimeProvider(runtimeProvider?: string | null): UsageAgentId | undefined {
  return runtimeProvider ? RUNTIME_AGENTS[runtimeProvider] : undefined
}

/** Read-time migration: old rows keep their stored fields, identity is derived. */
export function usageIdentity(args: {
  provider?: BillingProvider | null
  runtimeProvider?: string | null
  upstreamProvider?: string | null
}): UsageIdentity {
  const provider = args.provider?.trim() || undefined
  const runtimeAgent = agentForRuntimeProvider(args.runtimeProvider)
  if (runtimeAgent) {
    // Without a recorded upstream, a vendor-shaped billing provider would name
    // the wrong thing; only a gateway-shaped one is the real upstream.
    const fallback = runtimeAgent === 'pi' && provider && !VENDOR_AGENTS[provider] ? provider : undefined
    const gateway = gatewayOf(args.upstreamProvider, runtimeAgent) ?? gatewayOf(fallback, runtimeAgent)
    return gateway ? { agent: runtimeAgent, gateway } : { agent: runtimeAgent }
  }
  const agent = (provider && VENDOR_AGENTS[provider]) || 'pi'
  const gateway = agent === 'pi' ? gatewayOf(args.upstreamProvider, agent) ?? gatewayOf(provider, agent) : undefined
  return gateway ? { agent, gateway } : { agent }
}

/** Performance rows already know the agent; only the gateway needs a rule. */
export function usageIdentityForProviderId(agent: UsageAgentId, gateway?: string | null): UsageIdentity {
  const value = gatewayOf(gateway, agent)
  return value ? { agent, gateway: value } : { agent }
}
