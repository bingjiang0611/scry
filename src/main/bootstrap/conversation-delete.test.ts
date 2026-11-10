import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, describe, expect, it } from 'vitest'
import { ContextAdmission } from '../context-admission'
import { deleteConversationHistory } from '../conversation-history'
import { modelEvent, sendTurn, sideChatFixture, type SideChatFixture } from '../conversation-side-chat.fixture'
import { upsertTraceArchiveTurn } from '../transcript-archive'
import type { ActiveRun } from '../../shared/trace'
import type { SideChatSource } from '../../shared/conversation'
import type { ConversationDeletionPreview } from '../../shared/conversation-api'
import type { ConversationDeletionResult } from '../../shared/conversation'
import { registerConversationDeletionHandlers } from './conversation-delete'

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

const fixtures: SideChatFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())) })

/**
 * The production deletion handlers over a real store, real frozen bodies and a real
 * admission. Only the per-session store cleanup and the run registry are stand-ins: the
 * first records which scopes were cleaned, the second says which runs are still live.
 */
async function setup() {
  const current = await sideChatFixture()
  fixtures.push(current)
  const handlers = new Map<string, Handler>()
  const cleaned: Array<{ conversationId: unknown; externalSessionId: unknown }> = []
  const live = new Set<string>()
  const failing = new Set<string>()
  const registered = registerConversationDeletionHandlers({
    handleTrusted: (channel, listener) => { handlers.set(channel, listener as Handler) },
    providerContextKey: (providerId, cwd, agentProfileId) => JSON.stringify([providerId, cwd, agentProfileId ?? null]),
    contextAdmission: new ContextAdmission(),
    getStartupManagedRecovery: async () => {},
    appSessionStore: () => ({ load: () => [] }) as never,
    conversationStore: () => current.store,
    getRuns: () => ({ unsettledStates: () => [...live].map(runId => ({ runId }) as ActiveRun) }),
    invalidateSessionHistoryLoad: () => {},
    getWindow: () => null,
    deleteOneSession: async (request, options) => {
      // The production path re-checks the persisted authorization of this exact owner.
      const owner = await current.store.read(String(options.conversationId))
      if (owner?.deletion?.status !== 'pending') throw new Error('没有已持久化的统一对话删除授权')
      if (failing.has(String(options.conversationId))) {
        return { ok: false, deleted: [], retained: [], failed: [{ store: 'database', error: 'SQLite unavailable' }] }
      }
      cleaned.push({ conversationId: options.conversationId, externalSessionId: request.externalSessionId })
      return { ok: true, deleted: ['catalog'], retained: [], failed: [] }
    },
    resolveSessionRunIds: () => ({ status: 'ready', runIds: [], conflicts: [] }),
    deleteConversationHistory,
    appUserDataDir: current.userData
  })
  const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    Promise.resolve(handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)) as Promise<T>
  const child = async (source: SideChatSource, commandId: string) => {
    const preview = await current.service.previewSideChat(source)
    return current.service.createSideChat({ source, expectedThroughOrdinal: preview.throughOrdinal,
      expectedThroughRunId: preview.throughRunId, expectedPrefixFingerprint: preview.prefixFingerprint,
      expectedManifestFingerprint: preview.manifestFingerprint, commandId })
  }
  /** A parent with one completed turn, archived the way the delete dialog requires. */
  const archivedParent = async () => {
    const parent = await current.service.create(current.cwd)
    await sendTurn(current, parent.id, `parent-${parent.id}`, 'parent question')
    return parent
  }
  const archive = async (id: string) => {
    await current.service.update(id, (await current.store.read(id))!.revision, { kind: 'archive', archived: true })
  }
  const status = async (id: string) => (await current.store.read(id))?.deletion?.status ?? null
  return { current, invoke, child, archivedParent, archive, status, cleaned, live, failing, ...registered }
}

