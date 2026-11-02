import { describe, expect, it } from 'vitest'
import { parseConversationTarget } from './conversation-request'

describe('conversation target allowlist', () => {
  it.each(['claude', 'codex', 'qoder', 'opencode'] as const)('accepts %s on its default configuration', (providerId) => {
    expect(parseConversationTarget({ providerId })).toEqual({ providerId })
  })

  it('keeps the Qoder/OpenCode control fields it supports', () => {
    expect(parseConversationTarget({
      providerId: 'opencode',
      model: { id: 'claude-sonnet-4', providerId: 'anthropic' },
      effort: 'high',
      permissionMode: 'full_access'
    })).toEqual({
      providerId: 'opencode',
      model: { id: 'claude-sonnet-4', providerId: 'anthropic' },
      effort: 'high',
      permissionMode: 'full_access'
    })
  })

  it.each(['qoder', 'opencode', 'claude', 'codex'] as const)('rejects a named profile for %s', (providerId) => {
    expect(() => parseConversationTarget({ providerId, agentProfileId: 'pi:0123456789abcdef' }))
      .toThrow('统一对话仅支持 Pi 命名 Profile')
  })

  it('still requires a registered profile for Pi and rejects unknown providers', () => {
    expect(() => parseConversationTarget({ providerId: 'pi' })).toThrow('统一对话 Pi 必须选择已登记的 Agent Profile')
    expect(() => parseConversationTarget({ providerId: 'cursor' })).toThrow('统一对话 Provider 不受支持')
  })
})
