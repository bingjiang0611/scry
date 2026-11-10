import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextAdmission } from '../context-admission'
import type { AppSession } from '../app-store'
import type { SideChatCascade } from './conversation-delete'

const showMessageBox = vi.hoisted(() => vi.fn(async () => ({ response: 0 })))
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

const { registerSessionDeletionHandlers } = await import('./session-deletion')

const cwd = '/workspace'
const row: AppSession = { sessionId: 'app-session', externalSessionId: 'native-session', providerId: 'claude', cwd,
  preview: 'main session', ts: 1, archivedAt: 1 } as AppSession

/**
 * The production `deleteOneSession` up to the point where it would start deleting the
 * session's own stores. Everything before that point is real; the stores behind it are
 * never reached in these cases, which is exactly what each case proves.
 */
function setup(cascade: Partial<SideChatCascade>) {
  const order: string[] = []
  const removed = vi.fn()
  const sideChatCascade: SideChatCascade = {
    count: vi.fn(async (scope) => { order.push(`count:${scope.nativeSessionIds.join(',')}`); return cascade.count ? cascade.count(scope) : 0 }),
    run: vi.fn(async (scope) => { order.push('run'); return cascade.run ? cascade.run(scope) : { deleted: [], retained: [], failed: [] } })
  }
  const unexpected = (): never => { throw new Error('unexpected dependency') }
  const { deleteOneSession } = registerSessionDeletionHandlers({
    handleTrusted: () => {},
    getRuns: () => ({ unsettledStates: () => [] }) as never,
    appSessionStore: () => ({ load: () => [row], remove: removed }) as never,
    conversationStore: unexpected,
    contextAdmission: new ContextAdmission(),
    getStartupManagedRecovery: async () => {},
    providerContextKey: (...identity: unknown[]) => JSON.stringify(['context', ...identity]),
    providerSessionKey: (...identity: unknown[]) => JSON.stringify(['session', ...identity]),
    deletingSessions: new Set(),
    sessionDiffBaselines: { discard: unexpected } as never,
    sessionBaselineKey: unexpected,
    recordingBlockedSessions: new Set(),
    getWindow: () => null,
    rendererCanReceive: () => false,
    appUserDataDir: '/unused-by-these-cases',
    isOwnedTestApp: true,
    requestRunStop: unexpected,
    prepareConversationDeletion: unexpected,
    sideChatCascade,
    assertLegacyConversationWriteAllowed: async () => {},
    sessionByContext: new Map(),
    adoptingSessionKeys: new Set(),
    dockBadge: { remove: unexpected }
  } as unknown as Parameters<typeof registerSessionDeletionHandlers>[0])
  const request = { providerId: 'claude' as const, cwd, externalSessionId: 'native-session' }
  return { deleteOneSession, sideChatCascade, order, removed, request, event: {} as IpcMainInvokeEvent }
}

beforeEach(() => { showMessageBox.mockClear() })

describe('a Provider session takes its side chats along when it is deleted', () => {
  it('keeps the session and deletes nothing while one of its side chats cannot be deleted', async () => {
    const { deleteOneSession, sideChatCascade, removed, order, request } = setup({
      count: async () => { throw new Error('侧边会话「查一下」不能随主会话删除：对话仍有运行或证据保存未收敛，不能删除') }
    })
    const result = await deleteOneSession(request, { confirm: false, notifyFailure: true })
    expect(result).toMatchObject({ ok: false, reason: 'partial_failure',
      failed: [{ store: 'side chats', error: expect.stringContaining('不能随主会话删除') }] })
    // Both aliases of the session are asked for, because a side chat may name either.
    expect(order).toEqual(['count:native-session,app-session,native-session'])
    expect(sideChatCascade.run).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
    // The refusal is said out loud instead of leaving a delete that silently did nothing.
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('keeps the session as the retry handle when a side chat could not be cleaned', async () => {
    const { deleteOneSession, removed, order, request } = setup({
      count: async () => 2,
      run: async () => ({ deleted: [], retained: [], failed: [{ store: 'side chat 1234abcd: database', error: 'SQLite unavailable' }] })
    })
    const result = await deleteOneSession(request, { confirm: false, notifyFailure: false })
    expect(result).toMatchObject({ ok: false, reason: 'partial_failure',
      failed: [{ store: 'side chat 1234abcd: database', error: 'SQLite unavailable' }] })
    expect(order.at(-1)).toBe('run')
    expect(removed).not.toHaveBeenCalled()
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('re-checks the caller authorization before any side chat is deleted', async () => {
    const { deleteOneSession, sideChatCascade, removed, request } = setup({ count: async () => 1 })
    const authorize = vi.fn(() => { throw new Error('远程删除只允许已存档会话') })
    await expect(deleteOneSession(request, { confirm: false, notifyFailure: false, authorize })).rejects.toThrow('远程删除只允许已存档会话')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(sideChatCascade.run).not.toHaveBeenCalled()
    expect(removed).not.toHaveBeenCalled()
  })

  it('does not look for side chats when a conversation deletes one of its own native targets', async () => {
    const { deleteOneSession, sideChatCascade, request } = setup({ count: async () => 3 })
    // That delete is authorized by its conversation, which owns its own children; with no
    // such owner in this case it is refused before any side-chat lookup.
    await expect(deleteOneSession(request, { confirm: false, notifyFailure: false, conversationId: 'owner' })).rejects.toThrow()
    expect(sideChatCascade.count).not.toHaveBeenCalled()
    expect(sideChatCascade.run).not.toHaveBeenCalled()
  })
})
