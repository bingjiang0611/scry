import { describe, expect, it } from 'vitest'
import type { RemoteSessionRef } from '@shared/desktop-remote'
import { reconcileRemoteSessionAttention as reconcile, remoteSessionAttentionKey as key } from '@shared/remote-session-attention'

const active: RemoteSessionRef = { sessionId: 's', externalSessionId: 'native', cwd: '/project', providerId: 'pi', label: 'Session', ts: 1, isActive: true }
const completed: RemoteSessionRef = { ...active, isActive: false, lastRunId: 'run-1', lastRunOutcome: 'completed' }
const empty = new Set<string>()

describe('remote session unread lifecycle', () => {
  it('baselines historical results, then detects completion even after a missed/disconnected run', () => {
    expect(reconcile('mac2', undefined, [completed], empty, null).size).toBe(0)
    expect(reconcile('mac2', [active], [completed], empty, null)).toEqual(new Set([key('mac2', completed)]))
    const next = { ...completed, lastRunId: 'run-2' }
    expect(reconcile('mac2', [completed], [next], empty, null)).toEqual(new Set([key('mac2', next)]))
  })
  it('clears a focused viewed result, does not re-mark on repeated refresh, and marks later results', () => {
    const unread = reconcile('mac2', [active], [completed], empty, null)
    expect(reconcile('mac2', [completed], [completed], unread, key('mac2', completed)).size).toBe(0)
    expect(reconcile('mac2', [completed], [completed], empty, null).size).toBe(0)
    expect(reconcile('mac2', [active], [completed], empty, key('mac2', completed)).size).toBe(0)
    expect(reconcile('mac2', [completed], [{ ...completed, lastRunId: 'run-2' }], empty, null).size).toBe(1)
  })
  it('matches local completed/failed attention, without inventing success for missing or interrupted evidence', () => {
    for (const lastRunOutcome of ['completed', 'failed'] as const) {
      expect(reconcile('mac2', [active], [{ ...completed, lastRunOutcome }], empty, null).size).toBe(1)
    }
    for (const lastRunOutcome of [undefined, 'cancelled', 'interrupted'] as const) {
      expect(reconcile('mac2', [active], [{ ...completed, lastRunOutcome }], empty, null).size).toBe(0)
    }
  })
  it('isolates host/profile/provider identities and prunes archived or removed sessions', () => {
    expect(new Set([key('mac2', active), key('mac3', active), key('mac2', { ...active, agentProfileId: 'work' }), key('mac2', { ...active, providerId: 'codex' })]).size).toBe(4)
    const unread = new Set([key('mac2', active)])
    expect(reconcile('mac2', [completed], [{ ...completed, archivedAt: 1 }], unread, null).size).toBe(0)
    expect(reconcile('mac2', [completed], [], unread, null).size).toBe(0)
  })
})
