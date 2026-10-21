import { describe, expect, it, vi } from 'vitest'
import { bindRemoteHistoryContext } from './history-context'

const query = { providerId: 'pi', cwd: '/project', externalSessionId: 'session', historyScope: 'session' as const, agentProfileId: 'A' }
const session = { providerId: 'pi' as const, cwd: '/project', externalSessionId: 'session', sessionId: 'local', agentProfileId: 'A' }
const authorize = (cwd: string) => {
  if (cwd === '/project' || cwd === '/alias') return '/project'
  throw new Error('workspace_not_authorized')
}

describe('remote display session binding', () => {
  it('normalizes the same catalog identity published to the phone and coalesces cwd authorization', () => {
    const resolve = vi.fn(authorize)
    expect(bindRemoteHistoryContext(query, [{ ...session, cwd: '/alias' }, { ...session, cwd: '/alias' }], resolve))
      .toEqual({ canonical: '/project', scope: 'session', profile: 'A' })
    expect(resolve.mock.calls).toEqual([['/project'], ['/alias']])
  })
  it('selects the actual catalog Profile when distinct Profiles share a native id', () => {
    expect(bindRemoteHistoryContext({ ...query, agentProfileId: 'B' }, [session, { ...session, agentProfileId: 'B' }], authorize).profile).toBe('B')
    expect(() => bindRemoteHistoryContext({ ...query, agentProfileId: 'C' }, [session], authorize)).toThrow('history_session_profile_mismatch')
  })
  it('rejects invented provider, workspace and session identities', () => {
    for (const changed of [{ providerId: 'claude' }, { externalSessionId: 'other' }]) {
      expect(() => bindRemoteHistoryContext({ ...query, ...changed }, [session], authorize)).toThrow('history_session_not_found')
    }
    expect(() => bindRemoteHistoryContext({ ...query, cwd: '/outside' }, [session], authorize)).toThrow('workspace_not_authorized')
  })
  it('does not treat missing catalog provenance as authority for a different live Profile', () => {
    const legacy = { ...session, agentProfileId: undefined }
    expect(bindRemoteHistoryContext({ ...query, agentProfileId: null }, [legacy], authorize).profile).toBeNull()
    expect(() => bindRemoteHistoryContext({ ...query, historyScope: 'profile' }, [legacy], authorize)).toThrow('history_profile_unavailable')
    expect(legacy.agentProfileId).toBeUndefined()
  })
  it('matches legacy provider and native-id normalization used by the session catalog', () => {
    const legacy = { ...session, providerId: undefined, externalSessionId: undefined, sessionId: 'session' }
    expect(bindRemoteHistoryContext({ ...query, providerId: 'legacy_unknown' }, [legacy], authorize).canonical).toBe('/project')
  })
})
