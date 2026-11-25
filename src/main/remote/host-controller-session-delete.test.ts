import { describe, expect, it, vi } from 'vitest'
import { runSessionDelete, type SessionActionDeps } from './host-controller-session'

// A device revoked while its remote delete is in progress must not be able to finish
// the destructive phase: the authorize callback handed to sessionDelete re-checks the
// device grant, and the controller re-checks again before returning a result.
function depsWith(sessionDelete: SessionActionDeps['sessionDelete']) {
  let revoked = false
  const authorizeDevice = vi.fn((peer: string) => {
    if (revoked) throw new Error(`device_not_authorized:${peer}`)
  })
  const deps: SessionActionDeps = {
    authorizeDevice,
    workspace: { authorize: (cwd: string) => cwd },
    sessionAction: undefined,
    sessionFork: undefined,
    sessionDelete,
    gateway: { grantScope: () => 'remote' }
  }
  return { deps, revoke: () => { revoked = true } }
}

const request = { confirmed: true, providerId: 'codex', cwd: '/workspace', externalSessionId: 'sess-1' }

describe('runSessionDelete re-checks the device grant during the delete', () => {
  it('refuses the destructive phase when the device is revoked mid-delete', async () => {
    const destroyed = vi.fn()
    let revokeNow!: () => void
    const handle = depsWith(async (_request, authorize) => {
      revokeNow()
      authorize()
      destroyed()
      return { ok: true } as never
    })
    revokeNow = handle.revoke
    await expect(runSessionDelete(handle.deps, 'peer-a', request)).rejects.toThrow('device_not_authorized:peer-a')
    expect(destroyed).not.toHaveBeenCalled()
  })

  it('does not report success when the device is revoked after the delete returns', async () => {
    let revokeNow!: () => void
    const handle = depsWith(async () => {
      revokeNow()
      return { ok: true } as never
    })
    revokeNow = handle.revoke
    await expect(runSessionDelete(handle.deps, 'peer-a', request)).rejects.toThrow('device_not_authorized:peer-a')
  })

  it('passes the remote grant scope so only archived sessions may be deleted', async () => {
    const sessionDelete = vi.fn(async () => ({ ok: true }) as never)
    const handle = depsWith(sessionDelete)
    await runSessionDelete(handle.deps, 'peer-a', request)
    expect(sessionDelete).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/workspace', externalSessionId: 'sess-1', confirmed: true }),
      expect.any(Function),
      'remote',
      'peer:peer-a'
    )
  })
})