describe('deleting a conversation takes its side chats along', () => {
  it('previews every side chat and deletes them with the parent, including one that never sent', async () => {
    const { current, invoke, child, archivedParent, archive, status, cleaned } = await setup()
    const parent = await archivedParent()
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const sent = await child(source, 'cascade-child-sent')
    await sendTurn(current, sent.id, 'cascade-child-turn', 'child question')
    const empty = await child(source, 'cascade-child-empty')
    // An unrelated conversation with its own side chat must not be touched.
    const other = await archivedParent()
    const foreign = await child({ kind: 'conversation', conversationId: other.id }, 'cascade-foreign')
    await archive(parent.id)

    const preview = await invoke<ConversationDeletionPreview>('conversation:previewDeletion', parent.id)
    expect(preview.sideChats?.map(item => item.conversationId).sort()).toEqual([sent.id, empty.id].sort())
    // Neither child was archived by the user; only the parent was.
    expect((await current.store.read(sent.id))!.archivedAt).toBeUndefined()

    const result = await invoke<ConversationDeletionResult>('conversation:delete', parent.id, preview.fingerprint)
    expect(result).toMatchObject({ ok: true, failed: [] })
    expect(await status(parent.id)).toBe('complete')
    expect(await status(sent.id)).toBe('complete')
    expect(await status(empty.id)).toBe('complete')
    // The child that ran had its own native session cleaned under its own authorization.
    expect(cleaned.some(entry => entry.conversationId === sent.id)).toBe(true)
    expect(cleaned.some(entry => entry.conversationId === parent.id)).toBe(true)
    expect(result.deleted.some(store => store.startsWith(`side chat ${sent.id.slice(0, 8)}: `))).toBe(true)
    // Nothing of them is listed or readable any more.
    expect((await current.service.listSideChats({ source })).total).toBe(0)
    await expect(current.service.readSideChatSnapshot(sent.id)).rejects.toThrow()
    expect(await status(other.id)).toBeNull()
    expect(await status(foreign.id)).toBeNull()
    expect((await current.service.listSideChats({ source: { kind: 'conversation', conversationId: other.id } })).total).toBe(1)
  })

  it('keeps the plan of a parent without side chats unchanged', async () => {
    const { invoke, archivedParent, archive, prepareConversationDeletion, current } = await setup()
    const parent = await archivedParent()
    await archive(parent.id)
    const preview = await invoke<ConversationDeletionPreview>('conversation:previewDeletion', parent.id)
    expect(preview.sideChats).toBeUndefined()
    expect(preview.fingerprint).toBe((await prepareConversationDeletion((await current.store.read(parent.id))!)).fingerprint)
  })

  it('refuses a delete whose confirmed scope no longer covers every side chat', async () => {
    const { invoke, child, archivedParent, archive, status } = await setup()
    const parent = await archivedParent()
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const first = await child(source, 'cascade-before-preview')
    await archive(parent.id)
    const preview = await invoke<ConversationDeletionPreview>('conversation:previewDeletion', parent.id)
    // A side chat that appeared after the preview was never shown to the user.
    const late = await child(source, 'cascade-after-preview')
    await expect(invoke('conversation:delete', parent.id, preview.fingerprint)).rejects.toThrow('删除范围已变化')
    expect(await status(parent.id)).toBeNull()
    expect(await status(first.id)).toBeNull()
    expect(await status(late.id)).toBeNull()
  })

  it('refuses the whole delete while a side chat is still running, and names it', async () => {
    const { current, invoke, child, archivedParent, archive, status, live } = await setup()
    const parent = await archivedParent()
    const running = await child({ kind: 'conversation', conversationId: parent.id }, 'cascade-running')
    await sendTurn(current, running.id, 'cascade-running-turn', 'child question')
    await archive(parent.id)
    live.add((await current.store.read(running.id))!.turns[0].runId)
    await expect(invoke('conversation:previewDeletion', parent.id)).rejects.toThrow(/侧边会话「.+」不能随主会话删除/)
    expect(await status(parent.id)).toBeNull()
    expect(await status(running.id)).toBeNull()
  })

  it('leaves the parent pending for another preview when a side chat could not be cleaned', async () => {
    const { current, invoke, child, archivedParent, archive, status, failing } = await setup()
    const parent = await archivedParent()
    const source = { kind: 'conversation' as const, conversationId: parent.id }
    const stuck = await child(source, 'cascade-stuck')
    await sendTurn(current, stuck.id, 'cascade-stuck-turn', 'child question')
    await archive(parent.id)
    failing.add(stuck.id)
    const preview = await invoke<ConversationDeletionPreview>('conversation:previewDeletion', parent.id)
    const result = await invoke<ConversationDeletionResult>('conversation:delete', parent.id, preview.fingerprint)
    expect(result.ok).toBe(false)
    expect(result.failed.some(failure => failure.store.startsWith(`side chat ${stuck.id.slice(0, 8)}`))).toBe(true)
    // Both keep a retry handle: nothing claims a deletion that did not complete.
    expect(await status(parent.id)).toBe('pending')
    expect(await status(stuck.id)).toBe('pending')
    // The next preview plans what is left, and the retry completes both.
    failing.clear()
    const again = await invoke<ConversationDeletionPreview>('conversation:previewDeletion', parent.id)
    expect(again.sideChats?.map(item => item.conversationId)).toEqual([stuck.id])
    expect((await invoke<ConversationDeletionResult>('conversation:delete', parent.id, again.fingerprint)).ok).toBe(true)
    expect(await status(parent.id)).toBe('complete')
    expect(await status(stuck.id)).toBe('complete')
  })
})

