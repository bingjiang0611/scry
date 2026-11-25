import { describe, expect, it, vi } from 'vitest'
import { runSessionAction, type SessionActionDeps } from './host-controller-session'

function depsWith(sessionAction: NonNullable<SessionActionDeps['sessionAction']>): SessionActionDeps {
  return {
    authorizeDevice: () => undefined,
    workspace: { authorize: (cwd: string) => cwd },
    sessionAction,
    sessionFork: undefined,
    sessionDelete: undefined,
    gateway: { grantScope: () => 'remote' }
  }
}

const input = (action: unknown) => ({
  context: { cwd: '/workspace', providerId: 'codex', externalSessionId: 'sess-1' },
  action
})

// D4: the recorded change has to name the device that asked for it, not a generic host actor,
// so a rename made from the phone is attributable in the event log.

describe('runSessionAction names the caller', () => {
  it('passes the device peer as the actor for rename, pin and archive', async () => {
    const seen: Array<string | undefined> = []
    const deps = depsWith(async (_context, _action, authorize, actor) => {
      authorize()
      seen.push(actor)
      return true
    })
    await runSessionAction(deps, 'a'.repeat(64), input({ kind: 'rename', title: 'new' }))
    await runSessionAction(deps, 'a'.repeat(64), input({ kind: 'pin', pinned: true }))
    await runSessionAction(deps, 'a'.repeat(64), input({ kind: 'archive', archived: true }))
    expect(seen).toEqual([`peer:${'a'.repeat(64)}`, `peer:${'a'.repeat(64)}`, `peer:${'a'.repeat(64)}`])
  })

  it('authorizes on entry, inside the change and once more before returning', async () => {
    const authorizeDevice = vi.fn()
    const deps = { ...depsWith(async (_context, _action, authorize) => { authorize(); return true }), authorizeDevice }
    await runSessionAction(deps, 'b'.repeat(64), input({ kind: 'rename', title: 'x' }))
    expect(authorizeDevice).toHaveBeenCalledTimes(3)
  })
})
