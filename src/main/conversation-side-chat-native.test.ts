import { mkdir, mkdtemp, realpath, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSideChatSourceDeps } from './bootstrap/side-chat-source'
import { ConversationService } from './conversation-service'
import {
  claudeTranscriptLine as claudeLine,
  nativeSideChatFixture,
  sendTurn,
  sideChatFixture,
  writeClaudeTranscript,
  type SideChatFixture
} from './conversation-side-chat.fixture'
import type { AppSession } from './app-store'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import type { ConversationSideChatRequest } from '../shared/conversation-api'

const roots: string[] = []
const fixtures: SideChatFixture[] = []
const nativeCleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(nativeCleanups.splice(0).map(cleanup => cleanup()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** Production seam with a fake catalog; real transcript/native files, no Scry archive. */
async function nativeFixture(providerId: 'claude' | 'pi', sessionId: string) {
  const native = await nativeSideChatFixture(providerId, sessionId)
  nativeCleanups.push(native.cleanup)
  return native
}

function createRequest(source: ConversationSideChatRequest['source'], preview: {
  throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string
}, commandId = 'side-chat-native'): ConversationSideChatRequest {
  return { source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
    expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint, commandId }
}

describe('native side-chat sources without a Scry archive', () => {
  it('reads a real Claude transcript, freezes the completed prefix and ignores later appends', async () => {
    const sessionId = '11111111-2222-4333-8444-555555555555'
    const { current, home } = await nativeFixture('claude', sessionId)
    const path = await writeClaudeTranscript(home, current.cwd, sessionId, [
      claudeLine(current.cwd, sessionId, 'user', 'claude question one', { promptId: 'prompt-1' }),
      claudeLine(current.cwd, sessionId, 'assistant', 'claude answer one'),
      claudeLine(current.cwd, sessionId, 'user', 'claude question two', { promptId: 'prompt-2' }),
      claudeLine(current.cwd, sessionId, 'assistant', 'claude answer two')
    ])
    const source = { kind: 'native-session' as const, providerId: 'claude' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(2)
    expect(preview.messageCount).toBe(4)
    expect(preview.target).toEqual({ providerId: 'claude', permissionMode: 'default' })

    // A running third turn must not enter the prefix, and the earlier boundary stays valid.
    await appendFile(path, claudeLine(current.cwd, sessionId, 'user', 'claude question three', { promptId: 'prompt-3' }))
    const later = await current.service.previewSideChat(source)
    expect(later.throughOrdinal).toBe(2)
    expect(later.prefixFingerprint).toBe(preview.prefixFingerprint)

    const child = await current.service.createSideChat(createRequest(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect((await current.store.read(child.id))!.sideChat?.source).toEqual(source)
    const texts = await Promise.all(refs.map(ref => current.service.readItem(child.id, ref)))
    expect(texts).toEqual(['claude question one', 'claude answer one', 'claude question two', 'claude answer two'])
    // The frozen snapshot does not depend on the mutable transcript afterwards.
    await appendFile(path, claudeLine(current.cwd, sessionId, 'assistant', 'claude answer three'))
    expect(await current.service.readItem(child.id, refs[1])).toBe('claude answer one')
  })

  it('freezes the completed prefix of a torn transcript write and refuses a corrupt record', async () => {
    const sessionId = '99999999-2222-4333-8444-555555555555'
    const { current, home } = await nativeFixture('claude', sessionId)
    const path = await writeClaudeTranscript(home, current.cwd, sessionId, [
      claudeLine(current.cwd, sessionId, 'user', 'claude question'),
      claudeLine(current.cwd, sessionId, 'assistant', 'claude answer')
    ])
    const source = { kind: 'native-session' as const, providerId: 'claude' as const,
      cwd: current.cwd, nativeSessionId: sessionId }
    // A live writer appends a half-written record. That tail is not evidence, and it no
    // longer blocks freezing the records that were already complete.
    await appendFile(path, '{"type":"assistant","cwd":"' + current.cwd)
    const preview = await current.service.previewSideChat(source)
    expect(preview.messageCount).toBe(2)
    expect(preview.throughOrdinal).toBe(1)

    // A corrupt record in the middle is a different thing: the prefix cannot be proved,
    // so the source is refused and nothing is published.
    await writeFile(path, [
      claudeLine(current.cwd, sessionId, 'user', 'claude question'),
      '{"type":"assistant","cwd":"' + current.cwd + '","message":{"role":"assistant","content":[{"type":"text",}]}}\n'
    ].join(''))
    await expect(current.service.previewSideChat(source)).rejects.toThrow('原生会话记录')
    expect((await current.store.list(current.cwd)).length).toBe(0)
  })

  it('reads a real Pi native session file without a Scry archive', async () => {
    const sessionId = '01a1338c-3d8b-775b-8645-fd964faa29a3'
    const { current, home } = await nativeFixture('pi', sessionId)
    const directory = join(home, '.pi', 'agent', 'sessions',
      `--${(await realpath(current.cwd)).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
    await mkdir(directory, { recursive: true })
    const time = '2026-10-13T04:36:31Z'
    const entries = [
      { type: 'session', version: 3, id: sessionId, cwd: current.cwd },
      { type: 'message', id: 'u1', parentId: null, timestamp: time, message: { role: 'user', content: [{ type: 'text', text: 'pi question' }] } },
      { type: 'message', id: 'a1', parentId: 'u1', timestamp: time,
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pi answer' }] } },
      // A trailing turn that has not answered yet stays out of the frozen prefix.
      { type: 'message', id: 'u2', parentId: 'a1', timestamp: time, message: { role: 'user', content: [{ type: 'text', text: 'pi running' }] } }
    ]
    await writeFile(join(directory, `session_${sessionId}.jsonl`), entries.map(entry => JSON.stringify(entry)).join('\n'))
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.messageCount).toBe(2)
    const child = await current.service.createSideChat(createRequest(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    const texts = await Promise.all(refs.map(ref => current.service.readItem(child.id, ref)))
    expect(texts).toEqual(['pi question', 'pi answer'])
    expect((await current.store.list(current.cwd)).map(item => item.id)).toEqual([child.id])
  })

  it('uses the Scry archive as authority for Providers without a native file reader', async () => {
    const current = await sideChatFixture()
    fixtures.push(current)
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, 'parent-1', 'codex question')
    const sessionId = (await current.store.read(parent.id))!.bindings[0].nativeSessionId!
    const catalog: AppSession[] = [{ sessionId, externalSessionId: sessionId, providerId: 'codex', cwd: current.cwd,
      preview: '', ts: Date.now() }]
    const sideChatSource = createSideChatSourceDeps({
      appSessionStore: () => ({ load: () => catalog }) as ReturnType<typeof import('./app-store').createAppSessionStore>,
      resolveKnownProjectDirectory: cwd => cwd,
      homeDir: await mkdtemp(join(tmpdir(), 'scry-side-chat-home-')),
      userDataDir: current.userData
      // No readNativeTurns: codex has no verified native reader in this build.
    })
    current.service = new ConversationService({
      store: current.store,
      resolveContinuationKey: async ({ providerId }) => `identity:${providerId}:default`,
      supportsHistoricalInput: () => true,
      supportsHistoryReader: () => true,
      startAppRun: async () => { throw new Error('no Provider may start during a source capture') },
      sideChatSource
    })
    const source = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const managed = await current.service.previewSideChat({ kind: 'conversation', conversationId: parent.id })
    const preview = await current.service.previewSideChat(source)
    // The same committed archive yields the same messages under a native scope; the
    // scope refs stay distinct, so two scopes are not silently merged.
    expect(preview.messageCount).toBe(managed.messageCount)
    expect(preview.throughOrdinal).toBe(managed.throughOrdinal)
    expect(preview.prefixFingerprint).not.toBe(managed.prefixFingerprint)
    const child = await current.service.createSideChat(createRequest(source, preview))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect((await current.store.read(child.id))!.sideChat?.source).toEqual(source)
    expect((await current.store.read(child.id))!.sideChat?.snapshot.throughRunId).toBe(preview.throughRunId)
    const texts = await Promise.all(refs.map(ref => current.service.readItem(child.id, ref)))
    expect(texts).toEqual(['codex question', 'answer: codex question'])
    // An unknown native identity is refused instead of producing an empty snapshot.
    await expect(current.service.previewSideChat({ ...source, nativeSessionId: 'unknown-session' }))
      .rejects.toThrow('不属于已登记的 App 会话')
  })

  it('refuses forged, ambiguous or cross-project catalog identities', async () => {
    const sessionId = 'native-session-1'
    const current = await sideChatFixture({ providerId: 'pi' })
    fixtures.push(current)
    const home = await mkdtemp(join(tmpdir(), 'scry-side-chat-home-'))
    roots.push(home)
    let catalog: AppSession[] = []
    const deps = createSideChatSourceDeps({
      appSessionStore: () => ({ load: () => catalog }) as ReturnType<typeof import('./app-store').createAppSessionStore>,
      resolveKnownProjectDirectory: cwd => cwd,
      homeDir: home,
      userDataDir: current.userData
    })
    const source = { providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    await expect(deps.assertNativeSource!(source)).rejects.toThrow('不属于已登记的 App 会话')

    catalog = [{ sessionId, externalSessionId: sessionId, providerId: 'pi', agentProfileId: 'pi:0123456789abcdef',
      cwd: current.cwd, preview: '', ts: Date.now() }]
    // A different profile than the catalog session owns is refused, not re-attributed.
    await expect(deps.assertNativeSource!({ ...source, agentProfileId: 'pi:fedcba9876543210' }))
      .rejects.toThrow('Profile 与已登记会话不一致')
    await expect(deps.assertNativeSource!({ ...source, agentProfileId: 'pi:0123456789abcdef' })).resolves.toBeUndefined()

    catalog = [...catalog, { ...catalog[0], agentProfileId: 'pi:fedcba9876543210' }]
    await expect(deps.assertNativeSource!({ ...source, agentProfileId: 'pi:0123456789abcdef' }))
      .rejects.toThrow('跨 Profile 的身份')

    catalog = [{ ...catalog[0], cwd: '/another/project' }]
    const scoped = createSideChatSourceDeps({
      appSessionStore: () => ({ load: () => catalog }) as ReturnType<typeof import('./app-store').createAppSessionStore>,
      resolveKnownProjectDirectory: cwd => cwd,
      homeDir: home,
      userDataDir: current.userData
    })
    await expect(scoped.assertNativeSource!({ ...source, agentProfileId: 'pi:0123456789abcdef' }))
      .rejects.toThrow('工作区与已登记会话不一致')
  })
})
