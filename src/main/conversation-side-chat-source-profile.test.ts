import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSession } from './app-store'
import { createSideChatSourceDeps } from './bootstrap/side-chat-source'
import { ConversationService } from './conversation-service'
import { modelEvent, sendTurn, sideChatFixture, type SideChatFixture } from './conversation-side-chat.fixture'
import { sideChatSnapshotRefs } from './conversation-side-chat-snapshot'
import { upsertTraceArchiveTurn } from './transcript-archive'
import type { ConversationSideChatRequest } from '../shared/conversation-api'
import type { ProviderId } from '../shared/provider'

const fixtures: SideChatFixture[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
})

const PROFILE_A = 'pi:0123456789abcdef'
const PROFILE_B = 'pi:fedcba9876543210'

/**
 * A recorded parent turn plus the production read-only seam over a fake catalog.
 *
 * The catalog is the only fake part: identity checks, the canonical archive, the
 * Profile gate inside the archive reader and the child publication are real code.
 */
async function recordedFixture(providerId: ProviderId, agentProfileId?: string): Promise<{
  current: SideChatFixture; parentId: string; sessionId: string; catalog: AppSession[]
}> {
  const current = await sideChatFixture({ providerId })
  fixtures.push(current)
  const parent = await current.service.create(current.cwd)
  await sendTurn(current, parent.id, 'parent-1', `${providerId} question`, providerId, agentProfileId)
  const sessionId = (await current.store.read(parent.id))!.bindings[0].nativeSessionId!
  const catalog: AppSession[] = [{ sessionId, externalSessionId: sessionId, providerId, cwd: current.cwd,
    preview: '', ts: Date.now(), ...(agentProfileId ? { agentProfileId } : {}) }]
  current.service = recordedService(current, catalog)
  return { current, parentId: parent.id, sessionId, catalog }
}

function recordedService(current: SideChatFixture, catalog: AppSession[]): ConversationService {
  return new ConversationService({
    store: current.store,
    resolveContinuationKey: async ({ providerId, agentProfileId }) => `identity:${providerId}:${agentProfileId ?? 'default'}`,
    supportsHistoricalInput: () => true,
    supportsHistoryReader: () => true,
    startAppRun: async () => { throw new Error('no Provider may start during a source capture') },
    sideChatSource: createSideChatSourceDeps({
      appSessionStore: () => ({ load: () => catalog }) as ReturnType<typeof import('./app-store').createAppSessionStore>,
      resolveKnownProjectDirectory: cwd => cwd,
      homeDir: current.root,
      userDataDir: current.userData
    })
  })
}

const createRequest = (
  source: ConversationSideChatRequest['source'],
  preview: { throughOrdinal: number; throughRunId: string; prefixFingerprint: string; manifestFingerprint: string },
  commandId: string,
  initialTarget?: ConversationSideChatRequest['initialTarget']
): ConversationSideChatRequest => ({
  source, expectedThroughOrdinal: preview.throughOrdinal, expectedThroughRunId: preview.throughRunId,
  expectedPrefixFingerprint: preview.prefixFingerprint, expectedManifestFingerprint: preview.manifestFingerprint,
  commandId, ...(initialTarget ? { initialTarget } : {})
})

