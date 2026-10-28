import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { registerSessionDeletionIpc } from './session-deletion-ipc'
import { ContextAdmission } from './context-admission'
import { sessionDeletionCopy } from '../shared/constants/session-deletion-copy'

type Dependencies = Parameters<typeof registerSessionDeletionIpc>[0]
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: never[]) => unknown>()
  const load = vi.fn<ReturnType<Dependencies['appSessionStore']>['load']>(() => [])
  const appSessionStore = vi.fn<Dependencies['appSessionStore']>(() => ({ load, remove: vi.fn() }))
  const read = vi.fn<ReturnType<Dependencies['conversationStore']>['read']>(async () => null)
  const prepareConversationDeletion = vi.fn<Dependencies['prepareConversationDeletion']>()
  const assertLegacyConversationWriteAllowed = vi.fn<Dependencies['assertLegacyConversationWriteAllowed']>(async () => {})
  const deletingSessions = new Set<string>(), sendDataUpdated = vi.fn()
  const showMessageBox = vi.fn(async () => ({ response: 0, checkboxChecked: false }))
  let recovery = Promise.resolve(), active: ReturnType<Dependencies['unsettledRuns']> = []
  const providerKey: Dependencies['providerContextKey'] = (provider, cwd, profile) => JSON.stringify([provider, cwd, profile])
  const sessionKey: Dependencies['providerSessionKey'] = (provider, cwd, session, profile) => JSON.stringify([provider, cwd, session, profile])
  const shared = registerSessionDeletionIpc({
    handleTrusted: (channel, handler) => { expect(handlers.has(channel)).toBe(false); handlers.set(channel, handler) },
    appSessionStore, dialog: { showMessageBox }, window: () => null, isOwnedTestApp: false,
    providerContextKey: providerKey, providerSessionKey: sessionKey, conversationStore: () => ({ read }),
    prepareConversationDeletion, assertLegacyConversationWriteAllowed, unsettledRuns: () => active,
    contextAdmission: new ContextAdmission(), startupManagedRecovery: () => recovery, deletingSessions,
    userDataDir: () => '/unused/deletion-fixture', sessionByContext: new Map(),
    sessionDiffBaselines: { discard: vi.fn() }, sessionBaselineKey: (context, session) => JSON.stringify([context, session]),
    recordingBlockedSessions: new Map(), dockBadge: { remove: vi.fn() }, rendererCanReceive: () => false, sendDataUpdated
  })
  // No physical cleanup is allowed in these admission tests. Production App
  // ownership tests and the real store suites cover cleanup after admission.
  return { ...shared, handlers, load, appSessionStore, read, prepareConversationDeletion,
    assertLegacyConversationWriteAllowed, deletingSessions, showMessageBox, sendDataUpdated,
    setRecovery: (next: Promise<void>) => { recovery = next },
    setActive: (next: typeof active) => { active = next } }
}
const request = { providerId: 'codex' as const, cwd: '/authorized/workspace', externalSessionId: 'native-session' }
const options = { confirm: false, notifyFailure: false }

describe('session deletion IPC extraction admission', () => {
  it('registers both handlers without reading stores or requesting confirmation', () => {
    const f = fixture()
    expect([...f.handlers.keys()]).toEqual(['agent:deleteSession', 'agent:deleteArchivedSessions'])
    expect(f.appSessionStore).not.toHaveBeenCalled()
    expect(f.assertLegacyConversationWriteAllowed).not.toHaveBeenCalled()
    expect(f.showMessageBox).not.toHaveBeenCalled()
  })

  it('waits for current recovery and fails closed on the canonical owner fence', async () => {
    const f = fixture()
    let release!: () => void
    f.setRecovery(new Promise<void>(done => { release = done }))
    f.assertLegacyConversationWriteAllowed.mockRejectedValue(new Error('synthetic owner fence'))
    const pending = f.deleteOneSession(request, options)
    await Promise.resolve()
    expect(f.assertLegacyConversationWriteAllowed).not.toHaveBeenCalled()
    expect(f.appSessionStore).not.toHaveBeenCalled()
    release()
    await expect(pending).rejects.toThrow('synthetic owner fence')
    expect(f.deletingSessions.size).toBe(0)
    expect(f.showMessageBox).not.toHaveBeenCalled()
    expect(f.appSessionStore).not.toHaveBeenCalled()
  })

  it('uses live unsettled runs and rejects an already reserved deletion without cleanup', async () => {
    const f = fixture()
    f.setActive([{ runId: 'active-run', providerId: request.providerId, cwd: request.cwd, externalSessionId: request.externalSessionId }])
    await expect(f.deleteOneSession(request, options)).resolves.toMatchObject({ ok: false, reason: 'active_session' })
    expect(f.deletingSessions.size).toBe(0)
    f.setActive([])
    f.deletingSessions.add(JSON.stringify([request.providerId, request.cwd, request.externalSessionId, undefined]))
    await expect(f.deleteOneSession(request, options)).resolves.toMatchObject({ ok: false, reason: 'active_session' })
    expect(f.appSessionStore).not.toHaveBeenCalled()
    expect(f.showMessageBox).not.toHaveBeenCalled()
  })

  it('releases a cancelled deletion fence and preserves independent retained-evidence receipts', async () => {
    const f = fixture()
    const first = await f.deleteOneSession(request, { ...options, confirm: true })
    expect(first).toMatchObject({ ok: false, cancelled: true, reason: 'user_cancelled', retained: [...sessionDeletionCopy.retained] })
    expect(f.deletingSessions.size).toBe(0)
    first.retained.push('synthetic caller mutation')
    const second = await f.deleteOneSession(request, { ...options, confirm: true })
    expect(second.retained).toEqual(sessionDeletionCopy.retained)
    expect(f.showMessageBox).toHaveBeenCalledTimes(2)
    expect(f.appSessionStore).not.toHaveBeenCalled()
    expect(f.sendDataUpdated).not.toHaveBeenCalled()
  })

  it('requires a persisted canonical deletion owner before planning physical cleanup', async () => {
    const f = fixture()
    await expect(f.deleteOneSession(request, { ...options, conversationId: 'missing-owner' })).rejects.toThrow(sessionDeletionCopy.missingAuthorization)
    expect(f.read).toHaveBeenCalledExactlyOnceWith('missing-owner')
    expect(f.prepareConversationDeletion).not.toHaveBeenCalled()
    expect(f.appSessionStore).not.toHaveBeenCalled()
    expect(f.deletingSessions.size).toBe(0)
  })
})
