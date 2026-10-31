import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import type { ConversationSideChatRequest } from '../shared/conversation-api'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

async function fixture(): Promise<SideChatFixture> {
  const created = await sideChatFixture()
  fixtures.push(created)
  return created
}

/**
 * 侧聊也是一个自有原生 session 的 Conversation。用它的原生身份当 native-session
 * 来源就等于嵌套侧聊；这里必须拒绝，而且不能顺手迁移、接管或改写任何来源。
 */
describe('no nested side chats through a native-session alias', () => {
  it('refuses a native source that a side chat already owns, without touching either conversation', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'parent-cmd-1', 'parent question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat({
      source,
      expectedThroughOrdinal: preview.throughOrdinal,
      expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-1'
    })
    await sendTurn(current, child.id, 'child-cmd-1', 'side chat question')
    const settledChild = (await current.store.required(child.id))
    const nativeSessionId = settledChild.bindings.find(binding => binding.nativeSessionId)?.nativeSessionId
    expect(nativeSessionId).toBeDefined()

    const childFile = join(current.userData, 'conversations', `${child.id}.json`)
    const parentFile = join(current.userData, 'conversations', `${parent.id}.json`)
    const before = { child: await readFile(childFile, 'utf8'), parent: await readFile(parentFile, 'utf8') }
    const conversationsBefore = (await current.store.list(current.cwd)).length
    const runsBefore = current.runs.length

    const alias = { kind: 'native-session' as const, providerId: current.providerId,
      cwd: current.cwd, nativeSessionId: nativeSessionId! }
    await expect(current.service.previewSideChat(alias)).rejects.toThrow(`属于侧聊 ${child.id}`)
    // 省略 profile、或改用另一个 provider 都不能绕过：只读身份匹配不看调用方自称。
    await expect(current.service.previewSideChat({ ...alias, agentProfileId: 'pi:ffffffffffffffff' }))
      .rejects.toThrow('属于侧聊')
    expect(await readFile(childFile, 'utf8')).toBe(before.child)
    expect(await readFile(parentFile, 'utf8')).toBe(before.parent)
    expect((await current.store.list(current.cwd)).length).toBe(conversationsBefore)
    expect(current.runs.length).toBe(runsBefore)
  })

  it('refuses a conversation source that is itself a side chat', async () => {
    const current = await fixture()
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'parent-cmd-1', 'parent question')
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const preview = await current.service.previewSideChat(source)
    const request: ConversationSideChatRequest = {
      source,
      expectedThroughOrdinal: preview.throughOrdinal,
      expectedThroughRunId: preview.throughRunId,
      expectedPrefixFingerprint: preview.prefixFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint,
      commandId: 'side-chat-1'
    }
    const child = await current.service.createSideChat(request)
    await expect(current.service.previewSideChat({ kind: 'conversation', conversationId: child.id }))
      .rejects.toThrow('暂不支持以侧聊为来源创建新的侧聊')
  })
})