describe('native side-chat source Profile propagation', () => {
  it('captures a named Pi Profile session whose archive records that same Profile', async () => {
    const { current, sessionId } = await recordedFixture('pi', PROFILE_A)
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, agentProfileId: PROFILE_A,
      cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    expect(preview.throughOrdinal).toBe(1)
    expect(preview.messageCount).toBe(2)
    const child = await current.service.createSideChat(createRequest(source, preview, 'profile-a'))
    const stored = (await current.store.read(child.id))!
    // The frozen provenance keeps the source Profile, and the default target inherits it.
    expect(stored.sideChat?.source).toEqual(source)
    expect(stored.sideChat?.initialTarget).toEqual({ providerId: 'pi', agentProfileId: PROFILE_A, permissionMode: 'default' })
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['pi question', 'answer: pi question'])
  })

  it('keeps the source Profile when the child starts on a different Profile', async () => {
    const { current, sessionId } = await recordedFixture('pi', PROFILE_A)
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, agentProfileId: PROFILE_A,
      cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(createRequest(source, preview, 'profile-target',
      { providerId: 'pi', agentProfileId: PROFILE_B, permissionMode: 'default' }))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.source).toEqual(source)
    expect(stored.sideChat?.initialTarget).toEqual({ providerId: 'pi', agentProfileId: PROFILE_B, permissionMode: 'default' })
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['pi question', 'answer: pi question'])
  })

  it('accepts a legacy archive whose turns recorded an explicit null Profile', async () => {
    const current = await sideChatFixture({ providerId: 'pi' })
    fixtures.push(current)
    const sessionId = 'pi-null-profile-session'
    // Pi runs now always carry a registered Profile, so an explicit null only exists in
    // archives written before that rule; the production writer is used to reproduce it.
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'pi',
      turn: { runId: 'null-run', userText: 'null question', done: true, status: 'completed',
        ts: Date.now(), agentProfileId: null, items: [modelEvent('null-run', 'null answer')] } })
    current.service = recordedService(current, [{ sessionId, externalSessionId: sessionId, providerId: 'pi',
      cwd: current.cwd, preview: '', ts: Date.now() }])
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(createRequest(source, preview, 'profile-null'))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.source).toEqual(source)
    expect(stored.sideChat?.initialTarget).toEqual({ providerId: 'pi', permissionMode: 'default' })
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['null question', 'null answer'])
  })

  it('keeps the archive authority for a Provider that has no native reader', async () => {
    const { current, sessionId } = await recordedFixture('codex')
    const source = { kind: 'native-session' as const, providerId: 'codex' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(createRequest(source, preview, 'profile-codex'))
    const stored = (await current.store.read(child.id))!
    expect(stored.sideChat?.source).toEqual(source)
    const refs = await sideChatSnapshotRefs(current.userData, stored)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['codex question', 'answer: codex question'])
  })

  it('accepts a legacy archive that records no Profile at all', async () => {
    const current = await sideChatFixture({ providerId: 'pi' })
    fixtures.push(current)
    const sessionId = 'pi-legacy-session'
    // The production writer, in its pre-Profile shape: the field is simply absent.
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'pi',
      turn: { runId: 'legacy-run', userText: 'legacy question', done: true, status: 'completed',
        ts: Date.now(), items: [modelEvent('legacy-run', 'legacy answer')] } })
    current.service = recordedService(current, [{ sessionId, externalSessionId: sessionId, providerId: 'pi',
      cwd: current.cwd, preview: '', ts: Date.now() }])
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, cwd: current.cwd, nativeSessionId: sessionId }
    const preview = await current.service.previewSideChat(source)
    const child = await current.service.createSideChat(createRequest(source, preview, 'profile-legacy'))
    const refs = await sideChatSnapshotRefs(current.userData, (await current.store.read(child.id))!)
    expect(await Promise.all(refs.map(ref => current.service.readItem(child.id, ref))))
      .toEqual(['legacy question', 'legacy answer'])
  })

  it('refuses an archive recorded under another Profile before publishing a child', async () => {
    const { current, sessionId } = await recordedFixture('pi', PROFILE_A)
    const source = { kind: 'native-session' as const, providerId: 'pi' as const, agentProfileId: PROFILE_A,
      cwd: current.cwd, nativeSessionId: sessionId }
    // Positive control in the same fixture: this archive is usable for its own Profile.
    const owned = await current.service.previewSideChat(source)
    expect(owned.throughOrdinal).toBe(1)
    // The catalog now reports the same session under another Profile, so the identity
    // check passes and only the archive's own recorded Profile can refuse the source.
    current.service = recordedService(current, [{ sessionId, externalSessionId: sessionId, providerId: 'pi',
      agentProfileId: PROFILE_B, cwd: current.cwd, preview: '', ts: Date.now() }])
    const foreign = { ...source, agentProfileId: PROFILE_B }
    const historyRoot = join(current.userData, 'conversation-history-v1')
    const before = await readdir(historyRoot).catch(() => [] as string[])
    await expect(current.service.previewSideChat(foreign))
      .rejects.toThrow('来源归档属于其它 Agent Profile，不能作为侧聊来源')
    // A real creation request for the foreign source, carrying the fingerprints the
    // legitimate preview produced: the capture gate must refuse it before the
    // fingerprint comparison can, and nothing may be published or sealed.
    await expect(current.service.createSideChat(createRequest(foreign, owned, 'profile-foreign-create')))
      .rejects.toThrow('来源归档属于其它 Agent Profile，不能作为侧聊来源')
    const children = (await current.store.list(current.cwd)).filter(conversation => conversation.sideChat)
    expect(children).toEqual([])
    // No sealed partial and no child content root survive either refusal.
    expect(await readdir(historyRoot).catch(() => [] as string[])).toEqual(before)
  })
})
