import { describe, expect, it, vi } from 'vitest'
import { ContextAdmission } from '../context-admission'
import { createSessionLifecycle } from './session-lifecycle'

const cwd = '/workspace'
const unexpected = (): never => { throw new Error('unexpected dependency') }

function lifecycle(overrides: Record<string, unknown> = {}) {
  const recorded = vi.fn(async () => ({ status: 'recorded' as const }))
  const rename = vi.fn(() => true)
  const setPinned = vi.fn(() => true)
  const setArchived = vi.fn(() => true)
  const instance = createSessionLifecycle({
    publishDataUpdated: () => undefined,
    publishDeleteProgress: () => undefined,
    getRuns: () => ({ unsettledStates: () => [], activeStates: () => [] }) as never,
    appSessionStore: () => ({ rename, setPinned, setArchived, load: () => [] }) as never,
    conversationStore: () => ({ assertLegacyWriteAllowed: async () => undefined }) as never,
    contextAdmission: new ContextAdmission(),
    getStartupManagedRecovery: async () => undefined,
    providerContextKey: (...identity: unknown[]) => JSON.stringify(['context', ...identity]),
    providerSessionKey: (...identity: unknown[]) => JSON.stringify(['session', ...identity]),
    deletingSessions: new Set(),
    sessionDiffBaselines: { discard: unexpected } as never,
    sessionBaselineKey: unexpected,
    recordingBlockedSessions: new Set(),
    appUserDataDir: '/unused-by-these-cases',
    requestRunStop: unexpected,
    prepareConversationDeletion: unexpected,
    sideChatCascade: { count: unexpected, run: unexpected } as never,
    assertLegacyConversationWriteAllowed: async () => undefined,
    sessionByContext: new Map(),
    adoptingSessionKeys: new Set(),
    dockBadge: { remove: () => undefined } as never,
    recordSessionMetadata: recorded,
    ...overrides
  } as unknown as Parameters<typeof createSessionLifecycle>[0])
  return { instance, recorded, rename, setPinned, setArchived }
}

const request = { providerId: 'codex' as const, cwd, externalSessionId: 'native-1' }

// D4: the catalog write and the event must agree. The event is recorded only after the file write
// reported a change, and it carries the caller that asked for it.

describe('metadata changes record an event after the catalog write', () => {
  it('records a rename with the local caller as actor', async () => {
    const { instance, recorded, rename } = lifecycle()
    await instance.renameSession(request, 'new title')
    expect(rename).toHaveBeenCalled()
    expect(recorded).toHaveBeenCalledWith({
      externalSessionId: 'native-1', providerId: 'codex', agentProfileId: undefined, cwd,
      change: { kind: 'rename', title: 'new title' }, actor: 'user:local'
    })
  })

  it('records pin and archive with the requested values', async () => {
    const { instance, recorded } = lifecycle()
    await instance.setSessionPinned(request, true)
    await instance.setSessionArchived(request, true)
    const calls = recorded.mock.calls as unknown as Array<[{ change: unknown }]>
    expect(calls.map((call) => call[0].change)).toEqual([
      { kind: 'pin', pinned: true },
      { kind: 'archive', archived: true }
    ])
  })

  it('records nothing when the catalog write did not change anything', async () => {
    const { instance, recorded } = lifecycle({ appSessionStore: () => ({ rename: () => false, setPinned: () => false, setArchived: () => false, load: () => [] }) as never })
    expect(await instance.renameSession(request, 'ignored')).toBe(false)
    expect(recorded).not.toHaveBeenCalled()
  })
})
