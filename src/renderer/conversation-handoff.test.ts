import { describe, expect, it, vi } from 'vitest'
import { adoptConversationWithReadback, conversationTarget, legacyAdoptionSourceTarget, prepareConversationSend,
  registeredPiProfileIdOf, selectedAgentProfileId } from './conversation-handoff'
import { CONVERSATION_COPY } from './constants/conversation-copy'
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

  it('targets all five Providers for a send and keeps only the legacy adoption source narrow', () => {
    expect(conversationTarget('pi:0123456789abcdef')).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
    // Send target: every registered Provider owns a real native continuation.
    expect(conversationTarget('claude')).toEqual({ providerId: 'claude' })
    expect(conversationTarget('codex')).toEqual({ providerId: 'codex' })
    expect(conversationTarget('qoder')).toEqual({ providerId: 'qoder' })
    expect(conversationTarget('opencode')).toEqual({ providerId: 'opencode' })
    expect(() => conversationTarget('gemini')).toThrow('尚未注册 Provider adapter')
    // Adoption source: only the three Providers with an adoptable captured archive.
    expect(legacyAdoptionSourceTarget('claude')).toEqual({ providerId: 'claude' })
    expect(legacyAdoptionSourceTarget('pi:0123456789abcdef')).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
    expect(() => legacyAdoptionSourceTarget('qoder')).toThrow('迁移来源仅支持 Claude/Codex/Pi')
    expect(() => legacyAdoptionSourceTarget('opencode')).toThrow('迁移来源仅支持 Claude/Codex/Pi')
  })

  // 回归：旧捕获的来源身份就是当时记录的历史启动器 id，宿主按这个身份匹配记录。
  it('refuses to migrate a historical Pi launcher identity as an adoption source', () => {
    for (const agentId of ['pi:rotom', 'pi:default']) {
      expect(() => legacyAdoptionSourceTarget(agentId)).toThrow(CONVERSATION_COPY.legacyPiSourceNotMigratable(agentId))
    }
    // 来源文案不承诺「加 Profile 就能迁移」，它说的是这段记录不能作为迁移来源。
    expect(CONVERSATION_COPY.legacyPiSourceNotMigratable('Pi · Rotom')).toContain('不能作为迁移来源')
    expect(CONVERSATION_COPY.legacyPiSourceNotMigratable('Pi · Rotom')).toContain('新增 Profile 也不会改写已有记录')
    // 已登记的 Pi Profile 来源仍然按它记录的 id 迁移，不借用发现结果。
    expect(legacyAdoptionSourceTarget('pi:0123456789abcdef'))
      .toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
  })

  // 分支比较用的是运行 binding 记录的 Profile 身份，而不是选择器显示的历史 id。
  it('maps the selected agent to the profile identity a run binding records', () => {
    const agent = { id: 'pi:rotom', agentProfileId: 'pi:0123456789abcdef' }
    expect(selectedAgentProfileId('pi:rotom', [agent])).toBe('pi:0123456789abcdef')
    expect(selectedAgentProfileId('pi:0123456789abcdef', [])).toBe('pi:0123456789abcdef')
    expect(selectedAgentProfileId('claude', [])).toBe('claude')
    expect(selectedAgentProfileId('codex', [{ id: 'codex', agentProfileId: 'ignored' }])).toBe('codex')
    expect(selectedAgentProfileId('pi:rotom', [{ id: 'pi:rotom' }])).toBeUndefined()
  })

  // 回归（截图）：侧聊/对话的 Composer 标签是 Pi · Rotom，但发送必须带已登记 Profile。
  it('sends the registered profile of a selected legacy Pi agent', () => {
    const agent = { id: 'pi:rotom', agentProfileId: 'pi:0123456789abcdef' }
    expect(registeredPiProfileIdOf('pi:rotom', [agent])).toBe('pi:0123456789abcdef')
    expect(conversationTarget('pi:rotom', { permissionMode: 'full_access' }, [agent]))
      .toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef', permissionMode: 'full_access' })
    // 已登记的稳定 id 仍然用它自己，不依赖发现结果。
    expect(conversationTarget('pi:0123456789abcdef')).toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
    // 另一个 Pi 启动器不是这个 Agent 的身份。
    expect(registeredPiProfileIdOf('pi:rotom', [
      { id: 'pi:rotom' }, { id: 'pi:fedcba9876543210', agentProfileId: 'pi:fedcba9876543210' }])).toBeUndefined()
  })

  it('blocks a legacy Pi agent without an exact registered profile before any IPC', async () => {
    const api = { preview: vi.fn() }
    // ConversationView 的发送准备顺序：先解析目标，再读预览。目标解析失败就不会有 IPC。
    const prepare = (agents: { id: string; agentProfileId?: string }[]) => () => prepareConversationSend(api, 'conversation',
      conversationTarget('pi:rotom', undefined, agents), 'hello', 'one-command')
    expect(() => prepare([{ id: 'pi:rotom' }])()).toThrow(CONVERSATION_COPY.piProfileNotRegistered('pi:rotom'))
    expect(() => prepare([{ id: 'pi:claude-only', agentProfileId: 'pi:fedcba9876543210' }])())
      .toThrow(CONVERSATION_COPY.piProfileNotRegistered('pi:rotom'))
    expect(api.preview).not.toHaveBeenCalled()
    // 负对照：旧实现把原始 `pi:rotom` 当成 Agent Profile 发出去，宿主才报错。
    expect(() => conversationTarget('pi:rotom')).toThrow(CONVERSATION_COPY.piProfileNotRegistered('pi:rotom'))
    expect(conversationTarget('pi:rotom', undefined, [{ id: 'pi:rotom', agentProfileId: 'pi:0123456789abcdef' }]))
      .toEqual({ providerId: 'pi', agentProfileId: 'pi:0123456789abcdef' })
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
    const attachments = [{ kind: 'image' as const, name: 'current.png', mimeType: 'image/png' as const, dataBase64: 'original-image' }]
    const api = { preview: vi.fn(async () => {
      target.model.id = 'model-b'
      attachments[0].dataBase64 = 'new-draft-image'
      attachments.push({ ...attachments[0], name: 'next.png' })
      return preview
    }) }
    const frozen = await prepareConversationSend(api, 'conversation', target, '  captured prompt\n', 'command', attachments)
    expect(frozen.model).toEqual({ id: 'model-a' })
    expect(frozen.prompt).toBe('  captured prompt\n')
    expect(frozen.attachments).toEqual([{ kind: 'image', name: 'current.png', mimeType: 'image/png', dataBase64: 'original-image' }])
    api.preview.mockRejectedValueOnce(new Error('身份不可验证'))
    await expect(prepareConversationSend(api, 'conversation', target, 'prompt', 'next')).rejects.toThrow('身份不可验证')
  })
})
