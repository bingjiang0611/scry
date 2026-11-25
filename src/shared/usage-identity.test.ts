import { describe, expect, it } from 'vitest'
import { USAGE_AGENT_LABELS, usageAgentOrder, usageIdentity, usageIdentityForProviderId } from './usage-identity'

describe('usageIdentity', () => {
  it('keeps a gateway name as the gateway, not as the agent', () => {
    expect(usageIdentity({ provider: 'cc-switch' })).toEqual({ agent: 'pi', gateway: 'cc-switch' })
    expect(usageIdentity({ provider: 'custom-gateway' })).toEqual({ agent: 'pi', gateway: 'custom-gateway' })
  })

  it('prefers the runtime over the billing provider when both describe a row', () => {
    expect(usageIdentity({ provider: 'codex', runtimeProvider: 'pi_rpc', upstreamProvider: 'openai-codex' }))
      .toEqual({ agent: 'pi', gateway: 'openai-codex' })
    expect(usageIdentity({ provider: 'anthropic', runtimeProvider: 'claude_sdk', upstreamProvider: null }))
      .toEqual({ agent: 'claude', gateway: undefined })
  })

  it('never keeps the placeholder upstream as a gateway', () => {
    expect(usageIdentity({ provider: 'unknown' })).toEqual({ agent: 'pi', gateway: undefined })
    expect(usageIdentity({ provider: 'codex', runtimeProvider: 'pi_rpc', upstreamProvider: 'unknown' }))
      .toEqual({ agent: 'pi', gateway: undefined })
    expect(usageIdentity({ provider: 'codex', runtimeProvider: 'codex_cli', upstreamProvider: '' }))
      .toEqual({ agent: 'codex', gateway: undefined })
  })

  it('falls back to the billing provider for history without a runtime', () => {
    expect(usageIdentity({ provider: 'qoder' })).toEqual({ agent: 'qoder', gateway: undefined })
    expect(usageIdentity({ provider: 'opencode' })).toEqual({ agent: 'opencode', gateway: undefined })
    expect(usageIdentity({ provider: 'antigravity' })).toEqual({ agent: 'antigravity', gateway: undefined })
    expect(usageIdentity({ provider: 'codex' })).toEqual({ agent: 'codex', gateway: undefined })
    expect(usageIdentity({ provider: 'anthropic' })).toEqual({ agent: 'claude', gateway: undefined })
  })

  it('labels the agents the way the page shows them', () => {
    expect(USAGE_AGENT_LABELS).toMatchObject({ pi: 'Pi', claude: 'Claude', codex: 'Codex', qoder: 'Qoder', opencode: 'OpenCode', antigravity: 'Antigravity' })
    expect(usageAgentOrder(['qoder', 'pi', 'claude'])).toEqual(['pi', 'claude', 'qoder'])
  })

  it('maps a performance row provider id to the same identity', () => {
    expect(usageIdentityForProviderId('pi', 'openai-codex')).toEqual({ agent: 'pi', gateway: 'openai-codex' })
    expect(usageIdentityForProviderId('claude')).toEqual({ agent: 'claude', gateway: undefined })
  })
})
