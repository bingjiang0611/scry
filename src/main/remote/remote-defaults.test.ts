import { describe, expect, it } from 'vitest'
import { DEFAULT_PUBLIC_RELAY_WS, inProcessRemoteHostEnabled, remoteHostEnabled } from './remote-defaults'

describe('remote defaults', () => {
  it('uses a credential-free root WSS origin for the official relay', () => {
    const endpoint = new URL(DEFAULT_PUBLIC_RELAY_WS)
    expect(endpoint.protocol).toBe('wss:')
    expect(endpoint.pathname).toBe('/')
    expect(endpoint.username).toBe('')
    expect(endpoint.password).toBe('')
    expect(endpoint.search).toBe('')
    expect(endpoint.hash).toBe('')
  })

  it('enables packaged builds by default while preserving explicit overrides', () => {
    expect(remoteHostEnabled(undefined, true)).toBe(true)
    expect(remoteHostEnabled(undefined, false)).toBe(false)
    expect(remoteHostEnabled('1', false)).toBe(true)
    expect(remoteHostEnabled('0', true)).toBe(false)
    expect(remoteHostEnabled('unexpected', true)).toBe(false)
  })

  // With the switch on the daemon serves paired devices from the same userData. A second
  // host in the App would contend for the same pairing, ledger and output leases.
  it('never starts the in-process host while the daemon owns runs', () => {
    expect(inProcessRemoteHostEnabled({ SCRY_HOST_DAEMON: '1' }, true)).toBe(false)
    expect(inProcessRemoteHostEnabled({ SCRY_HOST_DAEMON: '1', SCRY_REMOTE_HOST: '1' }, false)).toBe(false)
    expect(inProcessRemoteHostEnabled({}, true)).toBe(true)
    expect(inProcessRemoteHostEnabled({ SCRY_REMOTE_HOST: '1' }, false)).toBe(true)
    expect(inProcessRemoteHostEnabled({ SCRY_REMOTE_HOST: '0' }, true)).toBe(false)
  })
})
