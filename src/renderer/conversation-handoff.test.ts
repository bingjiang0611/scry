import { describe, expect, it, vi } from 'vitest'
import { adoptConversationWithReadback, conversationTarget, prepareConversationSend } from './conversation-handoff'
import type { ConversationAdoptionPreview, ConversationPreview } from '@shared/conversation-api'

const preview: ConversationPreview = {
  conversationId: 'conversation', revision: 7,
  target: { providerId: 'codex', continuationKey: 'verified-codex' },
  continuation: { kind: 'fresh', missingItems: [] },
  missingItems: [
    { ordinal: 1, providerId: 'claude', role: 'user', ref: { runId: 'a', itemId: 'user', contentHash: '1'.repeat(64) } },
    { ordinal: 1, providerId: 'claude', role: 'assistant', ref: { runId: 'a', itemId: 'answer', contentHash: '2'.repeat(64) } }
  ]
}

describe('same-composer Agent handoff', () => {
  it('recovers a lost adoption reply through one read-only lookup, without replaying the write', async () => {
    const adoption: ConversationAdoptionPreview = { source: { providerId: 'claude', cwd: '/workspace', externalSessionId: 'native' },
      fingerprint: 'source-fingerprint', title: 'original title', turnCount: 1 }
    const adopted = { id: 'stable', cwd: '/workspace', title: 'original title', revision: 0, turnCount: 1 }
    const api = { adopt: vi.fn().mockRejectedValue(new Error('reply lost after commit')),
      previewAdoption: vi.fn().mockResolvedValue({ ...adoption, adoptedConversation: adopted }) }
    expect(await adoptConversationWithReadback(api, adoption)).toEqual(adopted)
    expect(api.adopt).toHaveBeenCalledTimes(1)
    expect(api.previewAdoption).toHaveBeenCalledExactlyOnceWith(adoption.source)
    expect(await adoptConversationWithReadback(api, { ...adoption, adoptedConversation: adopted })).toEqual(adopted)
    expect(api.adopt).toHaveBeenCalledTimes(1)
    api.previewAdoption.mockResolvedValueOnce({ ...adoption, fingerprint: 'different', adoptedConversation: adopted })
    await expect(adoptConversationWithReadback(api, adoption)).rejects.toThrow('reply lost')
    api.previewAdoption.mockRejectedValueOnce(new Error('offline'))
    await expect(adoptConversationWithReadback(api, adoption)).rejects.toThrow('切换结果未知，草稿保留')
    expect(api.adopt).toHaveBeenCalledTimes(3)
  })

  it('preserves the exact Pi profile and rejects unsupported Agents', () => {
    expect(conversationTarget('pi:0123456789abcdef')).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
    expect(() => conversationTarget('qoder')).toThrow('尚不支持')
  })

  it('plans every missing item automatically, without dispatching or dropping controls', async () => {
    const api = { preview: vi.fn().mockResolvedValue(preview), send: vi.fn() }
    const result = await prepareConversationSend(api, 'conversation', { providerId: 'codex', permissionMode: 'default' }, 'continue', 'one-command')
    expect(api.preview).toHaveBeenCalledWith('conversation', { providerId: 'codex', permissionMode: 'default' })
    expect(api.send).not.toHaveBeenCalled()
    expect(result).toEqual({
      conversationId: 'conversation', providerId: 'codex', permissionMode: 'default',
      expectedRevision: 7, expectedContinuationKey: 'verified-codex',
      commandId: 'one-command', prompt: 'continue', confirmFresh: true,
      selectedItems: preview.missingItems.map(item => item.ref)
    })
  })

  it('freezes the clicked target before asynchronous planning and propagates refusal', async () => {
    const target = { providerId: 'codex' as const, model: { id: 'model-a' } }
    const api = { preview: vi.fn(async () => { target.model.id = 'model-b'; return preview }) }
    expect((await prepareConversationSend(api, 'conversation', target, 'captured prompt', 'command')).model).toEqual({ id: 'model-a' })
    api.preview.mockRejectedValueOnce(new Error('身份不可验证'))
    await expect(prepareConversationSend(api, 'conversation', target, 'prompt', 'next')).rejects.toThrow('身份不可验证')
  })
})
