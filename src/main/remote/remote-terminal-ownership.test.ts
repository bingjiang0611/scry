import { describe, it, expect } from 'vitest'
import { RemoteTerminalOwnership, RemoteTerminalOwnershipError, type TerminalOwner } from './remote-terminal-ownership'

const remote = (deviceId: string): TerminalOwner => ({ kind: 'remote', deviceId })
const local: TerminalOwner = { kind: 'local' }

const denied = (fn: () => void, code: string) => {
  expect(fn).toThrowError(RemoteTerminalOwnershipError)
  try { fn() } catch (error) { expect((error as RemoteTerminalOwnershipError).code).toBe(code) }
}

describe('RemoteTerminalOwnership', () => {
  it('authorizes a write only with the current generation token', () => {
    const own = new RemoteTerminalOwnership()
    const token = own.attach('t1', local)
    expect(() => own.authorizeWrite(token, local)).not.toThrow()
  })

  it('refuses a replayed write minted before a re-attach (no input replay)', () => {
    const own = new RemoteTerminalOwnership()
    const stale = own.attach('t1', local)
    own.attach('t1', local) // re-attach bumps the generation
    denied(() => own.authorizeWrite(stale, local), 'stale_writer')
  })

  it('transfers ownership on takeover and invalidates the prior owner token', () => {
    const own = new RemoteTerminalOwnership()
    const localToken = own.attach('t1', local)
    const phoneToken = own.attach('t1', remote('phone')) // remote takes over
    expect(own.ownerOf('t1')).toEqual(remote('phone'))
    denied(() => own.authorizeWrite(localToken, local), 'stale_writer')
    expect(() => own.authorizeWrite(phoneToken, remote('phone'))).not.toThrow()
  })

  it('refuses a write from a different owner even with a structurally valid token', () => {
    const own = new RemoteTerminalOwnership()
    own.attach('t1', remote('phoneA'))
    const forged = { id: 't1', generation: 1 }
    denied(() => own.authorizeWrite(forged, remote('phoneB')), 'not_owner')
  })

  it('cleans up only the disconnecting device, leaving local and other devices', () => {
    const own = new RemoteTerminalOwnership()
    own.attach('local-1', local)
    own.attach('phoneA-1', remote('phoneA'))
    own.attach('phoneA-2', remote('phoneA'))
    own.attach('phoneB-1', remote('phoneB'))
    const released = own.releaseOwnedBy(remote('phoneA')).sort()
    expect(released).toEqual(['phoneA-1', 'phoneA-2'])
    expect(own.ownedBy(local)).toEqual(['local-1'])
    expect(own.ownedBy(remote('phoneB'))).toEqual(['phoneB-1'])
    denied(() => own.authorizeWrite({ id: 'phoneA-1', generation: 1 }, remote('phoneA')), 'unknown_terminal')
  })

  it('refuses writes to unknown or released terminals and bad tokens', () => {
    const own = new RemoteTerminalOwnership()
    const token = own.attach('t1', local)
    own.release('t1')
    denied(() => own.authorizeWrite(token, local), 'unknown_terminal')
    denied(() => own.authorizeWrite({ id: 't1', generation: 1.5 }, local), 'invalid_writer_token')
    denied(() => own.attach('', local), 'invalid_terminal_id')
    denied(() => own.attach('t2', { kind: 'remote', deviceId: '' }), 'invalid_owner')
  })
})