describe('deleting a Provider session takes its side chats along', () => {
  const nativeParent = (current: SideChatFixture, sessionId: string): SideChatSource => {
    upsertTraceArchiveTurn({ userDataDir: current.userData, cwd: current.cwd, sessionId, providerId: 'codex',
      turn: { runId: `${sessionId}-run`, userText: 'native question', items: [modelEvent(`${sessionId}-run`, 'native answer')],
        done: true, status: 'completed', ts: Date.now() } })
    return { kind: 'native-session', providerId: 'codex', cwd: current.cwd, nativeSessionId: sessionId }
  }

  it('counts and deletes only the side chats of that exact session, by either alias', async () => {
    const { current, child, status, sideChatCascade } = await setup()
    const mine = await child(nativeParent(current, 'native-mine'), 'native-cascade-mine')
    const theirs = await child(nativeParent(current, 'native-theirs'), 'native-cascade-theirs')
    const scope = { providerId: 'codex' as const, cwd: current.cwd, nativeSessionIds: ['app-alias', 'native-mine'] }
    expect(await sideChatCascade.count(scope)).toBe(1)
    // Another profile, workspace or session is another source.
    expect(await sideChatCascade.count({ ...scope, agentProfileId: 'work' })).toBe(0)
    expect(await sideChatCascade.count({ ...scope, cwd: current.root })).toBe(0)
    expect(await status(mine.id)).toBeNull()

    const result = await sideChatCascade.run(scope)
    expect(result.failed).toEqual([])
    expect(await status(mine.id)).toBe('complete')
    expect(await status(theirs.id)).toBeNull()
    expect(await sideChatCascade.count(scope)).toBe(0)
  })

  it('refuses before anything is deleted while one of them is running', async () => {
    const { current, child, status, live, sideChatCascade } = await setup()
    const source = nativeParent(current, 'native-busy')
    const idle = await child(source, 'native-cascade-idle')
    const busy = await child(source, 'native-cascade-busy')
    await sendTurn(current, busy.id, 'native-cascade-busy-turn', 'child question')
    live.add((await current.store.read(busy.id))!.turns[0].runId)
    const scope = { providerId: 'codex' as const, cwd: current.cwd, nativeSessionIds: ['native-busy'] }
    await expect(sideChatCascade.count(scope)).rejects.toThrow('不能随主会话删除')
    await expect(sideChatCascade.run(scope)).rejects.toThrow('不能随主会话删除')
    expect(await status(idle.id)).toBeNull()
    expect(await status(busy.id)).toBeNull()
  })
})
