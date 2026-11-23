import { describe, expect, it } from 'vitest'
import {
  describeDelegationCapabilities,
  resolveDelegatedPermissionMode
} from './delegation-permission'

describe('P6-1 delegation permission ceiling (security §S1)', () => {
  it('enforces Claude and Qoder partial order without implicit downgrade', () => {
    for (const provider of ['claude', 'qoder'] as const) {
      // default parent: only default allowed
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'default', requestedMode: undefined, sessionFullAccessEnabled: false
      })).toEqual({ ok: true, mode: 'default', source: 'inherited' })
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'default', requestedMode: 'auto_accept_edits', sessionFullAccessEnabled: false
      })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied', allowedModes: ['default'] })
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'default', requestedMode: 'auto_review', sessionFullAccessEnabled: false
      })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied', allowedModes: ['default'] })

      // middle modes are mutually incomparable
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'auto_review', requestedMode: 'auto_accept_edits', sessionFullAccessEnabled: false
      })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied', allowedModes: ['default', 'auto_review'] })
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'auto_accept_edits', requestedMode: 'auto_review', sessionFullAccessEnabled: false
      })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied', allowedModes: ['default', 'auto_accept_edits'] })

      // narrowing to default succeeds
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'auto_review', requestedMode: 'default', sessionFullAccessEnabled: false
      })).toEqual({ ok: true, mode: 'default', source: 'requested' })
      expect(resolveDelegatedPermissionMode({
        provider, parentMode: 'auto_accept_edits', requestedMode: 'default', sessionFullAccessEnabled: false
      })).toEqual({ ok: true, mode: 'default', source: 'requested' })
    }
  })

  it('enforces Codex total order and rejects unsupported auto_accept_edits', () => {
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'default', requestedMode: 'auto_review', sessionFullAccessEnabled: false
    })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied', allowedModes: ['default'] })
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'auto_review', requestedMode: 'default', sessionFullAccessEnabled: false
    })).toEqual({ ok: true, mode: 'default', source: 'requested' })
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'full_access', requestedMode: 'auto_accept_edits', sessionFullAccessEnabled: true
    })).toMatchObject({ ok: false, code: 'permission_mode_escalation_denied' })
  })

  it('blocks full_access child unless sessionFullAccessEnabled is true, even for full_access parent', () => {
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'full_access', requestedMode: undefined, sessionFullAccessEnabled: false
    })).toMatchObject({ ok: false, code: 'full_access_not_enabled', allowedModes: ['default', 'auto_review'] })
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'full_access', requestedMode: 'full_access', sessionFullAccessEnabled: false
    })).toMatchObject({ ok: false, code: 'full_access_not_enabled' })
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'full_access', requestedMode: 'auto_review', sessionFullAccessEnabled: false
    })).toEqual({ ok: true, mode: 'auto_review', source: 'requested' })
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', parentMode: 'full_access', requestedMode: undefined, sessionFullAccessEnabled: true
    })).toEqual({ ok: true, mode: 'full_access', source: 'inherited' })
  })

  it('rejects cross-provider delegation targets', () => {
    expect(resolveDelegatedPermissionMode({
      provider: 'codex', targetProvider: 'qoder', parentMode: 'default', requestedMode: 'default', sessionFullAccessEnabled: false
    })).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(resolveDelegatedPermissionMode({
      provider: 'opencode', parentMode: 'default', requestedMode: 'default', sessionFullAccessEnabled: false
    })).toMatchObject({ ok: false, code: 'provider_unavailable' })
  })

  it('reports available and unavailable modes with reasons for scry_capabilities', () => {
    const cap = describeDelegationCapabilities({
      provider: 'claude',
      parentMode: 'full_access',
      sessionFullAccessEnabled: false
    })
    expect(cap.availableModes).toEqual(['default', 'auto_accept_edits', 'auto_review'])
    expect(cap.unavailableModes).toContainEqual({ mode: 'full_access', reason: 'full_access_not_enabled' })
  })
})
