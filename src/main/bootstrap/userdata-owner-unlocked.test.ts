import { afterEach, describe, expect, it, vi } from 'vitest'

// The App could not take the lock itself (unwritable userData, no readable identity of
// its own: as root the first cannot be staged with chmod, so the lock module is mocked).
// With no owner recorded it must still start; with one it cannot evaluate, it must not.

const lock = vi.hoisted(() => ({ record: undefined as unknown, readFails: false }))
vi.mock('../../daemon/userdata-lock', () => ({
  acquireUserDataLock: vi.fn(async () => { throw new Error('daemon_lock_identity_unavailable') }),
  readUserDataLockRecord: vi.fn(() => {
    if (lock.readFails) throw new Error('EACCES')
    return lock.record
  })
}))

const { claimAppUserData } = await import('./userdata-owner')

describe('switch-off App without a lock of its own', () => {
  afterEach(() => { lock.record = undefined; lock.readFails = false })
  const ask = vi.fn(async () => 'quit' as const)

  it('starts when nobody else is recorded as the owner', async () => {
    await expect(claimAppUserData({ userDataDir: '/u', ask })).resolves.toEqual({ status: 'unlocked', asked: false })
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not start next to an owner it cannot evaluate', async () => {
    lock.record = { pid: 4242, role: 'daemon', startedAt: 'x' }
    await expect(claimAppUserData({ userDataDir: '/u', ask })).resolves.toMatchObject({ status: 'quit', reason: 'lock-error' })
    lock.record = undefined
    lock.readFails = true
    await expect(claimAppUserData({ userDataDir: '/u', ask })).resolves.toMatchObject({ status: 'quit', reason: 'lock-error' })
  })
})
